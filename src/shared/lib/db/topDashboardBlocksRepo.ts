import type { PoolClient } from 'pg';

import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';
import {
  activateTopDashboardVersion,
  createTopDashboardVersion,
  deleteTopDashboardVersion,
  getTopDashboardOverview,
  getTopDashboardVersionContent,
  TopDashboardActiveVersionDeleteError,
  TopDashboardStateConflictError,
  TopDashboardVersionNotFoundError,
  type ActivateTopDashboardVersionResult,
  type CreateTopDashboardVersionInput,
  type DeleteTopDashboardVersionResult,
  type TopDashboardOverview,
  type TopDashboardVersion,
  type TopDashboardVersionContent,
  type TopDashboardVersionStatus,
} from './topDashboardRepo';

export type TopDashboardBlockStorageKind = 'legacy' | 'native';

export type TopDashboardBlock = {
  id: number;
  title: string;
  storageKind: TopDashboardBlockStorageKind;
  createdAt: string;
};

export type TopDashboardBlockSummary = TopDashboardBlock & {
  activeVersionId: number | null;
  activeOriginalName: string | null;
  versionCount: number;
  updatedAt: string;
};

export type TopDashboardBlockOverview = TopDashboardOverview & {
  block: TopDashboardBlock;
};

export type CreateTopDashboardBlockVersionInput = CreateTopDashboardVersionInput & {
  blockId: number;
};

export type ActivateTopDashboardBlockVersionInput = {
  blockId: number;
  versionId: number;
  expectedActiveVersionId: number | null;
  adminUserId: number | null;
};

export type DeleteTopDashboardBlockVersionResult = DeleteTopDashboardVersionResult & {
  blockId: number;
};

const TOP_DASHBOARD_VERSION_LIMIT = 50;
const TOP_DASHBOARD_STORAGE_LIMIT_BYTES = 100 * 1024 * 1024;
const TOP_DASHBOARD_BLOCK_TITLE_MAX_LENGTH = 120;

type Queryable = Pick<PoolClient, 'query'>;

type TopDashboardBlockRow = {
  id: string;
  title: string;
  storage_kind: TopDashboardBlockStorageKind;
  created_at: string;
};

type TopDashboardBlockSummaryRow = TopDashboardBlockRow & {
  active_version_id: string | null;
  active_original_name: string | null;
  version_count: string;
  updated_at: string;
};

type TopDashboardStateRow = {
  active_version_id: string | null;
  previous_version_id: string | null;
  updated_at: string;
};

type TopDashboardVersionRow = {
  id: string;
  original_name: string;
  file_size: string;
  sha256: string;
  uploaded_by_name: string | null;
  first_published_by_name: string | null;
  first_published_at: string | null;
  created_at: string;
};

function numericId(value: string | null | undefined) {
  return value ? Number(value) : null;
}

function mapBlock(row: TopDashboardBlockRow): TopDashboardBlock {
  return {
    id: Number(row.id),
    title: row.title,
    storageKind: row.storage_kind,
    createdAt: row.created_at,
  };
}

function mapBlockSummary(row: TopDashboardBlockSummaryRow): TopDashboardBlockSummary {
  return {
    ...mapBlock(row),
    activeVersionId: numericId(row.active_version_id),
    activeOriginalName: row.active_original_name,
    versionCount: Number(row.version_count),
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: TopDashboardVersionRow, activeVersionId: number | null): TopDashboardVersion {
  const id = Number(row.id);
  const status: TopDashboardVersionStatus =
    id === activeVersionId ? 'active' : row.first_published_at ? 'archived' : 'draft';

  return {
    id,
    originalName: row.original_name,
    fileSize: Number(row.file_size),
    sha256: row.sha256,
    status,
    uploadedByName: row.uploaded_by_name ?? '',
    firstPublishedByName: row.first_published_by_name ?? '',
    firstPublishedAt: row.first_published_at,
    createdAt: row.created_at,
  };
}

async function findBlock(blockId: number, client?: Queryable, lock = false) {
  const db = client ?? { query };
  const result = await db.query<TopDashboardBlockRow>(
    `select id::text, title, storage_kind, created_at::text
     from top_dashboard_blocks
     where id = $1
     limit 1
     ${lock ? 'for update' : ''}`,
    [blockId],
  );
  return result.rows[0] ?? null;
}

async function requireBlock(blockId: number, client?: Queryable, lock = false) {
  const block = await findBlock(blockId, client, lock);
  if (!block) throw new TopDashboardBlockNotFoundError();
  return block;
}

export function normalizeTopDashboardBlockTitle(value: unknown) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) return null;

  const title = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!title || Array.from(title).length > TOP_DASHBOARD_BLOCK_TITLE_MAX_LENGTH) return null;
  return title;
}

