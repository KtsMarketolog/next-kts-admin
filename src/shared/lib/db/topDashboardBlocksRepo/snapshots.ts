import { TOP_DASHBOARD_DATA_STORAGE_LIMIT_BYTES } from '../../topDashboardLimits';
import {
  TopDashboardBlockDataStateConflictError,
  TopDashboardBlockDataStateNotFoundError,
  TopDashboardBlockDataVersionNotFoundError,
  type ActivateTopDashboardBlockDataVersionInput,
  type ActivateTopDashboardBlockDataVersionResult,
  type CreateAndActivateTopDashboardBlockDataVersionInput,
  type CreateAndActivateTopDashboardBlockDataVersionResult,
  type TopDashboardProfile,
  type TopDashboardSnapshotFormat,
} from '../topDashboardDomain';
import { TopDashboardDataStorageLimitError } from './types';
import { assertDashboardDataCompatibility, assertExpectedActiveHtmlVersion } from './dataCompatibility';
import { enqueueDashboardFilesForDeletion } from '../dashboardFileCleanupRepo';
import { ensureSiteSchema } from '../schema';
import { initializeDashboardDataContexts, saveDashboardDataContext } from './dataContexts';
import {
  mapDataVersion,
  numericId,
  requireBlock,
  type TopDashboardBlockDataVersionRow,
  type TopDashboardStateRow,
} from './records';
import { normalizeDashboardDataDate } from '../../dashboardDates';
import { pruneDashboardDataVersions } from './history';
import { withTransaction } from '../client';

export async function createAndActivateTopDashboardBlockDataVersion(
  input: CreateAndActivateTopDashboardBlockDataVersionInput,
): Promise<CreateAndActivateTopDashboardBlockDataVersionResult> {
  await ensureSiteSchema();

  return withTransaction(async (client) => {
    await requireBlock(input.blockId, client, true);
    await assertExpectedActiveHtmlVersion(
      client,
      input.blockId,
      input.expectedActiveHtmlVersionId,
      input.expectedHtmlSnapshotFormat,
      input.expectedHtmlProfile,
    );

    assertDashboardDataCompatibility({
      htmlVersionId: input.expectedActiveHtmlVersionId,
      htmlSnapshotFormat: input.expectedHtmlSnapshotFormat,
      htmlProfile: input.expectedHtmlProfile,
      dataSnapshotFormat: input.snapshotFormat,
      dataProfile: input.dashboardProfile,
      dataBoundHtmlVersionId: input.boundHtmlVersionId,
      action: 'data',
    });

    const stateResult = await client.query<TopDashboardStateRow>(
      `select active_version_id::text, previous_version_id::text, updated_at::text
       from top_dashboard_block_data_state
       where block_id = $1
       for update`,
      [input.blockId],
    );
    const state = stateResult.rows[0];
    if (!state) throw new TopDashboardBlockDataStateNotFoundError();

    const currentActiveVersionId = numericId(state.active_version_id);
    if (currentActiveVersionId !== input.expectedActiveVersionId) {
      throw new TopDashboardBlockDataStateConflictError(currentActiveVersionId);
    }

    const duplicate = await client.query<TopDashboardBlockDataVersionRow & { storage_path: string | null }>(
      `select id::text, original_name, file_size::text, uncompressed_size::text, sha256,
         data_as_of,
         snapshot_format, dashboard_profile, bound_html_version_id::text, storage_path,
         coalesce(
           (select name from admin_users where id = uploaded_by_admin_user_id),
           (select name from wholesale_managers where id = uploaded_by_manager_id)
         ) as uploaded_by_name, created_at::text
       from top_dashboard_block_data_versions
       where block_id = $1 and id = $2 and sha256 = $3
         and snapshot_format = $4 and dashboard_profile = $5
         and bound_html_version_id is not distinct from $6::bigint`,
      [input.blockId, currentActiveVersionId, input.sha256, input.snapshotFormat,
        input.dashboardProfile, input.boundHtmlVersionId],
    );
    if (duplicate.rows[0]) {
      // Only the redundant new file may be discarded; old history is untouched.
      const prunedStoragePaths = input.storagePath && input.storagePath !== duplicate.rows[0].storage_path
        ? [input.storagePath] : [];
      await enqueueDashboardFilesForDeletion(client, prunedStoragePaths);
      return {
        version: mapDataVersion(duplicate.rows[0], currentActiveVersionId, numericId(state.previous_version_id)),
        activeVersionId: Number(duplicate.rows[0].id),
        previousVersionId: numericId(state.previous_version_id),
        updatedAt: state.updated_at,
        prunedVersionIds: [],
        prunedStoragePaths,
      };
    }

    await initializeDashboardDataContexts(client, input.blockId);

    const versionResult = await client.query<TopDashboardBlockDataVersionRow>(
      `insert into top_dashboard_block_data_versions (
         block_id,
         original_name,
         compressed_payload,
         file_size,
         uncompressed_size,
         sha256,
         snapshot_format,
         dashboard_profile,
         bound_html_version_id,
         uploaded_by_admin_user_id,
         uploaded_by_manager_id,
         storage_path,
         data_as_of
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning
         id::text,
         original_name,
         file_size::text,
         uncompressed_size::text,
         data_as_of,
         sha256,
         snapshot_format,
         dashboard_profile,
         bound_html_version_id::text,
         coalesce(
           (select name from admin_users where id = uploaded_by_admin_user_id),
           (select name from wholesale_managers where id = uploaded_by_manager_id)
         ) as uploaded_by_name,
         created_at::text`,
      [
        input.blockId,
        input.originalName,
        input.content,
        input.fileSize,
        input.uncompressedSize,
        input.sha256,
        input.snapshotFormat,
        input.dashboardProfile,
        input.boundHtmlVersionId,
        input.uploadedByAdminUserId,
        input.uploadedByManagerId,
        input.storagePath,
        normalizeDashboardDataDate(input.dataAsOf),
      ],
    );
    const versionRow = versionResult.rows[0];
    const versionId = Number(versionRow.id);

    const updatedStateResult = await client.query<TopDashboardStateRow>(
      `update top_dashboard_block_data_state
       set previous_version_id = active_version_id,
           active_version_id = $2,
           updated_by_admin_user_id = $3,
           updated_by_manager_id = $4,
           updated_at = now()
       where block_id = $1
       returning active_version_id::text, previous_version_id::text, updated_at::text`,
      [input.blockId, versionId, input.uploadedByAdminUserId, input.uploadedByManagerId],
    );
    const updatedState = updatedStateResult.rows[0];

    await saveDashboardDataContext(client, input.blockId);
    const pruned = await pruneDashboardDataVersions(client, input.blockId);
    const retainedBytes = await client.query<{ stored_bytes: string }>(
      `select coalesce(sum(file_size), 0)::text as stored_bytes
       from top_dashboard_block_data_versions where block_id = $1`,
      [input.blockId],
    );
    // Required rollback pairs never compete for quota by evicting each other.
    // Reject the new upload and roll back pruning/state together instead.
    if (Number(retainedBytes.rows[0].stored_bytes) > TOP_DASHBOARD_DATA_STORAGE_LIMIT_BYTES) {
      throw new TopDashboardDataStorageLimitError();
    }

    await client.query(
      `update top_dashboard_blocks
       set updated_at = now()
       where id = $1`,
      [input.blockId],
    );

    return {
      version: mapDataVersion(versionRow, versionId, currentActiveVersionId),
      activeVersionId: versionId,
      previousVersionId: numericId(updatedState.previous_version_id),
      updatedAt: updatedState.updated_at,
      ...pruned,
    };
  });
}

