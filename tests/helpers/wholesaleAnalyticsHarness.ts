import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const directory = fileURLToPath(new URL('../../src/shared/lib/db/wholesaleAdminRepo/', import.meta.url));
const fixedTime = Date.parse('2026-10-23T12:00:00Z');
class FixedDate extends Date {
  constructor(value?: string | number) { super(value === undefined ? fixedTime : value); }
  static now() { return fixedTime; }
}

// Follow only this repository's analytics modules. No production database,
// environment loader or session implementation can be imported by these tests.
export function loadAnalyticsModule<T>(name: string, query: (sql: string, params?: unknown[]) => Promise<unknown>,
  options: { ensureSiteSchema?: () => Promise<void>; assertClientCompanyVisible?: (...args: unknown[]) => Promise<void> } = {}): T {
  const cache = new Map<string, { exports: unknown }>();
  const load = (filename: string): unknown => {
    if (cache.has(filename)) return cache.get(filename)!.exports;
    const loadedModule = { exports: {} };
    cache.set(filename, loadedModule);
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const require = (specifier: string): unknown => {
      if (specifier === '@/shared/lib/adminAuth') return { isManagerSessionRole: (role: string) => ['manager', 'support_manager'].includes(role) };
      const resolved = specifier.startsWith('@/')
        ? path.resolve(directory, '../../../../', specifier.slice(2)) + '.ts'
        : path.resolve(path.dirname(filename), specifier) + '.ts';
      if (resolved === path.resolve(directory, '../client.ts')) return { query };
      if (resolved === path.resolve(directory, '../schema.ts')) return { ensureSiteSchema: options.ensureSiteSchema ?? (async () => {}) };
      if (resolved === path.resolve(directory, '../clientCompaniesRepo.ts')) return { assertClientCompanyVisible: options.assertClientCompanyVisible ?? (async () => {}) };
      assert.ok(
        (resolved.startsWith(directory) && /(?:[Aa]nalytics|managerHelpers)/.test(resolved)) ||
        resolved === path.resolve(directory, '../../wholesalePriceWorkflowStatus.ts'),
        `Unexpected analytics dependency: ${specifier} (${resolved})`,
      );
      return load(resolved);
    };
    new Function('require', 'module', 'exports', 'Date', code)(require, loadedModule, loadedModule.exports, FixedDate);
    return loadedModule.exports;
  };
  return load(path.join(directory, name + '.ts')) as T;
}