export class TopDashboardBlockNotFoundError extends Error {
  constructor() {
    super('Блок не найден');
    this.name = 'TopDashboardBlockNotFoundError';
  }
}

export class TopDashboardBlockTitleValidationError extends Error {
  constructor() {
    super('Название блока должно содержать от 1 до 120 символов');
    this.name = 'TopDashboardBlockTitleValidationError';
  }
}

export class TopDashboardBlockStateNotFoundError extends Error {
  constructor() {
    super('Состояние блока не найдено');
    this.name = 'TopDashboardBlockStateNotFoundError';
  }
}

export async function getTopDashboardBlocks(): Promise<TopDashboardBlockSummary[]> {
  await ensureSiteSchema();

  const result = await query<TopDashboardBlockSummaryRow>(`
    select
      blocks.id::text,
      blocks.title,
      blocks.storage_kind,
      blocks.created_at::text,
      case
        when blocks.storage_kind = 'legacy' then legacy_state.active_version_id::text
        else native_state.active_version_id::text
      end as active_version_id,
      case
        when blocks.storage_kind = 'legacy' then legacy_active.original_name
        else native_active.original_name
      end as active_original_name,
      case
        when blocks.storage_kind = 'legacy' then (select count(*)::text from top_dashboard_versions)
        else (
          select count(*)::text
          from top_dashboard_block_versions versions
          where versions.block_id = blocks.id
        )
      end as version_count,
      case
        when blocks.storage_kind = 'legacy' then coalesce(
          greatest(
            legacy_state.updated_at,
            (select max(versions.created_at) from top_dashboard_versions versions)
          ),
          blocks.updated_at
        )::text
        else greatest(blocks.updated_at, coalesce(native_state.updated_at, blocks.updated_at))::text
      end as updated_at
    from top_dashboard_blocks blocks
    left join top_dashboard_state legacy_state
      on blocks.storage_kind = 'legacy' and legacy_state.id = 1
    left join top_dashboard_versions legacy_active
      on blocks.storage_kind = 'legacy' and legacy_active.id = legacy_state.active_version_id
    left join top_dashboard_block_state native_state
      on blocks.storage_kind = 'native' and native_state.block_id = blocks.id
    left join top_dashboard_block_versions native_active
      on native_active.block_id = blocks.id and native_active.id = native_state.active_version_id
    order by (blocks.storage_kind = 'legacy') desc, blocks.created_at asc, blocks.id asc
  `);

  return result.rows.map(mapBlockSummary);
}

export async function createTopDashboardBlock(input: {
  title: string;
  createdByAdminUserId: number | null;
}): Promise<TopDashboardBlockSummary> {
  await ensureSiteSchema();

  const title = normalizeTopDashboardBlockTitle(input.title);
  if (!title) throw new TopDashboardBlockTitleValidationError();

  return withTransaction(async (client) => {
    const result = await client.query<TopDashboardBlockRow>(
      `insert into top_dashboard_blocks (
         title,
         storage_kind,
         created_by_admin_user_id
       )
       values ($1, 'native', $2)
       returning id::text, title, storage_kind, created_at::text`,
      [title, input.createdByAdminUserId],
    );
    const row = result.rows[0];

    await client.query(
      `insert into top_dashboard_block_state (block_id)
       values ($1)`,
      [row.id],
    );

    return {
      ...mapBlock(row),
      activeVersionId: null,
      activeOriginalName: null,
      versionCount: 0,
      updatedAt: row.created_at,
    };
  });
}

