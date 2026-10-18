import {
  TopDashboardBlockDataStateConflictError,
  TopDashboardBlockDataStateNotFoundError,
  TopDashboardStateConflictError,
} from '../topDashboardDomain';
import {
  TopDashboardBlockStateNotFoundError,
  type PruneTopDashboardBlockHistoryInput,
  type PruneTopDashboardBlockHistoryResult,
} from './types';
import { dashboardDataContextKey } from './dataCompatibility';
import { detectTopDashboardDataContract } from '../../topDashboardContentSecurity';
import { enqueueDashboardFilesForDeletion } from '../dashboardFileCleanupRepo';
import { initializeDashboardDataContexts } from './dataContexts';
import { numericId, requireBlock, type Queryable, type TopDashboardStateRow } from './records';
import { withTransaction } from '../client';

export async function pruneDashboardDataVersions(client: Queryable, blockId: number) {
  const retainedHtml = await client.query<{
    id: string;
    html_content: string;
    first_published_at: string | null;
  }>(
    `select versions.id::text,
       case when versions.first_published_at is not null then versions.html_content else '' end as html_content,
       versions.first_published_at::text
     from top_dashboard_block_versions versions
     join top_dashboard_block_state state on state.block_id = versions.block_id
     where versions.block_id = $1 and (
       versions.id = state.active_version_id or versions.id = state.previous_version_id
       or versions.first_published_at is null
     )`,
    [blockId],
  );
  const retainedContexts = new Set<string>();
  let preserveUnknownNativeContexts = false;
  for (const html of retainedHtml.rows) {
    // Generic data is inseparable from its exact HTML, including legacy drafts.
    retainedContexts.add(`html:${html.id}`);
    if (html.first_published_at === null) continue;
    const contract = detectTopDashboardDataContract(html.html_content);
    if (contract.snapshotFormat && contract.profile) {
      retainedContexts.add(dashboardDataContextKey(contract.snapshotFormat, contract.profile, Number(html.id)));
    } else {
      // A legacy HTML with an unrecognized contract cannot safely authorize removal.
      preserveUnknownNativeContexts = true;
    }
  }
  // Always protect the committed active pair even if an older HTML detector differs.
  await client.query(
    `delete from top_dashboard_block_data_context_state contexts
     where contexts.block_id = $1
       and not (contexts.context_key = any($2::text[]))
       and not ($3::boolean and contexts.bound_html_version_id is null)
       and not exists (
         select 1 from top_dashboard_block_data_state state
         where state.block_id = contexts.block_id
           and state.active_version_id = contexts.active_version_id
       )`,
    [blockId, [...retainedContexts], preserveUnknownNativeContexts],
  );
  // Drop obsolete legacy pointers before deleting their rows (the FKs are RESTRICT).
  await client.query(
    `update top_dashboard_block_data_state state
     set previous_version_id = null
     where state.block_id = $1 and state.previous_version_id is not null
       and not exists (
         select 1 from top_dashboard_block_data_context_state contexts
         where contexts.block_id = state.block_id and (
           contexts.active_version_id = state.previous_version_id
           or contexts.previous_version_id = state.previous_version_id
         )
       )`,
    [blockId],
  );
  const pruned = await client.query<{ id: string; storage_path: string | null }>(
    `delete from top_dashboard_block_data_versions versions
     where versions.block_id = $1
       and not exists (
         select 1 from top_dashboard_block_data_context_state contexts
         where contexts.block_id = versions.block_id and (
           contexts.active_version_id = versions.id or contexts.previous_version_id = versions.id
         )
       )
       and not exists (
         select 1 from top_dashboard_block_data_state state
         where state.block_id = versions.block_id and (
           state.active_version_id = versions.id or state.previous_version_id = versions.id
         )
       )
     returning versions.id::text, versions.storage_path`,
    [blockId],
  );
  const prunedStoragePaths = pruned.rows.flatMap((row) => row.storage_path ? [row.storage_path] : []);
  await enqueueDashboardFilesForDeletion(client, prunedStoragePaths);
  return { prunedVersionIds: pruned.rows.map((row) => Number(row.id)), prunedStoragePaths };
}

export async function pruneDashboardPublishedHtml(client: Queryable, blockId: number) {
  // Data/context cleanup runs first; bound data can then cascade without stale pointers.
  const pruned = await client.query<{ id: string }>(
    `delete from top_dashboard_block_versions versions
     using top_dashboard_block_state state
     where versions.block_id = $1 and state.block_id = versions.block_id
       and versions.first_published_at is not null
       and versions.id <> coalesce(state.active_version_id, 0)
       and versions.id <> coalesce(state.previous_version_id, 0)
     returning versions.id::text`,
    [blockId],
  );
  return pruned.rows.map((row) => Number(row.id));
}

export class TopDashboardHistoryPreviewRollback extends Error {
  constructor(readonly result: PruneTopDashboardBlockHistoryResult) {
    super('Roll back TOP dashboard history preview');
  }
}

