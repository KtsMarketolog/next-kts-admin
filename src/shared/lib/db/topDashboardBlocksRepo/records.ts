import {
  TopDashboardBlockNotFoundError,
  type TopDashboardBlock,
  type TopDashboardBlockSummary,
} from './types';
import { query } from '../client';
import type { PoolClient } from 'pg';
import type {
  TopDashboardBlockDataVersion,
  TopDashboardBlockDataVersionStatus,
  TopDashboardProfile,
  TopDashboardSnapshotFormat,
  TopDashboardVersion,
  TopDashboardVersionStatus,
} from '../topDashboardDomain';

export type Queryable = Pick<PoolClient, 'query'>;

export type TopDashboardBlockRow = {
  id: string;
  title: string;
  created_at: string;
};

export type TopDashboardBlockSummaryRow = TopDashboardBlockRow & {
  active_version_id: string | null;
  active_original_name: string | null;
  version_count: string;
  updated_at: string;
  data_uploaded_at: string | null;
  data_as_of: string | null;
  html_published_at: string | null;
};

export type TopDashboardPublishedBlockRow = {
  id: string;
  title: string;
  created_at: string;
  active_version_id: string;
  updated_at: string;
  data_uploaded_at: string | null;
  data_as_of: string | null;
  html_published_at: string | null;
  has_compatible_data: boolean;
  self_contained_html: string | null;
};

export type TopDashboardStateRow = {
  active_version_id: string | null;
  previous_version_id: string | null;
  updated_at: string;
};

export type TopDashboardVersionRow = {
  id: string;
  original_name: string;
  file_size: string;
  sha256: string;
  uploaded_by_name: string | null;
  first_published_by_name: string | null;
  first_published_at: string | null;
  created_at: string;
};

export type TopDashboardBlockDataVersionRow = {
  id: string;
  original_name: string;
  file_size: string;
  uncompressed_size: string;
  sha256: string;
  snapshot_format: TopDashboardSnapshotFormat;
  dashboard_profile: TopDashboardProfile;
  bound_html_version_id: string | null;
  uploaded_by_name: string | null;
  created_at: string;
  data_as_of: string | null;
};

export function numericId(value: string | null | undefined) {
  return value ? Number(value) : null;
}

export function mapBlock(row: TopDashboardBlockRow): TopDashboardBlock {
  return {
    id: Number(row.id),
    title: row.title,
    createdAt: row.created_at,
  };
}

export function mapBlockSummary(row: TopDashboardBlockSummaryRow): TopDashboardBlockSummary {
  return {
    ...mapBlock(row),
    activeVersionId: numericId(row.active_version_id),
    activeOriginalName: row.active_original_name,
    versionCount: Number(row.version_count),
    updatedAt: row.updated_at,
    dataUploadedAt: row.data_uploaded_at ?? null,
    dataAsOf: row.data_as_of ?? null,
    htmlPublishedAt: row.html_published_at ?? null,
  };
}

export function mapVersion(row: TopDashboardVersionRow, activeVersionId: number | null): TopDashboardVersion {
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

export function mapDataVersion(
  row: TopDashboardBlockDataVersionRow,
  activeVersionId: number | null,
  previousVersionId: number | null,
): TopDashboardBlockDataVersion {
  const id = Number(row.id);
  const status: TopDashboardBlockDataVersionStatus =
    id === activeVersionId ? 'active' : id === previousVersionId ? 'previous' : 'archived';

  return {
    id,
    originalName: row.original_name,
    fileSize: Number(row.file_size),
    uncompressedSize: Number(row.uncompressed_size),
    dataAsOf: row.data_as_of ?? null,
    sha256: row.sha256,
    snapshotFormat: row.snapshot_format,
    dashboardProfile: row.dashboard_profile,
    boundHtmlVersionId: numericId(row.bound_html_version_id),
    status,
    uploadedByName: row.uploaded_by_name ?? '',
    createdAt: row.created_at,
  };
}

export async function findBlock(blockId: number, client?: Queryable, lock = false) {
  const db = client ?? { query };
  const result = await db.query<TopDashboardBlockRow>(
    `select id::text, title, created_at::text
     from top_dashboard_blocks
     where id = $1
     limit 1
     ${lock ? 'for update' : ''}`,
    [blockId],
  );
  return result.rows[0] ?? null;
}

export async function requireBlock(blockId: number, client?: Queryable, lock = false) {
  const block = await findBlock(blockId, client, lock);
  if (!block) throw new TopDashboardBlockNotFoundError();
  return block;
}