const manager = { id: '9', name: 'Synthetic manager', login: 'synthetic', email: 'test@example.invalid', phone: '', role: 'support_manager', is_active: true, last_login_at: '2026-10-22T10:00:00Z' };
const price = {
  id: '101', title: 'Active price', client_name: 'Client A', token: 'synthetic-token', manager_id: '9', manager_name: manager.name,
  valid_until: '2026-10-27', workflow_status: 'sent', is_active: true,
  created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T11:00:00Z', item_count: '4',
  views: '5', views_last_7_days: '3', views_last_30_days: '4', views_period: '2', last_view_at: '2026-10-23T10:00:00Z', unique_visitors: '2', repeat_views: '2',
  pdf_downloads: '2', pdf_last_7_days: '1', pdf_last_30_days: '2', pdf_period: '1', unique_downloaders: '1', last_pdf_at: '2026-10-22T10:00:00Z',
  excel_downloads: '3', excel_last_7_days: '2', excel_last_30_days: '3', excel_period: '2', unique_excel_downloaders: '2', last_excel_at: '2026-10-23T11:00:00Z',
  requests_sent: '1', requests_period: '1', last_request_at: '2026-10-23T11:30:00Z', first_view_at: '2026-10-20T12:00:00Z', first_pdf_at: '2026-10-20T13:00:00Z', first_request_at: '2026-10-21T10:00:00Z',
  last_manager_activity_at: '2026-10-22T09:00:00Z', last_client_event_type: 'public_price_request_sent', change_count: '3', last_changed_at: '2026-10-22T09:00:00Z', last_changed_by: 'Synthetic manager',
};
const prices = [price,
  { ...price, id: '102', title: 'Expired price', client_name: 'Client A', is_active: false, valid_until: '2026-10-01', workflow_status: 'negotiation', created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-02T10:00:00Z', item_count: '2', views: '0', pdf_downloads: '0', requests_sent: '0', views_period: '0', pdf_period: '0', requests_period: '0', last_view_at: null, last_pdf_at: null, last_excel_at: null, last_request_at: null },
  { ...price, id: '103', title: 'Empty price', client_name: ' ', manager_id: null, manager_name: 'Не назначен', valid_until: null, item_count: '0', workflow_status: 'not_sent', views: '0', pdf_downloads: '0', requests_sent: '0', last_manager_activity_at: null },
  { ...price, id: '104', title: 'Confirmed price', client_name: 'Client B', manager_id: '10', manager_name: 'Second manager', workflow_status: 'confirmed', valid_until: '2026-12-01', item_count: '10', created_at: '2026-10-01T10:00:00Z' },
];
const activity = { actions_last_7_days: '5', actions_last_30_days: '9', actions_period: '4', logins_last_7_days: '2', logins_last_30_days: '7', logins_period: '3', active_days_period: '3', active_managers_period: '1', created_prices: '3', updated_prices: '5', activated_prices: '1', deactivated_prices: '2', deleted_prices: '1' };
const events = ['public_price_opened', 'public_price_pdf_downloaded', 'public_price_excel_downloaded', 'price_updated', 'public_price_phone_clicked'].map((event_type, i) => ({
  id: String(500 + i), event_type, actor_type: event_type.startsWith('public_') ? 'client' : 'manager', manager_id: '9', manager_name: manager.name, price_id: '101', price_title: price.title, client_id: 'client a', client_name: 'Client A', created_at: '2026-10-23T10:00:00Z', details: null, session_id: null, referer: null,
}));
const change = { id: '30', price_id: '101', price_title: '', action: 'edit', changed_by: null, created_at: '2026-10-22T10:00:00Z', details: null };
const baseRows = [
  [manager], [{ total_prices: '4', active_prices: '3', expired_prices: '1', prices_last_7_days: '2', prices_last_30_days: '3', period_prices: '2', average_items_per_price: '4', empty_prices: '1', prices_without_client: '1', prices_without_expiration: '1' }],
  [{ id: '104', title: '', created_at: '2026-10-22T10:00:00Z' }], [change], [change], [prices[2]],
  [{ total: '12', last_7_days: '5', last_30_days: '10', period_views: '6', last_view_at: '2026-10-23T10:00:00Z' }], [{ price_id: '101', title: price.title, views: '5', last_view_at: price.last_view_at }],
];
const supplementalRows = [
  [{ product_title: 'Product A', product_id: '42', opens: '3', quantity_changes: '2', requests: '1', last_activity_at: '2026-10-23T10:00:00Z' }, { product_title: 'Product B', product_id: null, opens: '0', quantity_changes: '0', requests: '1', last_activity_at: null }],
  [{ current_prices: '4', previous_prices: '2', current_views: '0', previous_views: '0', current_pdf: '2', previous_pdf: '0', current_requests: '1', previous_requests: '2' }],
];

export type AnalyticsScenario = 'admin' | 'manager' | 'extended';
export async function runAnalyticsScenario(scenario: AnalyticsScenario, period: '7d' | '30d' | 'all', empty = false) {
  const views24 = [{ client_id: 'client a', views: '3' }, { client_id: 'unknown', views: '9' }];
  const rows = scenario === 'admin' ? [
    [manager, { ...manager, id: '10', name: 'Second manager', is_active: false, last_login_at: null }], prices, [activity],
    [{ manager_id: '9', actions_period: '4', logins_period: '3', active_days_period: '3', last_action_at: '2026-10-22T10:00:00Z' }],
    [{ manager_id: '9', manager_name: manager.name, created_at: '2026-10-22T10:00:00Z' }], [events[3]], events, views24,
    ...supplementalRows,
  ] : [...baseRows, ...(scenario === 'extended' ? [prices, [activity], events, views24, ...supplementalRows] : [])];
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const timeline: string[] = [];
  const query = async (sql: string, params?: unknown[]) => {
    const index = calls.length;
    assert.ok(index < rows.length, 'Unexpected extra query');
    calls.push({ sql, ...(params === undefined ? {} : { params }) });
    timeline.push(`start:${index}`);
    await Promise.resolve();
    timeline.push(`end:${index}`);
    return { rows: empty ? [] : structuredClone(rows[index]) };
  };
  const repository = loadAnalyticsModule<typeof import('../../src/shared/lib/db/wholesaleAdminRepo/analyticsRepo')>('analyticsRepo', query, {
    ensureSiteSchema: async () => { timeline.push('schema'); },
  });
  const result = scenario === 'admin' ? await repository.getWholesaleAdminAnalytics(period)
    : scenario === 'manager' ? await repository.getWholesaleManagerAnalytics(9, period)
      : await repository.getWholesaleManagerAnalyticsExtended(9, period);
  return { result, calls, timeline };
}
