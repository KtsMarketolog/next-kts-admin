import {
  TopDashboardBlockNotFoundError,
  TopDashboardBlockStateNotFoundError,
  TopDashboardBlockTitleValidationError,
  type DeleteTopDashboardBlockResult,
  type RenameTopDashboardBlockResult,
  type TopDashboardBlockSummary,
} from './types';
import { enqueueDashboardFilesForDeletion } from '../dashboardFileCleanupRepo';
import { ensureSiteSchema } from '../schema';
import {
  mapBlock,
  numericId,
  requireBlock,
  type TopDashboardBlockRow,
  type TopDashboardStateRow,
} from './records';
import { withTransaction } from '../client';

export const TOP_DASHBOARD_BLOCK_TITLE_MAX_LENGTH = 120;

export function normalizeTopDashboardBlockTitle(value: unknown) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) return null;

  const title = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!title || Array.from(title).length > TOP_DASHBOARD_BLOCK_TITLE_MAX_LENGTH) return null;
  return title;
}

export async function createTopDashboardBlock(input: {
  title: string;
  createdByAdminUserId: number | null;
  createdByManagerId: number | null;
}): Promise<TopDashboardBlockSummary> {
  await ensureSiteSchema();

  const title = normalizeTopDashboardBlockTitle(input.title);
  if (!title) throw new TopDashboardBlockTitleValidationError();

  return withTransaction(async (client) => {
    const result = await client.query<TopDashboardBlockRow>(
      `insert into top_dashboard_blocks (
         title,
         created_by_admin_user_id,
         created_by_manager_id
       )
       values ($1, $2, $3)
       returning id::text, title, created_at::text`,
      [title, input.createdByAdminUserId, input.createdByManagerId],
    );
    const row = result.rows[0];

    await client.query(
      `insert into top_dashboard_block_state (block_id)
       values ($1)`,
      [row.id],
    );
    await client.query(
      `insert into top_dashboard_block_data_state (block_id)
       values ($1)`,
      [row.id],
    );

    return {
      ...mapBlock(row),
      activeVersionId: null,
      activeOriginalName: null,
      versionCount: 0,
      updatedAt: row.created_at,
      dataUploadedAt: null,
      dataAsOf: null,
      htmlPublishedAt: null,
    };
  });
}

export async function renameTopDashboardBlock(input: {
  blockId: number;
  title: string;
}): Promise<RenameTopDashboardBlockResult> {
  await ensureSiteSchema();

  const title = normalizeTopDashboardBlockTitle(input.title);
  if (!title) throw new TopDashboardBlockTitleValidationError();

  return withTransaction(async (client) => {
    const existing = await requireBlock(input.blockId, client, true);
    if (existing.title === title) {
      return {
        block: mapBlock(existing),
        previousTitle: existing.title,
        changed: false,
      };
    }

    const result = await client.query<TopDashboardBlockRow>(
      `update top_dashboard_blocks
       set title = $2,
           updated_at = now()
       where id = $1
       returning id::text, title, created_at::text`,
      [input.blockId, title],
    );
    const updated = result.rows[0];
    if (!updated) throw new TopDashboardBlockNotFoundError();

    return {
      block: mapBlock(updated),
      previousTitle: existing.title,
      changed: true,
    };
  });
}

export async function deleteTopDashboardBlock(
  blockId: number,
): Promise<DeleteTopDashboardBlockResult> {
  await ensureSiteSchema();

  return withTransaction(async (client) => {
    await requireBlock(blockId, client, true);

    const stateResult = await client.query<TopDashboardStateRow>(
      `select active_version_id::text, previous_version_id::text, updated_at::text
       from top_dashboard_block_state
       where block_id = $1
       for update`,
      [blockId],
    );
    const state = stateResult.rows[0];
    if (!state) throw new TopDashboardBlockStateNotFoundError();

    const versionsResult = await client.query<{
      version_count: string;
      stored_bytes: string;
    }>(
      `select count(*)::text as version_count,
              coalesce(sum(file_size), 0)::text as stored_bytes
       from top_dashboard_block_versions
       where block_id = $1`,
      [blockId],
    );
    const versions = versionsResult.rows[0];
    const dataVersionsResult = await client.query<{
      version_count: string;
      stored_bytes: string;
      storage_paths: string[];
    }>(
      `select count(*)::text as version_count,
              coalesce(sum(file_size), 0)::text as stored_bytes,
              array_remove(array_agg(storage_path), null) as storage_paths
       from top_dashboard_block_data_versions
       where block_id = $1`,
      [blockId],
    );
    const dataVersions = dataVersionsResult.rows[0];

    // Remove the state row first so its RESTRICT references to active and
    // previous versions cannot block the block-level cascade.
    await client.query(
      `delete from top_dashboard_block_data_state
       where block_id = $1`,
      [blockId],
    );
    await client.query(
      `delete from top_dashboard_block_state
       where block_id = $1`,
      [blockId],
    );
    const deletedResult = await client.query<TopDashboardBlockRow>(
      `delete from top_dashboard_blocks
       where id = $1
       returning id::text, title, created_at::text`,
      [blockId],
    );
    const deleted = deletedResult.rows[0];
    if (!deleted) throw new TopDashboardBlockNotFoundError();
    await enqueueDashboardFilesForDeletion(client, dataVersions?.storage_paths ?? []);

    return {
      deletedBlock: {
        ...mapBlock(deleted),
        activeVersionId: numericId(state.active_version_id),
        previousVersionId: numericId(state.previous_version_id),
        versionCount: Number(versions?.version_count ?? 0),
        storedBytes: Number(versions?.stored_bytes ?? 0),
        dataVersionCount: Number(dataVersions?.version_count ?? 0),
        dataStoredBytes: Number(dataVersions?.stored_bytes ?? 0),
      },
      deletedStoragePaths: dataVersions?.storage_paths ?? [],
    };
  });
}
