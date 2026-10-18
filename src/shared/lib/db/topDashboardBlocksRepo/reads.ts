import {
  TopDashboardBlockDataStateNotFoundError,
  TopDashboardBlockDataVersionNotFoundError,
  type TopDashboardBlockDataVersionContent,
  type TopDashboardProfile,
  type TopDashboardSnapshotFormat,
  type TopDashboardVersionContent,
} from '../topDashboardDomain';
import { ensureSiteSchema } from '../schema';
import {
  mapBlock,
  mapBlockSummary,
  mapDataVersion,
  mapVersion,
  numericId,
  requireBlock,
  type TopDashboardBlockDataVersionRow,
  type TopDashboardBlockSummaryRow,
  type TopDashboardStateRow,
  type TopDashboardVersionRow,
} from './records';
import { query } from '../client';
import type { TopDashboardBlockOverview, TopDashboardBlockSummary } from './types';

export async function getTopDashboardBlocks(): Promise<TopDashboardBlockSummary[]> {
  await ensureSiteSchema();

  const result = await query<TopDashboardBlockSummaryRow>(`
    select
      blocks.id::text,
      blocks.title,
      blocks.created_at::text,
      native_state.active_version_id::text as active_version_id,
      native_active.original_name as active_original_name,
      (
        select count(*)::text
        from top_dashboard_block_versions versions
        where versions.block_id = blocks.id
      ) as version_count,
      greatest(native_state.updated_at, native_data_state.updated_at)::text as updated_at,
      native_active_data.created_at::text as data_uploaded_at,
      native_active_data.data_as_of,
      native_active.first_published_at::text as html_published_at
    from top_dashboard_blocks blocks
    left join top_dashboard_block_state native_state
      on native_state.block_id = blocks.id
    left join top_dashboard_block_versions native_active
      on native_active.block_id = blocks.id and native_active.id = native_state.active_version_id
    left join top_dashboard_block_data_state native_data_state on native_data_state.block_id = blocks.id
    left join top_dashboard_block_data_versions native_active_data
      on native_active_data.block_id = blocks.id and native_active_data.id = native_data_state.active_version_id
    order by blocks.created_at asc, blocks.id asc
  `);

  return result.rows.map(mapBlockSummary);
}

