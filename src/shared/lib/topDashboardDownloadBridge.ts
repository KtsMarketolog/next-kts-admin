export const TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER = 'kts-top-dashboard-download-v1';
export const TOP_DASHBOARD_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const TOP_DASHBOARD_DOWNLOAD_MAX_NAME_LENGTH = 255;
export const TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE = String.raw`\.(?:xlsx|xls|csv|json(?:\.gz)?|html?)$`;
export const TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE = String.raw`[\/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]`;

const DOWNLOAD_NAME_PATTERN = new RegExp(TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE, 'i');
const INVALID_DOWNLOAD_NAME_PATTERN = new RegExp(
  TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE,
  'i',
);

export type TopDashboardDownloadMessage = {
  marker: typeof TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER;
  type: 'download-request';
  name: string;
  blob: Blob;
};

export function normalizeTopDashboardDownloadName(value: unknown) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim();
  if (
    name.length === 0
    || name.length > TOP_DASHBOARD_DOWNLOAD_MAX_NAME_LENGTH
    || name === '.'
    || name === '..'
    || INVALID_DOWNLOAD_NAME_PATTERN.test(name)
    || !DOWNLOAD_NAME_PATTERN.test(name)
  ) {
    return null;
  }
  return name;
}

export function isTopDashboardDownloadBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined'
    && value instanceof Blob
    && value.size > 0
    && value.size <= TOP_DASHBOARD_DOWNLOAD_MAX_BYTES;
}

export function readTopDashboardDownloadMessage(value: unknown): TopDashboardDownloadMessage | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TopDashboardDownloadMessage>;
  if (
    candidate.marker !== TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER
    || candidate.type !== 'download-request'
  ) {
    return null;
  }
  const name = normalizeTopDashboardDownloadName(candidate.name);
  if (!name || !isTopDashboardDownloadBlob(candidate.blob)) return null;
  return {
    marker: TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER,
    type: 'download-request',
    name,
    blob: candidate.blob,
  };
}

export function getTopDashboardDownloadMimeType(name: string) {
  const normalizedName = name.toLowerCase();
  if (normalizedName.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (normalizedName.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (normalizedName.endsWith('.csv')) return 'text/csv;charset=utf-8';
  if (normalizedName.endsWith('.json.gz')) return 'application/gzip';
  if (normalizedName.endsWith('.json')) return 'application/json;charset=utf-8';
  return 'text/html;charset=utf-8';
}
