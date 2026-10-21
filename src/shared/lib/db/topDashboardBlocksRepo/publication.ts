import {
  TopDashboardBlockDataStateNotFoundError,
  TopDashboardBlockDataVersionNotFoundError,
  TopDashboardDataCompatibilityError,
  TopDashboardStateConflictError,
  TopDashboardVersionNotFoundError,
  type ActivateTopDashboardVersionResult,
  type TopDashboardProfile,
  type TopDashboardSnapshotFormat,
} from '../topDashboardDomain';
import { TopDashboardBlockStateNotFoundError, type ActivateTopDashboardBlockVersionInput } from './types';
import {
  assertDashboardDataCompatibility,
  assertValidDashboardDataContract,
  dashboardDataContextKey,
  isGenericDashboardDataContract,
} from './dataCompatibility';
import { ensureSiteSchema } from '../schema';
import { initializeDashboardDataContexts } from './dataContexts';
import { detectTopDashboardDataContract } from '../../topDashboardContentSecurity';
import { numericId, requireBlock, type TopDashboardStateRow } from './records';
import { pruneDashboardDataVersions, pruneDashboardPublishedHtml } from './history';
import { withTransaction } from '../client';

export async function activateTopDashboardBlockVersion(
  input: ActivateTopDashboardBlockVersionInput,
): Promise<ActivateTopDashboardVersionResult & { prunedStoragePaths: string[] }> {
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
    const currentActiveVersionId = numericId(state?.active_version_id);
    if (currentActiveVersionId !== input.expectedActiveVersionId) {
      throw new TopDashboardStateConflictError(currentActiveVersionId);
    }

    const versionResult = await client.query<{ first_published_at: string | null; html_content: string }>(
      `select first_published_at::text, html_content
       from top_dashboard_block_versions
       where block_id = $1 and id = $2
       limit 1`,
      [input.blockId, input.versionId],
    );
    const version = versionResult.rows[0];
    if (!version) throw new TopDashboardVersionNotFoundError();

    // Never trust the caller to convert private/local inputs into a shared
    // snapshot (or to detach an ordinary connected report's data silently).
    const contract = detectTopDashboardDataContract(version.html_content);
    if (contract.snapshotFormat !== input.expectedSnapshotFormat || contract.profile !== input.expectedProfile) {
      throw new TopDashboardDataCompatibilityError('Режим HTML изменился. Обновите список версий и повторите публикацию');
    }
    const localOnly = contract.mode === 'disabled' && contract.snapshotFormat === null
      && (contract.profile === 'profitability' || contract.profile === 'standalone');
    if (!localOnly) {
      assertValidDashboardDataContract(input.expectedSnapshotFormat, input.expectedProfile);
    }

    const unchanged = currentActiveVersionId === input.versionId;
    const unchangedResult = {
      activeVersionId: input.versionId,
      previousVersionId: numericId(state.previous_version_id),
      updatedAt: state.updated_at,
      change: 'unchanged' as const,
      prunedStoragePaths: [],
    };
    if (unchanged && !localOnly) {
      return unchangedResult;
    }

    const dataResult = await client.query<{
      active_version_id: string | null;
      previous_version_id: string | null;
      snapshot_format: TopDashboardSnapshotFormat | null;
      dashboard_profile: TopDashboardProfile | null;
      bound_html_version_id: string | null;
    }>(
      `select
         data_state.active_version_id::text,
         data_state.previous_version_id::text,
         data_versions.snapshot_format,
         data_versions.dashboard_profile,
         data_versions.bound_html_version_id::text
       from top_dashboard_block_data_state data_state
       left join top_dashboard_block_data_versions data_versions
         on data_versions.block_id = data_state.block_id
        and data_versions.id = data_state.active_version_id
       where data_state.block_id = $1
       limit 1
       for update of data_state`,
      [input.blockId],
    );
    const dataState = dataResult.rows[0];
    if (!dataState) throw new TopDashboardBlockDataStateNotFoundError();
    if (unchanged && dataState.active_version_id === null && dataState.previous_version_id === null) {
      return unchangedResult;
    }
    if (dataState.active_version_id !== null) {
      if (!dataState.snapshot_format || !dataState.dashboard_profile) {
        throw new TopDashboardBlockDataVersionNotFoundError();
      }
      const targetIsGeneric = isGenericDashboardDataContract(
        input.expectedSnapshotFormat,
        input.expectedProfile,
      );
      const activeDataIsGeneric = isGenericDashboardDataContract(
        dataState.snapshot_format,
        dataState.dashboard_profile,
      );
      const activeDataBinding = numericId(dataState.bound_html_version_id);

      // Native JSON retains its existing format/profile compatibility checks.
      if (!localOnly && !targetIsGeneric && !activeDataIsGeneric) {
        assertDashboardDataCompatibility({
          htmlVersionId: input.versionId,
          htmlSnapshotFormat: input.expectedSnapshotFormat,
          htmlProfile: input.expectedProfile,
          dataSnapshotFormat: dataState.snapshot_format,
          dataProfile: dataState.dashboard_profile,
          dataBoundHtmlVersionId: activeDataBinding,
          action: 'html',
        });
      }
    }

    await initializeDashboardDataContexts(client, input.blockId);
    const targetContext = localOnly ? null : (await client.query<TopDashboardStateRow>(
      `select active_version_id::text, previous_version_id::text
       from top_dashboard_block_data_context_state
       where block_id = $1 and context_key = $2`,
      [input.blockId, dashboardDataContextKey(input.expectedSnapshotFormat!, input.expectedProfile!, input.versionId)],
    )).rows[0];
    // A local-only report has no shared data pointers/context. The previous
    // report's saved pair stays intact for rollback, just as for generic HTML.
    await client.query(
      `update top_dashboard_block_data_state
       set active_version_id = $2, previous_version_id = $3,
           updated_by_admin_user_id = $4, updated_by_manager_id = $5, updated_at = now()
       where block_id = $1`,
      [input.blockId, numericId(targetContext?.active_version_id),
        numericId(targetContext?.previous_version_id), input.adminUserId, input.managerId],
    );
    // A legacy already-active local report may still have shared pointers.
    // Detach them without changing the HTML rollback pair or deleting history.
    if (unchanged) return unchangedResult;

    await client.query(
      `update top_dashboard_block_versions
       set first_published_at = coalesce(first_published_at, now()),
           first_published_by_admin_user_id = case
             when first_published_at is null then $3
             else first_published_by_admin_user_id
           end,
           first_published_by_manager_id = case
             when first_published_at is null then $4
             else first_published_by_manager_id
           end
       where block_id = $1 and id = $2`,
      [input.blockId, input.versionId, input.adminUserId, input.managerId],
    );

    const updatedStateResult = await client.query<TopDashboardStateRow>(
      `update top_dashboard_block_state
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

    const pruned = await pruneDashboardDataVersions(client, input.blockId);
    await pruneDashboardPublishedHtml(client, input.blockId);

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
      prunedStoragePaths: pruned.prunedStoragePaths,
    };
  });
}
