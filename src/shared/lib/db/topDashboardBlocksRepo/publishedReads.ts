import { ensureSiteSchema } from '../schema';
import { detectTopDashboardDataContract } from '../../topDashboardContentSecurity';
import { query } from '../client';
import type { TopDashboardPublishedBlockOverview, TopDashboardPublishedBlockSummary } from './types';
import type { TopDashboardPublishedBlockRow } from './records';
import type { TopDashboardVersionContent } from '../topDashboardDomain';

export function publishedBlockReady(row: TopDashboardPublishedBlockRow) {
  return row.has_compatible_data
    || (typeof row.self_contained_html === 'string' && selfContainedHtmlReady(row.self_contained_html));
}

function selfContainedHtmlReady(html: string) {
  const contract = detectTopDashboardDataContract(html);
  return contract.mode === 'disabled' && contract.snapshotFormat === null
    && (contract.profile === 'profitability' || contract.profile === 'standalone');
}

export async function getPublishedTopDashboardBlocks(): Promise<TopDashboardPublishedBlockSummary[]> {
  await ensureSiteSchema();

  const result = await query<TopDashboardPublishedBlockRow>(`
    select
      blocks.id::text,
      blocks.title,
      blocks.created_at::text,
      native_state.active_version_id::text as active_version_id,
      greatest(native_state.updated_at, native_data_state.updated_at)::text as updated_at,
      native_active_data.created_at::text as data_uploaded_at,
      native_active_data.data_as_of,
      native_active.first_published_at::text as html_published_at,
      native_active_data.id is not null as has_compatible_data,
      case when native_active_data.id is null then native_active.html_content end as self_contained_html
    from top_dashboard_blocks blocks
    join top_dashboard_block_state native_state
      on native_state.block_id = blocks.id
     and native_state.active_version_id is not null
    join top_dashboard_block_versions native_active
      on native_active.block_id = blocks.id
     and native_active.id = native_state.active_version_id
    left join top_dashboard_block_data_state native_data_state
      on native_data_state.block_id = blocks.id
     and native_data_state.active_version_id is not null
    left join top_dashboard_block_data_versions native_active_data
      on native_active_data.block_id = blocks.id
     and native_active_data.id = native_data_state.active_version_id
     and (
       (
         native_active_data.snapshot_format = 'multi-file-v1'
         and native_active_data.dashboard_profile = 'generic'
         and native_active_data.bound_html_version_id = native_state.active_version_id
       )
       or (
         native_active_data.snapshot_format <> 'multi-file-v1'
         and native_active_data.bound_html_version_id is null
       )
     )
    order by blocks.created_at asc, blocks.id asc
  `);

  return result.rows.filter(publishedBlockReady).map((row) => ({
    id: Number(row.id),
    title: row.title,
    activeVersionId: Number(row.active_version_id),
    updatedAt: row.updated_at,
    dataUploadedAt: row.data_uploaded_at ?? null,
    dataAsOf: row.data_as_of ?? null,
    htmlPublishedAt: row.html_published_at ?? null,
  }));
}

export async function getPublishedTopDashboardBlockOverview(
  blockId: number,
): Promise<TopDashboardPublishedBlockOverview | null> {
  await ensureSiteSchema();

  const result = await query<TopDashboardPublishedBlockRow>(
    `select
       blocks.id::text,
       blocks.title,
       blocks.created_at::text,
       native_state.active_version_id::text as active_version_id,
       greatest(native_state.updated_at, native_data_state.updated_at)::text as updated_at,
       native_active_data.created_at::text as data_uploaded_at,
       native_active_data.data_as_of,
       native_active.first_published_at::text as html_published_at,
       native_active_data.id is not null as has_compatible_data,
       case when native_active_data.id is null then native_active.html_content end as self_contained_html
     from top_dashboard_blocks blocks
     join top_dashboard_block_state native_state
       on native_state.block_id = blocks.id
      and native_state.active_version_id is not null
     join top_dashboard_block_versions native_active
       on native_active.block_id = blocks.id
      and native_active.id = native_state.active_version_id
     left join top_dashboard_block_data_state native_data_state
       on native_data_state.block_id = blocks.id
      and native_data_state.active_version_id is not null
     left join top_dashboard_block_data_versions native_active_data
       on native_active_data.block_id = blocks.id
      and native_active_data.id = native_data_state.active_version_id
      and (
        (
          native_active_data.snapshot_format = 'multi-file-v1'
          and native_active_data.dashboard_profile = 'generic'
          and native_active_data.bound_html_version_id = native_state.active_version_id
        )
        or (
          native_active_data.snapshot_format <> 'multi-file-v1'
          and native_active_data.bound_html_version_id is null
        )
      )
     where blocks.id = $1
     limit 1`,
    [blockId],
  );
  const row = result.rows[0];
  if (!row || !publishedBlockReady(row)) return null;

  return {
    block: {
      id: Number(row.id),
      title: row.title,
      createdAt: row.created_at,
    },
    activeVersionId: Number(row.active_version_id),
    updatedAt: row.updated_at,
    dataUploadedAt: row.data_uploaded_at ?? null,
    dataAsOf: row.data_as_of ?? null,
    htmlPublishedAt: row.html_published_at ?? null,
  };
}

