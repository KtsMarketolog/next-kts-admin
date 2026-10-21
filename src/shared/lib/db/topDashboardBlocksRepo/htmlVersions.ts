import {
  TopDashboardActiveVersionDeleteError,
  TopDashboardVersionNotFoundError,
} from '../topDashboardDomain';
import {
  TopDashboardBlockStateNotFoundError,
  TopDashboardDraftLimitError,
  type CreateTopDashboardBlockVersionInput,
  type CreateTopDashboardBlockVersionResult,
  type DeleteTopDashboardBlockVersionResult,
} from './types';
import { enqueueDashboardFilesForDeletion } from '../dashboardFileCleanupRepo';
import { ensureSiteSchema } from '../schema';
import {
  mapVersion,
  numericId,
  requireBlock,
  type TopDashboardStateRow,
  type TopDashboardVersionRow,
} from './records';
import { withTransaction } from '../client';
import { enqueueDashboardUploadUsage } from '../dashboardUploadUsageOutboxRepo';

export const TOP_DASHBOARD_VERSION_LIMIT = 50;

export const TOP_DASHBOARD_STORAGE_LIMIT_BYTES = 100 * 1024 * 1024;

export async function createTopDashboardBlockVersion(
  input: CreateTopDashboardBlockVersionInput,
): Promise<CreateTopDashboardBlockVersionResult> {
  await ensureSiteSchema();

  return withTransaction(async (client) => {
    await requireBlock(input.blockId, client, true);

    const stateResult = await client.query<{ block_id: string }>(
      `select block_id
       from top_dashboard_block_state
       where block_id = $1
       for update`,
      [input.blockId],
    );
    if (!stateResult.rows[0]) throw new TopDashboardBlockStateNotFoundError();

    const quota = await client.query<{ version_count: string; stored_bytes: string }>(
      `select count(*)::text as version_count, coalesce(sum(file_size), 0)::text as stored_bytes
       from top_dashboard_block_versions where block_id = $1`,
      [input.blockId],
    );
    if (
      Number(quota.rows[0].version_count) >= TOP_DASHBOARD_VERSION_LIMIT
      || Number(quota.rows[0].stored_bytes) + input.fileSize > TOP_DASHBOARD_STORAGE_LIMIT_BYTES
    ) {
      throw new TopDashboardDraftLimitError();
    }

    const result = await client.query<TopDashboardVersionRow>(
      `insert into top_dashboard_block_versions (
         block_id,
         original_name,
         html_content,
         file_size,
         sha256,
         uploaded_by_admin_user_id,
         uploaded_by_manager_id
       )
       values ($1, $2, $3, $4, $5, $6, $7)
       returning
         id::text,
         original_name,
         file_size::text,
         sha256,
         coalesce(
           (select name from admin_users where id = uploaded_by_admin_user_id),
           (select name from wholesale_managers where id = uploaded_by_manager_id)
         ) as uploaded_by_name,
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
        input.uploadedByManagerId,
      ],
    );

    await client.query(
      `update top_dashboard_blocks
       set updated_at = now()
       where id = $1`,
      [input.blockId],
    );

    const version = mapVersion(result.rows[0], null);
    if (input.usageActor) await enqueueDashboardUploadUsage(client, input.usageActor, {
      dashboardKey: `top:${input.blockId}`, versionId: version.id,
      resourceKey: `top-html:${input.blockId}:${version.id}`, name: version.originalName, size: version.fileSize, type: 'html',
    });
    return {
      version,
      prunedStoragePaths: [],
    };
  });
}

export async function deleteTopDashboardBlockVersion(input: {
  blockId: number;
  versionId: number;
  adminUserId: number | null;
  managerId: number | null;
}): Promise<DeleteTopDashboardBlockVersionResult> {
  await ensureSiteSchema();

  return withTransaction(async (client) => {
    await requireBlock(input.blockId, client, true);

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

    const boundDataFilesResult = await client.query<{ storage_path: string }>(
      `select storage_path
       from top_dashboard_block_data_versions
       where block_id = $1
         and bound_html_version_id = $2
         and storage_path is not null`,
      [input.blockId, input.versionId],
    );

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
             updated_by_manager_id = $4,
             updated_at = now()
         where block_id = $1
         returning active_version_id::text, previous_version_id::text, updated_at::text`,
        [input.blockId, previousVersionId, input.adminUserId, input.managerId],
      );
      const updatedState = updatedStateResult.rows[0];
      previousVersionId = numericId(updatedState?.previous_version_id);
      updatedAt = updatedState?.updated_at ?? updatedAt;
    }

    await client.query(
      `with bound_data_versions as (
         select id
         from top_dashboard_block_data_versions
         where block_id = $1
           and bound_html_version_id = $2
       )
       update top_dashboard_block_data_state data_state
       set active_version_id = case
             when data_state.active_version_id in (select id from bound_data_versions)
               then null
             else data_state.active_version_id
           end,
           previous_version_id = case
             when data_state.previous_version_id in (select id from bound_data_versions)
               then null
             else data_state.previous_version_id
           end,
           updated_by_admin_user_id = $3,
           updated_by_manager_id = $4,
           updated_at = now()
       where data_state.block_id = $1
         and (
           data_state.active_version_id in (select id from bound_data_versions)
           or data_state.previous_version_id in (select id from bound_data_versions)
         )`,
      [input.blockId, input.versionId, input.adminUserId, input.managerId],
    );

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

    const deletedStoragePaths = boundDataFilesResult.rows.map((row) => row.storage_path);
    await enqueueDashboardFilesForDeletion(client, deletedStoragePaths);
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
      deletedStoragePaths,
    };
  });
}
