import type { PoolClient } from 'pg';

import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';

export type TopDashboardVersionStatus = 'active' | 'draft' | 'archived';

export type TopDashboardVersion = {
  id: number;
  originalName: string;
  fileSize: number;
  sha256: string;
  status: TopDashboardVersionStatus;
  uploadedByName: string;
  firstPublishedByName: string;
  firstPublishedAt: string | null;
  createdAt: string;
};

export type TopDashboardOverview = {
  activeVersionId: number | null;
  previousVersionId: number | null;
  updatedAt: string | null;
  versions: TopDashboardVersion[];
};

export type TopDashboardVersionContent = {
  id: number;
  originalName: string;
  htmlContent: string;
  fileSize: number;
  sha256: string;
};

export type CreateTopDashboardVersionInput = {
  originalName: string;
  htmlContent: string;
  fileSize: number;
  sha256: string;
  uploadedByAdminUserId: number;
};

const TOP_DASHBOARD_VERSION_LIMIT = 50;
const TOP_DASHBOARD_STORAGE_LIMIT_BYTES = 100 * 1024 * 1024;

export type ActivateTopDashboardVersionResult = {
  activeVersionId: number;
  previousVersionId: number | null;
  updatedAt: string;
  change: 'published' | 'rolled_back' | 'unchanged';
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

async function getState(client?: Pick<PoolClient, 'query'>) {
  const db = client ?? { query };
  const result = await db.query<TopDashboardStateRow>(
    `select active_version_id::text, previous_version_id::text, updated_at::text
     from top_dashboard_state
     where id = 1
     limit 1`,
  );

  return result.rows[0] ?? null;
}

export async function getTopDashboardOverview(): Promise<TopDashboardOverview> {
  await ensureSiteSchema();

  const [state, versionsResult] = await Promise.all([
    getState(),
    query<TopDashboardVersionRow>(`
      select
        versions.id::text,
        versions.original_name,
        versions.file_size::text,
        versions.sha256,
        uploader.name as uploaded_by_name,
        publisher.name as first_published_by_name,
        versions.first_published_at::text,
        versions.created_at::text
      from top_dashboard_versions versions
      left join admin_users uploader on uploader.id = versions.uploaded_by_admin_user_id
      left join admin_users publisher on publisher.id = versions.first_published_by_admin_user_id
      order by versions.created_at desc, versions.id desc
    `),
  ]);

  const activeVersionId = numericId(state?.active_version_id);
  return {
    activeVersionId,
    previousVersionId: numericId(state?.previous_version_id),
    updatedAt: state?.updated_at ?? null,
    versions: versionsResult.rows.map((row) => mapVersion(row, activeVersionId)),
  };
}

export async function createTopDashboardVersion(
  input: CreateTopDashboardVersionInput,
): Promise<TopDashboardVersion> {
  await ensureSiteSchema();

  return withTransaction(async (client) => {
    const result = await client.query<TopDashboardVersionRow>(
      `insert into top_dashboard_versions (
         original_name,
         html_content,
         file_size,
         sha256,
         uploaded_by_admin_user_id
       )
       values ($1, $2, $3, $4, $5)
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
        input.originalName,
        input.htmlContent,
        input.fileSize,
        input.sha256,
        input.uploadedByAdminUserId,
      ],
    );

    // Keep rollback history bounded without ever deleting the active or previous publication.
    await client.query(
      `with state as (
         select active_version_id, previous_version_id
         from top_dashboard_state
         where id = 1
       ), protected_versions as (
         select
           count(*) as version_count,
           coalesce(sum(versions.file_size), 0) as stored_bytes
         from top_dashboard_versions versions
         cross join state
         where versions.id = state.active_version_id
            or versions.id = state.previous_version_id
       ), ranked as (
         select
           versions.id,
           row_number() over (order by versions.created_at desc, versions.id desc) as position,
           sum(versions.file_size) over (order by versions.created_at desc, versions.id desc) as running_bytes,
           protected_versions.version_count as protected_version_count,
           protected_versions.stored_bytes as protected_stored_bytes
         from top_dashboard_versions versions
         cross join state
         cross join protected_versions
         where versions.id <> coalesce(state.active_version_id, 0)
           and versions.id <> coalesce(state.previous_version_id, 0)
       )
       delete from top_dashboard_versions versions
       using ranked
       where versions.id = ranked.id
         and (
           ranked.position + ranked.protected_version_count > $1
           or ranked.running_bytes + ranked.protected_stored_bytes > $2
         )`,
      [TOP_DASHBOARD_VERSION_LIMIT, TOP_DASHBOARD_STORAGE_LIMIT_BYTES],
    );

    return mapVersion(result.rows[0], null);
  });
}

export async function getTopDashboardVersionContent(
  versionId: number,
): Promise<TopDashboardVersionContent | null> {
  await ensureSiteSchema();

  const result = await query<{
    id: string;
    original_name: string;
    html_content: string;
    file_size: string;
    sha256: string;
  }>(
    `select id::text, original_name, html_content, file_size::text, sha256
     from top_dashboard_versions
     where id = $1
     limit 1`,
    [versionId],
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

export class TopDashboardVersionNotFoundError extends Error {
  constructor() {
    super('Версия HTML не найдена');
    this.name = 'TopDashboardVersionNotFoundError';
  }
}

export class TopDashboardStateConflictError extends Error {
  currentActiveVersionId: number | null;

  constructor(currentActiveVersionId: number | null) {
    super('Активная версия уже изменилась');
    this.name = 'TopDashboardStateConflictError';
    this.currentActiveVersionId = currentActiveVersionId;
  }
}

export async function activateTopDashboardVersion(input: {
  versionId: number;
  expectedActiveVersionId: number | null;
  adminUserId: number;
}): Promise<ActivateTopDashboardVersionResult> {
  await ensureSiteSchema();

  return withTransaction(async (client) => {
    const stateResult = await client.query<TopDashboardStateRow>(
      `select active_version_id::text, previous_version_id::text, updated_at::text
       from top_dashboard_state
       where id = 1
       for update`,
    );
    const state = stateResult.rows[0];
    const currentActiveVersionId = numericId(state?.active_version_id);

    if (currentActiveVersionId !== input.expectedActiveVersionId) {
      throw new TopDashboardStateConflictError(currentActiveVersionId);
    }

    const versionResult = await client.query<{ first_published_at: string | null }>(
      `select first_published_at::text
       from top_dashboard_versions
       where id = $1
       limit 1`,
      [input.versionId],
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
      `update top_dashboard_versions
       set first_published_at = coalesce(first_published_at, now()),
           first_published_by_admin_user_id = case
             when first_published_at is null then $2
             else first_published_by_admin_user_id
           end
       where id = $1`,
      [input.versionId, input.adminUserId],
    );

    const updatedStateResult = await client.query<TopDashboardStateRow>(
      `update top_dashboard_state
       set previous_version_id = active_version_id,
           active_version_id = $1,
           updated_by_admin_user_id = $2,
           updated_at = now()
       where id = 1
       returning active_version_id::text, previous_version_id::text, updated_at::text`,
      [input.versionId, input.adminUserId],
    );
    const updatedState = updatedStateResult.rows[0];

    return {
      activeVersionId: input.versionId,
      previousVersionId: numericId(updatedState.previous_version_id),
      updatedAt: updatedState.updated_at,
      change: version.first_published_at ? 'rolled_back' : 'published',
    };
  });
}