export async function getTopDashboardBlockOverview(
  blockId: number,
): Promise<TopDashboardBlockOverview> {
  await ensureSiteSchema();

  const blockRow = await requireBlock(blockId);
  const block = mapBlock(blockRow);
  if (block.storageKind === 'legacy') {
    const legacyOverview = await getTopDashboardOverview();
    return { block, ...legacyOverview };
  }

  const [stateResult, versionsResult] = await Promise.all([
    query<TopDashboardStateRow>(
      `select active_version_id::text, previous_version_id::text, updated_at::text
       from top_dashboard_block_state
       where block_id = $1
       limit 1`,
      [blockId],
    ),
    query<TopDashboardVersionRow>(
      `select
         versions.id::text,
         versions.original_name,
         versions.file_size::text,
         versions.sha256,
         uploader.name as uploaded_by_name,
         publisher.name as first_published_by_name,
         versions.first_published_at::text,
         versions.created_at::text
       from top_dashboard_block_versions versions
       left join admin_users uploader on uploader.id = versions.uploaded_by_admin_user_id
       left join admin_users publisher on publisher.id = versions.first_published_by_admin_user_id
       where versions.block_id = $1
       order by versions.created_at desc, versions.id desc`,
      [blockId],
    ),
  ]);
  const state = stateResult.rows[0];
  const activeVersionId = numericId(state?.active_version_id);

  return {
    block,
    activeVersionId,
    previousVersionId: numericId(state?.previous_version_id),
    updatedAt: state?.updated_at ?? null,
    versions: versionsResult.rows.map((row) => mapVersion(row, activeVersionId)),
  };
}

export async function createTopDashboardBlockVersion(
  input: CreateTopDashboardBlockVersionInput,
): Promise<TopDashboardVersion> {
  await ensureSiteSchema();

  const block = await requireBlock(input.blockId);
  if (block.storage_kind === 'legacy') {
    return createTopDashboardVersion(input);
  }

  return withTransaction(async (client) => {
    const lockedBlock = await requireBlock(input.blockId, client, true);
    if (lockedBlock.storage_kind !== 'native') throw new TopDashboardBlockNotFoundError();

    const stateResult = await client.query<{ block_id: string }>(
      `select block_id
       from top_dashboard_block_state
       where block_id = $1
       for update`,
      [input.blockId],
    );
    if (!stateResult.rows[0]) throw new TopDashboardBlockStateNotFoundError();

    const result = await client.query<TopDashboardVersionRow>(
      `insert into top_dashboard_block_versions (
         block_id,
         original_name,
         html_content,
         file_size,
         sha256,
         uploaded_by_admin_user_id
       )
       values ($1, $2, $3, $4, $5, $6)
       returning
         id::text,
         original_name,
         file_size::text,
         sha256,
         (select name from admin_users where id = uploaded_by_admin_user_id) as uploaded_by_name,
         null::text as first_published_by_name,
         first_published_at::text,
         created_at::text`,
      [
        input.blockId,
        input.originalName,
        input.htmlContent,
        input.fileSize,
        input.sha256,
        input.uploadedByAdminUserId,
      ],
    );

    await client.query(
      `with state as (
         select active_version_id, previous_version_id
         from top_dashboard_block_state
         where block_id = $3
       ), protected_versions as (
         select
           count(*) as version_count,
           coalesce(sum(versions.file_size), 0) as stored_bytes
         from top_dashboard_block_versions versions
         cross join state
         where versions.block_id = $3
           and (
             versions.id = state.active_version_id
             or versions.id = state.previous_version_id
           )
       ), ranked as (
         select
           versions.id,
           row_number() over (order by versions.created_at desc, versions.id desc) as position,
           sum(versions.file_size) over (order by versions.created_at desc, versions.id desc) as running_bytes,
           protected_versions.version_count as protected_version_count,
           protected_versions.stored_bytes as protected_stored_bytes
         from top_dashboard_block_versions versions
         cross join state
         cross join protected_versions
         where versions.block_id = $3
           and versions.id <> coalesce(state.active_version_id, 0)
           and versions.id <> coalesce(state.previous_version_id, 0)
       )
       delete from top_dashboard_block_versions versions
       using ranked
       where versions.block_id = $3
         and versions.id = ranked.id
         and (
           ranked.position + ranked.protected_version_count > $1
           or ranked.running_bytes + ranked.protected_stored_bytes > $2
         )`,
      [TOP_DASHBOARD_VERSION_LIMIT, TOP_DASHBOARD_STORAGE_LIMIT_BYTES, input.blockId],
    );

    await client.query(
      `update top_dashboard_blocks
       set updated_at = now()
       where id = $1`,
      [input.blockId],
    );

    return mapVersion(result.rows[0], null);
  });
}

