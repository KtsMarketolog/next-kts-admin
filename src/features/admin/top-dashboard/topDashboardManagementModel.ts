import { normalizeTopDashboardUploadTargets, type TopDashboardUploadTarget } from './topDashboardUploadSelection';

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

export type TopDashboardDataVersionStatus = 'active' | 'previous' | 'archived';
export type TopDashboardSnapshotFormat = 'kts-bundle-v1' | 'purchases-v1' | 'multi-file-v1';
export type TopDashboardIntegrationMode = 'standalone' | 'connected';

export type TopDashboardDataVersion = {
  id: number;
  originalName: string;
  fileSize: number;
  uncompressedSize: number;
  sha256: string;
  snapshotFormat: TopDashboardSnapshotFormat;
  boundHtmlVersionId: number | null;
  status: TopDashboardDataVersionStatus;
  uploadedByName: string;
  createdAt: string;
  dataAsOf?: string | null;
};

export type TopDashboardDataOverview = {
  activeVersionId: number | null;
  previousVersionId: number | null;
  updatedAt: string | null;
  versions: TopDashboardDataVersion[];
};

export type TopDashboardDataContract = {
  htmlVersionId: number | null;
  mode: 'legacy' | 'generic' | 'disabled';
  snapshotFormat: TopDashboardSnapshotFormat | null;
  profile: 'sales-analytics' | 'assortment-optimization' | 'purchases' | 'generic' | 'profitability' | 'standalone' | null;
  directUploadTarget: {
    id: string | null;
    name: string | null;
    index: number;
  } | null;
  uploadTargets: TopDashboardUploadTarget[];
};

export type TopDashboardOverview = {
  block: {
    id: number;
    title: string;
    createdAt: string;
  };
  activeVersionId: number | null;
  previousVersionId: number | null;
  updatedAt: string | null;
  versions: TopDashboardVersion[];
  data: TopDashboardDataOverview;
  activeDataContract: TopDashboardDataContract;
  instruction: 'sales-analytics' | null;
};

export async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

export function defaultTopDashboardIntegrationMode(overview: TopDashboardOverview | null): TopDashboardIntegrationMode {
  return overview?.activeDataContract.mode === 'legacy' || overview?.activeDataContract.mode === 'generic'
    ? 'connected' : 'standalone';
}

export function normalizeTopDashboardDataContract(value: unknown): TopDashboardDataContract {
  const disabled: TopDashboardDataContract = {
    htmlVersionId: null,
    mode: 'disabled',
    snapshotFormat: null,
    profile: null,
    directUploadTarget: null,
    uploadTargets: [],
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return disabled;
  const source = value as Record<string, unknown>;
  const htmlVersionId = Number.isSafeInteger(source.htmlVersionId)
    && Number(source.htmlVersionId) > 0
    ? Number(source.htmlVersionId)
    : null;
  if (source.mode === 'disabled') return { ...disabled, htmlVersionId,
    profile: source.profile === 'profitability' ? 'profitability'
      : source.profile === 'standalone' || source.profile === 'profitability-unsupported' ? 'standalone' : null };
  if (
    source.mode === 'legacy'
    && (source.snapshotFormat === 'kts-bundle-v1' || source.snapshotFormat === 'purchases-v1')
    && (
      source.profile === 'sales-analytics'
      || source.profile === 'assortment-optimization'
      || source.profile === 'purchases'
    )
  ) {
    return {
      htmlVersionId,
      mode: 'legacy',
      snapshotFormat: source.snapshotFormat,
      profile: source.profile,
      directUploadTarget: null,
      uploadTargets: [],
    };
  }
  if (
    source.mode !== 'generic'
    || source.snapshotFormat !== 'multi-file-v1'
    || source.profile !== 'generic'
  ) {
    return disabled;
  }
  const rawTarget = source.directUploadTarget;
  const directUploadTarget = rawTarget
    && typeof rawTarget === 'object'
    && !Array.isArray(rawTarget)
    && Number.isSafeInteger((rawTarget as Record<string, unknown>).index)
    && Number((rawTarget as Record<string, unknown>).index) >= 0
    && Number((rawTarget as Record<string, unknown>).index) <= 0xffff
    && (typeof (rawTarget as Record<string, unknown>).id === 'string'
      || (rawTarget as Record<string, unknown>).id === null)
    && (typeof (rawTarget as Record<string, unknown>).name === 'string'
      || (rawTarget as Record<string, unknown>).name === null)
      ? {
          id: (rawTarget as Record<string, unknown>).id as string | null,
          name: (rawTarget as Record<string, unknown>).name as string | null,
          index: Number((rawTarget as Record<string, unknown>).index),
        }
      : null;
  return {
    htmlVersionId,
    mode: 'generic',
    snapshotFormat: 'multi-file-v1',
    profile: 'generic',
    directUploadTarget,
    uploadTargets: normalizeTopDashboardUploadTargets(source.uploadTargets),
  };
}

export type UploadFeedback = { kind: 'error' | 'success'; message: string };
