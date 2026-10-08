/** A single shared pair, not two arbitrary report URLs supplied by a visitor. */
export type DashboardPairConfig = {
  keys: [string, string];
  layout: 'columns' | 'rows';
  revision: number;
  views?: [DashboardPairView, DashboardPairView];
};

export type DashboardPairView = 'default' | 'sales-office';

/** Do not guess an ID when a renamed/duplicated report makes the match ambiguous. */
export function defaultOfficeDashboardPair(reports: Array<{id: number; title: string}>): DashboardPairConfig | null {
  const sales = reports.filter((item) => item.title.trim().toLocaleLowerCase('ru-RU') === 'аналитика продаж');
  if (sales.length !== 1) return null;
  return {keys:['currency-rates', `top:${sales[0].id}`], views:['default', 'sales-office'], layout:'columns', revision:0};
}

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
  const keys = candidate.keys;
  if (candidate.views !== undefined && (!Array.isArray(candidate.views) || candidate.views.length !== 2
    || candidate.views.some((view, index) => !['default', 'sales-office'].includes(view)
      || (view === 'sales-office' && !keys[index].startsWith('top:'))))) return null;
  return { keys: [candidate.keys[0], candidate.keys[1]], layout: candidate.layout as DashboardPairConfig['layout'], revision: Number(candidate.revision),
    ...(candidate.views ? {views: candidate.views as DashboardPairConfig['views']} : {}) };
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
  view?: DashboardPairView;
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