export async function getTopDashboardBlockVersionContent(
  blockId: number,
  versionId: number,
): Promise<TopDashboardVersionContent | null> {
  await ensureSiteSchema();

  const block = await requireBlock(blockId);
  if (block.storage_kind === 'legacy') {
    return getTopDashboardVersionContent(versionId);
  }

  const result = await query<{
    id: string;
    original_name: string;
    html_content: string;
    file_size: string;
    sha256: string;
  }>(
    `select id::text, original_name, html_content, file_size::text, sha256
     from top_dashboard_block_versions
     where block_id = $1 and id = $2
     limit 1`,
    [blockId, versionId],
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    id: Number(row.id),
    originalName: row.original_name,
    htmlContent: row.html_content,
    fileSize: Number(row.file_size),
    sha256: row.sha256,
  };
}

export async function activateTopDashboardBlockVersion(
  input: ActivateTopDashboardBlockVersionInput,
): Promise<ActivateTopDashboardVersionResult> {
  await ensureSiteSchema();

  const block = await requireBlock(input.blockId);
  if (block.storage_kind === 'legacy') {
    return activateTopDashboardVersion(input);
  }

  return withTransaction(async (client) => {
    const lockedBlock = await requireBlock(input.blockId, client, true);
    if (lockedBlock.storage_kind !== 'native') throw new TopDashboardBlockNotFoundError();

    const stateResult = await client.query<TopDashboardStateRow>(
      `select active_version_id::text, previous_version_id::text, updated_at::text
       from top_dashboard_block_state
       where block_id = $1
       for update`,
      [input.blockId],
    );
    const state = stateResult.rows[0];
    if (!state) throw new TopDashboardBlockStateNotFoundError();
    const currentActiveVersionId = numericId(state?.active_version_id);
    if (currentActiveVersionId !== input.expectedActiveVersionId) {
      throw new TopDashboardStateConflictError(currentActiveVersionId);
    }

    const versionResult = await client.query<{ first_published_at: string | null }>(
      `select first_published_at::text
       from top_dashboard_block_versions
       where block_id = $1 and id = $2
       limit 1`,
      [input.blockId, input.versionId],
    );
    const version = versionResult.rows[0];
    if (!version) throw new TopDashboardVersionNotFoundError();

    if (currentActiveVersionId === input.versionId) {
      return {
        activeVersionId: input.versionId,
        previousVersionId: numericId(state?.previous_version_id),
        updatedAt: state?.updated_at ?? new Date().toISOString(),
        change: 'unchanged',
      };
    }

    await client.query(
      `update top_dashboard_block_versions
       set first_published_at = coalesce(first_published_at, now()),
           first_published_by_admin_user_id = case
             when first_published_at is null then $3
             else first_published_by_admin_user_id
           end
       where block_id = $1 and id = $2`,
      [input.blockId, input.versionId, input.adminUserId],
    );

    const updatedStateResult = await client.query<TopDashboardStateRow>(
      `update top_dashboard_block_state
       set previous_version_id = active_version_id,
           active_version_id = $2,
           updated_by_admin_user_id = $3,
           updated_at = now()
       where block_id = $1
       returning active_version_id::text, previous_version_id::text, updated_at::text`,
      [input.blockId, input.versionId, input.adminUserId],
    );
    const updatedState = updatedStateResult.rows[0];

    await client.query(
      `update top_dashboard_blocks
       set updated_at = now()
       where id = $1`,
      [input.blockId],
    );

    return {
      activeVersionId: input.versionId,
      previousVersionId: numericId(updatedState.previous_version_id),
      updatedAt: updatedState.updated_at,
      change: version.first_published_at ? 'rolled_back' : 'published',
    };
  });
}