export async function readDashboardHistoryMaintenanceSnapshot(client: Queryable, blockId: number) {
  const state = await client.query<{ snapshot: string }>(
    `select jsonb_build_object('block', to_jsonb(blocks),
       'html', to_jsonb(html_state), 'data', to_jsonb(data_state))::text as snapshot
     from top_dashboard_blocks blocks
     join top_dashboard_block_state html_state on html_state.block_id = blocks.id
     join top_dashboard_block_data_state data_state on data_state.block_id = blocks.id
     where blocks.id = $1`,
    [blockId],
  );
  const html = await client.query<{
    id: string;
    first_published_at: string | null;
    metadata: string;
  }>(
    `select id::text, first_published_at::text,
       (to_jsonb(versions) - 'html_content')::text as metadata
     from top_dashboard_block_versions versions
     where block_id = $1 order by versions.id`,
    [blockId],
  );
  const data = await client.query<{ id: string }>(
    `select id::text from top_dashboard_block_data_versions versions where block_id = $1 order by versions.id`,
    [blockId],
  );
  return { state: state.rows[0]?.snapshot, html: html.rows, data: data.rows };
}

/** Requires the deployed schema. A preview executes pruning in a rolled-back transaction. */
export async function pruneTopDashboardBlockHistory(
  input: PruneTopDashboardBlockHistoryInput,
): Promise<PruneTopDashboardBlockHistoryResult> {
  const validId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (!validId(input.blockId) || [input.expectedActiveHtmlVersionId, input.expectedPreviousHtmlVersionId,
    input.expectedActiveDataVersionId, input.expectedPreviousDataVersionId]
    .some((value) => value !== null && !validId(value))
    || (input.dryRun !== undefined && typeof input.dryRun !== 'boolean')) {
    throw new TypeError('History pruning requires a block ID and all four explicit expected version IDs');
  }
  const dryRun = input.dryRun !== false;

  try {
    return await withTransaction(async (client) => {
      await requireBlock(input.blockId, client, true);
      const htmlStateResult = await client.query<TopDashboardStateRow>(
        `select active_version_id::text, previous_version_id::text, updated_at::text
         from top_dashboard_block_state where block_id = $1 for update`,
        [input.blockId],
      );
      const htmlState = htmlStateResult.rows[0];
      if (!htmlState) throw new TopDashboardBlockStateNotFoundError();
      const dataStateResult = await client.query<TopDashboardStateRow>(
        `select active_version_id::text, previous_version_id::text, updated_at::text
         from top_dashboard_block_data_state where block_id = $1 for update`,
        [input.blockId],
      );
      const dataState = dataStateResult.rows[0];
      if (!dataState) throw new TopDashboardBlockDataStateNotFoundError();

      const activeHtmlVersionId = numericId(htmlState.active_version_id);
      const previousHtmlVersionId = numericId(htmlState.previous_version_id);
      const activeDataVersionId = numericId(dataState.active_version_id);
      const previousDataVersionId = numericId(dataState.previous_version_id);
      if (activeHtmlVersionId !== input.expectedActiveHtmlVersionId
        || previousHtmlVersionId !== input.expectedPreviousHtmlVersionId) {
        throw new TopDashboardStateConflictError(activeHtmlVersionId);
      }
      if (activeDataVersionId !== input.expectedActiveDataVersionId
        || previousDataVersionId !== input.expectedPreviousDataVersionId) {
        throw new TopDashboardBlockDataStateConflictError(activeDataVersionId);
      }

      const before = await readDashboardHistoryMaintenanceSnapshot(client, input.blockId);
      await initializeDashboardDataContexts(client, input.blockId);
      const prunedData = await pruneDashboardDataVersions(client, input.blockId);
      const prunedHtmlVersionIds = (await pruneDashboardPublishedHtml(client, input.blockId)).sort((a, b) => a - b);
      const after = await readDashboardHistoryMaintenanceSnapshot(client, input.blockId);
      const preservedHtmlVersionIds = after.html.map((row) => Number(row.id));
      const preservedDataVersionIds = after.data.map((row) => Number(row.id));
      const preservedDraftVersionIds = after.html
        .filter((row) => row.first_published_at === null).map((row) => Number(row.id));
      const prunedDataVersionIds = prunedData.prunedVersionIds.sort((a, b) => a - b);
      const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
      const retainedHtml = new Set(preservedHtmlVersionIds);
      const retainedData = new Set(preservedDataVersionIds);
      if (before.state === undefined || before.state !== after.state
        || !same(before.html.filter((row) => retainedHtml.has(Number(row.id))), after.html)
        || !same(before.html.filter((row) => row.first_published_at === null).map((row) => Number(row.id)), preservedDraftVersionIds)
        || !same(before.html.filter((row) => !retainedHtml.has(Number(row.id))).map((row) => Number(row.id)), prunedHtmlVersionIds)
        || !same(before.data.filter((row) => !retainedData.has(Number(row.id))).map((row) => Number(row.id)), prunedDataVersionIds)) {
        throw new Error('History pruning would change publication state, retained HTML or drafts; rolled back');
      }

      const result: PruneTopDashboardBlockHistoryResult = {
        blockId: input.blockId, dryRun, activeHtmlVersionId, previousHtmlVersionId,
        activeDataVersionId, previousDataVersionId, prunedHtmlVersionIds, prunedDataVersionIds,
        prunedStoragePaths: [...new Set(prunedData.prunedStoragePaths)].sort(),
        preservedHtmlVersionIds, preservedDataVersionIds, preservedDraftVersionIds,
      };
      // Throw outside the transaction callback's normal return path so preview can never COMMIT.
      if (dryRun) throw new TopDashboardHistoryPreviewRollback(result);
      return result;
    });
  } catch (error) {
    if (error instanceof TopDashboardHistoryPreviewRollback) return error.result;
    throw error;
  }
}