export async function activateTopDashboardBlockDataVersion(
  input: ActivateTopDashboardBlockDataVersionInput,
): Promise<ActivateTopDashboardBlockDataVersionResult & { prunedStoragePaths: string[] }> {
  await ensureSiteSchema();

  return withTransaction(async (client) => {
    await requireBlock(input.blockId, client, true);
    await assertExpectedActiveHtmlVersion(
      client,
      input.blockId,
      input.expectedActiveHtmlVersionId,
      input.expectedHtmlSnapshotFormat,
      input.expectedHtmlProfile,
    );

    const stateResult = await client.query<TopDashboardStateRow>(
      `select active_version_id::text, previous_version_id::text, updated_at::text
       from top_dashboard_block_data_state
       where block_id = $1
       for update`,
      [input.blockId],
    );
    const state = stateResult.rows[0];
    if (!state) throw new TopDashboardBlockDataStateNotFoundError();

    const currentActiveVersionId = numericId(state.active_version_id);
    if (currentActiveVersionId !== input.expectedActiveVersionId) {
      throw new TopDashboardBlockDataStateConflictError(currentActiveVersionId);
    }

    const versionResult = await client.query<{
      id: string;
      snapshot_format: TopDashboardSnapshotFormat;
      dashboard_profile: TopDashboardProfile;
      bound_html_version_id: string | null;
    }>(
      `select id::text, snapshot_format, dashboard_profile, bound_html_version_id::text
       from top_dashboard_block_data_versions
       where block_id = $1 and id = $2
       limit 1
       for update`,
      [input.blockId, input.versionId],
    );
    const version = versionResult.rows[0];
    if (!version) throw new TopDashboardBlockDataVersionNotFoundError();

    assertDashboardDataCompatibility({
      htmlVersionId: input.expectedActiveHtmlVersionId,
      htmlSnapshotFormat: input.expectedHtmlSnapshotFormat,
      htmlProfile: input.expectedHtmlProfile,
      dataSnapshotFormat: version.snapshot_format,
      dataProfile: version.dashboard_profile,
      dataBoundHtmlVersionId: numericId(version.bound_html_version_id),
      action: 'data',
    });

    if (currentActiveVersionId === input.versionId) {
      return {
        activeVersionId: input.versionId,
        previousVersionId: numericId(state.previous_version_id),
        updatedAt: state.updated_at,
        change: 'unchanged',
        prunedStoragePaths: [],
      };
    }

    await initializeDashboardDataContexts(client, input.blockId);

    const updatedStateResult = await client.query<TopDashboardStateRow>(
      `update top_dashboard_block_data_state
       set previous_version_id = active_version_id,
           active_version_id = $2,
           updated_by_admin_user_id = $3,
           updated_by_manager_id = $4,
           updated_at = now()
       where block_id = $1
       returning active_version_id::text, previous_version_id::text, updated_at::text`,
      [input.blockId, input.versionId, input.adminUserId, input.managerId],
    );
    const updatedState = updatedStateResult.rows[0];

    await saveDashboardDataContext(client, input.blockId);
    const pruned = await pruneDashboardDataVersions(client, input.blockId);

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
      change: 'rolled_back',
      prunedStoragePaths: pruned.prunedStoragePaths,
    };
  });
}