export async function deleteTopDashboardBlockVersion(input: {
  blockId: number;
  versionId: number;
  adminUserId: number | null;
}): Promise<DeleteTopDashboardBlockVersionResult> {
  await ensureSiteSchema();

  const block = await requireBlock(input.blockId);
  if (block.storage_kind === 'legacy') {
    const result = await deleteTopDashboardVersion(input);
    return { blockId: input.blockId, ...result };
  }

  return withTransaction(async (client) => {
    const lockedBlock = await requireBlock(input.blockId, client, true);
    if (lockedBlock.storage_kind !== 'native') throw new TopDashboardBlockNotFoundError();

    const stateResult = await client.query<TopDashboardStateRow>(
      `select active_version_id::text, previous_version_id::text, updated_at::text
       from top_dashboard_block_state
       where block_id = $1
       for update`,
      [input.blockId],
    );
    const state = stateResult.rows[0];
    if (!state) throw new TopDashboardBlockStateNotFoundError();
    const activeVersionId = numericId(state?.active_version_id);
    const currentPreviousVersionId = numericId(state?.previous_version_id);

    const versionResult = await client.query<{
      id: string;
      original_name: string;
      file_size: string;
      sha256: string;
      first_published_at: string | null;
    }>(
      `select id::text, original_name, file_size::text, sha256, first_published_at::text
       from top_dashboard_block_versions
       where block_id = $1 and id = $2
       limit 1
       for update`,
      [input.blockId, input.versionId],
    );
    const version = versionResult.rows[0];
    if (!version) throw new TopDashboardVersionNotFoundError();
    if (activeVersionId === input.versionId) {
      throw new TopDashboardActiveVersionDeleteError(input.versionId);
    }

    let previousVersionId = currentPreviousVersionId;
    let updatedAt = state?.updated_at ?? new Date().toISOString();
    const replacedPreviousVersion = currentPreviousVersionId === input.versionId;

    if (replacedPreviousVersion) {
      const replacementResult = await client.query<{ id: string }>(
        `select id::text
         from top_dashboard_block_versions
         where block_id = $1
           and id <> $2
           and id <> coalesce($3, 0)
           and first_published_at is not null
         order by first_published_at desc, created_at desc, id desc
         limit 1
         for update`,
        [input.blockId, input.versionId, activeVersionId],
      );
      previousVersionId = numericId(replacementResult.rows[0]?.id);

      const updatedStateResult = await client.query<TopDashboardStateRow>(
        `update top_dashboard_block_state
         set previous_version_id = $2,
             updated_by_admin_user_id = $3,
             updated_at = now()
         where block_id = $1
         returning active_version_id::text, previous_version_id::text, updated_at::text`,
        [input.blockId, previousVersionId, input.adminUserId],
      );
      const updatedState = updatedStateResult.rows[0];
      previousVersionId = numericId(updatedState?.previous_version_id);
      updatedAt = updatedState?.updated_at ?? updatedAt;
    }

    await client.query(
      `delete from top_dashboard_block_versions
       where block_id = $1 and id = $2`,
      [input.blockId, input.versionId],
    );
    await client.query(
      `update top_dashboard_blocks
       set updated_at = now()
       where id = $1`,
      [input.blockId],
    );

    return {
      blockId: input.blockId,
      deletedVersion: {
        id: Number(version.id),
        originalName: version.original_name,
        fileSize: Number(version.file_size),
        sha256: version.sha256,
        firstPublishedAt: version.first_published_at,
      },
      activeVersionId,
      previousVersionId,
      updatedAt,
      replacedPreviousVersion,
    };
  });
}
