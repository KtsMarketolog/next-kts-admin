/** A single shared pair, not two arbitrary report URLs supplied by a visitor. */
export type DashboardPairConfig = {
  keys: [string, string];
  layout: 'columns' | 'rows';
  revision: number;
};

export function isPairReportKey(value: unknown): value is string {
  return typeof value === 'string' && (value === 'currency-rates' || value === 'route-planner'
    || (/^top:[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.slice(4)))));
}

export function parseDashboardPairConfig(value: unknown): DashboardPairConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.keys) || candidate.keys.length !== 2
    || !candidate.keys.every(isPairReportKey) || candidate.keys[0] === candidate.keys[1]
    || !['columns', 'rows'].includes(String(candidate.layout))
    || !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 0) return null;
  return { keys: [candidate.keys[0], candidate.keys[1]], layout: candidate.layout as DashboardPairConfig['layout'], revision: Number(candidate.revision) };
}

export type DashboardPairPanel = {
  key: string;
  title: string;
  available: boolean;
  kind?: 'top' | 'route-planner' | 'currency';
  versionId?: number;
  snapshotId?: number;
  reportRevision?: string;
  dataUploadedAt?: string | null;
  dataAsOf?: string | null;
  message?: string;
};

export type DashboardPairOverview = {
  canConfigure: boolean;
  configured: boolean;
  revision: number;
  layout: DashboardPairConfig['layout'];
  panels: DashboardPairPanel[];
  settings?: DashboardPairConfig | null;
  options?: Array<{ key: string; title: string }>;
};