/** Publication only: callers must separately verify a supported self-contained HTML profile. */
export async function isActiveTopDashboardHtmlVersion(blockId: number, versionId: number): Promise<boolean> {
  if (!Number.isSafeInteger(blockId) || blockId < 1 || !Number.isSafeInteger(versionId) || versionId < 1) return false;
  await ensureSiteSchema();
  const result = await query<{ found: number }>(`
    select 1 as found from top_dashboard_block_state state
    join top_dashboard_block_versions version
      on version.block_id = state.block_id and version.id = state.active_version_id
    where state.block_id = $1 and state.active_version_id = $2 limit 1`, [blockId, versionId]);
  return Boolean(result.rows[0]);
}

export async function isPublishedTopDashboardBlockVersion(
  blockId: number,
  versionId: number,
): Promise<boolean> {
  await ensureSiteSchema();

  const result = await query<{ found: number }>(
    `select 1 as found
     from top_dashboard_block_state state
     join top_dashboard_block_versions versions
       on versions.block_id = state.block_id
      and versions.id = state.active_version_id
     join top_dashboard_block_data_state data_state
       on data_state.block_id = state.block_id
      and data_state.active_version_id is not null
     join top_dashboard_block_data_versions data_versions
       on data_versions.block_id = state.block_id
      and data_versions.id = data_state.active_version_id
      and (
        (
          data_versions.snapshot_format = 'multi-file-v1'
          and data_versions.dashboard_profile = 'generic'
          and data_versions.bound_html_version_id = state.active_version_id
        )
        or (
          data_versions.snapshot_format <> 'multi-file-v1'
          and data_versions.bound_html_version_id is null
        )
      )
     where state.block_id = $1
       and state.active_version_id = $2
     limit 1`,
    [blockId, versionId],
  );
  return Boolean(result.rows[0]);
}

export async function getPublishedTopDashboardBlockVersionContent(
  blockId: number,
  versionId: number,
): Promise<TopDashboardVersionContent | null> {
  await ensureSiteSchema();

  const result = await query<{
    id: string;
    original_name: string;
    html_content: string;
    file_size: string;
    sha256: string;
    has_compatible_data: boolean;
  }>(
    `select
       versions.id::text,
       versions.original_name,
       versions.html_content,
       versions.file_size::text,
       versions.sha256,
       data_versions.id is not null as has_compatible_data
     from top_dashboard_block_state state
     join top_dashboard_block_versions versions
       on versions.block_id = state.block_id
      and versions.id = state.active_version_id
     left join top_dashboard_block_data_state data_state
       on data_state.block_id = state.block_id
      and data_state.active_version_id is not null
     left join top_dashboard_block_data_versions data_versions
       on data_versions.block_id = state.block_id
      and data_versions.id = data_state.active_version_id
      and (
        (
          data_versions.snapshot_format = 'multi-file-v1'
          and data_versions.dashboard_profile = 'generic'
          and data_versions.bound_html_version_id = state.active_version_id
        )
        or (
          data_versions.snapshot_format <> 'multi-file-v1'
          and data_versions.bound_html_version_id is null
        )
      )
     where state.block_id = $1
       and state.active_version_id = $2
     limit 1`,
    [blockId, versionId],
  );
  const row = result.rows[0];
  if (!row || (!row.has_compatible_data && !selfContainedHtmlReady(row.html_content))) return null;

  return {
    id: Number(row.id),
    originalName: row.original_name,
    htmlContent: row.html_content,
    fileSize: Number(row.file_size),
    sha256: row.sha256,
  };
}
