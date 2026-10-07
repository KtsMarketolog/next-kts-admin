import { TokenType, type ParsedTokenInfo } from '@streamparser/json';

import { normalizeDashboardDataDate } from './dashboardDates';

const DATE_KEYS = ['dataAsOf', 'data_as_of', 'asOf', 'as_of', 'snapshotDate', 'savedAt', 'generatedAt', 'exportedAt'];
const CONTAINERS = new Set(['meta', 'metadata']);
type Container = { path: string[]; object: boolean; key: string | null; expectsKey: boolean };

/** Streaming, bounded metadata-only inspection. Row dates and filenames are not evidence of snapshot date. */
export function createDashboardSnapshotDateInspector() {
  const stack: Container[] = [];
  const dates = new Map<string, string | null>();
  const visit = ({ token, value }: ParsedTokenInfo) => {
    const parent = stack.at(-1);
    if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) { stack.pop(); return; }
    if (token === TokenType.COMMA) {
      if (parent?.object) { parent.expectsKey = true; parent.key = null; }
      return;
    }
    if (token === TokenType.COLON) return;
    if (parent?.object && parent.expectsKey && token === TokenType.STRING) {
      parent.key = typeof value === 'string' ? value : null;
      parent.expectsKey = false;
      return;
    }
    const path = parent ? [...parent.path, parent.object ? parent.key ?? '' : '*'] : [];
    if (path.length === 1 && CONTAINERS.has(path[0])) {
      for (const key of dates.keys()) if (key.startsWith(`${path[0]}.`)) dates.delete(key);
    }
    if ((path.length === 1 || (path.length === 2 && CONTAINERS.has(path[0]))) && DATE_KEYS.includes(path.at(-1)!)) {
      dates.set(path.join('.'), token === TokenType.STRING ? normalizeDashboardDataDate(value) : null);
    }
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      // Keep only small path keys; no snapshot data or financial rows are retained.
      stack.push({ path: path.length > 2 ? ['*', '*', '*'] : path, object: token === TokenType.LEFT_BRACE, key: null, expectsKey: true });
    }
  };
  return {
    visit,
    result: () => {
      for (const key of DATE_KEYS) for (const prefix of ['', 'meta.', 'metadata.']) {
        const date = dates.get(`${prefix}${key}`);
        if (date) return date;
      }
      return null;
    },
  };
}