export async function getTopDashboardBlockOverview(
  blockId: number,
): Promise<TopDashboardBlockOverview> {
  await ensureSiteSchema();

  const blockRow = await requireBlock(blockId);
  const block = mapBlock(blockRow);

  const [stateResult, versionsResult, dataStateResult, dataVersionsResult] = await Promise.all([
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
         coalesce(admin_uploader.name, manager_uploader.name) as uploaded_by_name,
         coalesce(admin_publisher.name, manager_publisher.name) as first_published_by_name,
         versions.first_published_at::text,
         versions.created_at::text
       from top_dashboard_block_versions versions
       left join admin_users admin_uploader
         on admin_uploader.id = versions.uploaded_by_admin_user_id
       left join wholesale_managers manager_uploader
         on manager_uploader.id = versions.uploaded_by_manager_id
       left join admin_users admin_publisher
         on admin_publisher.id = versions.first_published_by_admin_user_id
       left join wholesale_managers manager_publisher
         on manager_publisher.id = versions.first_published_by_manager_id
       where versions.block_id = $1
       order by versions.created_at desc, versions.id desc`,
      [blockId],
    ),
    query<TopDashboardStateRow>(
      `select active_version_id::text, previous_version_id::text, updated_at::text
       from top_dashboard_block_data_state
       where block_id = $1
       limit 1`,
      [blockId],
    ),
    query<TopDashboardBlockDataVersionRow>(
      `select
         versions.id::text,
         versions.original_name,
         versions.file_size::text,
         versions.uncompressed_size::text,
         versions.data_as_of,
         versions.sha256,
         versions.snapshot_format,
         versions.dashboard_profile,
         versions.bound_html_version_id::text,
         coalesce(admin_uploader.name, manager_uploader.name) as uploaded_by_name,
         versions.created_at::text
       from top_dashboard_block_data_versions versions
       left join admin_users admin_uploader
         on admin_uploader.id = versions.uploaded_by_admin_user_id
       left join wholesale_managers manager_uploader
         on manager_uploader.id = versions.uploaded_by_manager_id
       where versions.block_id = $1
       order by versions.created_at desc, versions.id desc`,
      [blockId],
    ),
  ]);
  const state = stateResult.rows[0];
  const activeVersionId = numericId(state?.active_version_id);
  const dataState = dataStateResult.rows[0];
  const activeDataVersionId = numericId(dataState?.active_version_id);
  const previousDataVersionId = numericId(dataState?.previous_version_id);

  return {
    block,
    activeVersionId,
    previousVersionId: numericId(state?.previous_version_id),
    updatedAt: state?.updated_at ?? null,
    versions: versionsResult.rows.map((row) => mapVersion(row, activeVersionId)),
    data: {
      activeVersionId: activeDataVersionId,
      previousVersionId: previousDataVersionId,
      updatedAt: dataState?.updated_at ?? null,
      versions: dataVersionsResult.rows.map((row) =>
        mapDataVersion(row, activeDataVersionId, previousDataVersionId),
      ),
    },
  };
}

export async function getActiveTopDashboardBlockDataContent(
  blockId: number,
  expectedHtmlVersionId?: number,
): Promise<TopDashboardBlockDataVersionContent | null> {
  await ensureSiteSchema();

  await requireBlock(blockId);

  const result = await query<{
    active_version_id: string | null;
    active_html_version_id: string | null;
    id: string | null;
    original_name: string | null;
    compressed_payload: Buffer | null;
    storage_path: string | null;
    file_size: string | null;
    uncompressed_size: string | null;
    sha256: string | null;
    snapshot_format: TopDashboardSnapshotFormat | null;
    dashboard_profile: TopDashboardProfile | null;
    bound_html_version_id: string | null;
    created_at: string | null;
  }>(
    `select
       state.active_version_id::text,
       html_state.active_version_id::text as active_html_version_id,
       versions.id::text,
       versions.original_name,
       case
         when versions.storage_path is null then versions.compressed_payload
         else null
       end as compressed_payload,
       versions.storage_path,
       versions.file_size::text,
       versions.uncompressed_size::text,
       versions.sha256,
       versions.snapshot_format,
       versions.dashboard_profile,
       versions.bound_html_version_id::text,
       versions.created_at::text
     from top_dashboard_block_data_state state
     join top_dashboard_block_state html_state
       on html_state.block_id = state.block_id
     left join top_dashboard_block_data_versions versions
       on versions.block_id = state.block_id
      and versions.id = state.active_version_id
     where state.block_id = $1
     limit 1`,
    [blockId],
  );
  const row = result.rows[0];
  if (!row) throw new TopDashboardBlockDataStateNotFoundError();
  if (row.active_version_id === null) return null;
  if (
    row.id === null
    || row.original_name === null
    || row.file_size === null
    || row.uncompressed_size === null
    || row.sha256 === null
    || row.snapshot_format === null
    || row.dashboard_profile === null
    || row.created_at === null
  ) {
    throw new TopDashboardBlockDataVersionNotFoundError();
  }
  if ((row.compressed_payload === null) === (row.storage_path === null)) {
    throw new TopDashboardBlockDataVersionNotFoundError();
  }

  const boundHtmlVersionId = numericId(row.bound_html_version_id);
  if (row.snapshot_format === 'multi-file-v1') {
    const activeHtmlVersionId = numericId(row.active_html_version_id);
    if (
      row.dashboard_profile !== 'generic'
      || boundHtmlVersionId === null
      || boundHtmlVersionId !== activeHtmlVersionId
      || (
        expectedHtmlVersionId !== undefined
        && boundHtmlVersionId !== expectedHtmlVersionId
      )
    ) {
      return null;
    }
  } else if (boundHtmlVersionId !== null) {
    return null;
  }

  return {
    id: Number(row.id),
    originalName: row.original_name,
    content: row.compressed_payload,
    storagePath: row.storage_path,
    fileSize: Number(row.file_size),
    uncompressedSize: Number(row.uncompressed_size),
    sha256: row.sha256,
    snapshotFormat: row.snapshot_format,
    dashboardProfile: row.dashboard_profile,
    boundHtmlVersionId,
    createdAt: row.created_at,
  };
}

/** Report-level callers must check the exact block's viewing permission first. */
export async function getActiveTopDashboardBlockHtmlContent(blockId: number): Promise<string | null> {
  await ensureSiteSchema();
  const result = await query<{ html_content: string }>(
    `select version.html_content
     from top_dashboard_block_state state
     join top_dashboard_block_versions version
       on version.block_id = state.block_id and version.id = state.active_version_id
     where state.block_id = $1 limit 1`,
    [blockId],
  );
  return result.rows[0]?.html_content ?? null;
}

export async function getTopDashboardBlockVersionContent(
  blockId: number,
  versionId: number,
): Promise<TopDashboardVersionContent | null> {
  await ensureSiteSchema();

  await requireBlock(blockId);

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
