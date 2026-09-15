import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as audience from '../src/shared/lib/managerDashboardAudience';
import * as domain from '../src/shared/lib/managerDashboardDomain';
import * as pagination from '../src/shared/lib/managerDashboardImportPagination';
import * as security from '../src/shared/lib/managerDashboardSecurity';

function compile<T>(filename: string, modules: Record<string, unknown>): T {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} as T };
  new Function('require', 'module', 'exports', 'console', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, testModule, testModule.exports, { error: () => {} });
  return testModule.exports;
}

function journalRow(id: string) {
  return {
    id, original_name: `synthetic-${id}.ktsp`, status: 'imported', code: 'IMPORTED',
    manager_id: '42', snapshot_id: '7', sender: 'synthetic@example.test', message_id: 'synthetic',
    received_at: '2026-09-15 12:00:00+03', issued: '2026-09-15',
  };
}

/** Execute the actual repository with a bounded, read-only synthetic query driver. */
function repository(ids: string[]) {
  const rows = ids.map(journalRow);
  const queries: { text: string; params: unknown[] }[] = [];
  let schemaCalls = 0;
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      assert.match(text.trim(), /^select\b/i, 'pagination must not mutate imports or retention');
      if (!text.includes('from personal_dashboard_imports')) return { rows: [] };
      assert.match(text, /order by journal\.id desc limit 6\s*$/i,
        'sort the numeric source column, not the id::text output alias; fetch only one lookahead row');
      assert.doesNotMatch(text, /\boffset\b/i);
      const before = params[0];
      if (before !== undefined) {
        assert.equal(typeof before, 'string', 'do not convert a BIGINT cursor to a JS number');
        assert.match(text, /where journal\.id < \$1::bigint/i);
        assert.equal(params.length, 1);
      } else {
        assert.doesNotMatch(text, /\bwhere\b/i);
        assert.equal(params.length, 0);
      }
      return { rows: rows.filter((row) => before === undefined || BigInt(row.id) < BigInt(before as string))
        .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, 6) };
    },
  };
  const repo = compile<typeof import('../src/shared/lib/db/managerDashboardRepo')>(
    '../src/shared/lib/db/managerDashboardRepo.ts', {
      'node:crypto': crypto,
      '../managerDashboardAudience': audience,
      '../managerDashboardDomain': domain,
      '../managerDashboardImportPagination': pagination,
      './client': { query: client.query, withTransaction: async (callback: (value: typeof client) => unknown) => callback(client) },
      './schema': { ensureSiteSchema: async () => { schemaCalls++; } },
    },
  );
  return { repo, queries, rows, get schemaCalls() { return schemaCalls; } };
}

test('import journal accepts only canonical positive PostgreSQL BIGINT string cursors', () => {
  assert.equal(pagination.PERSONAL_DASHBOARD_IMPORT_PAGE_SIZE, 5);
  for (const value of ['1', '9007199254740993', '9223372036854775807']) {
    assert.equal(pagination.isPersonalDashboardImportCursor(value), true, value);
  }
  for (const value of [null, undefined, 1, '', '0', '-1', '+1', '01', '1.0', '1e2', ' 1', '1 ', '1\n',
    '１', '9223372036854775808', '99999999999999999999', '1 OR TRUE', '1'.repeat(10000)]) {
    assert.equal(pagination.isPersonalDashboardImportCursor(value), false, String(value).slice(0, 40));
  }
});

test('repository pages five descending rows using the exact last BIGINT id, with no duplicates or gaps', async () => {
  const firstId = BigInt('10000000000000003');
  const ids = Array.from({ length: 13 }, (_, index) => String(firstId - BigInt(index)));
  const db = repository(ids);
  const seen: string[] = [];
  const seenIds: string[] = [];
  let before: string | null = null;
  for (const expectedSize of [5, 5, 3]) {
    const page = await db.repo.listPersonalDashboardImports(before);
    assert.equal(page.imports.length, expectedSize);
    seen.push(...page.imports.map((row) => row.originalName));
    seenIds.push(...page.imports.map((row) => row.id));
    assert.equal(page.nextCursor, expectedSize === 5 ? ids[seen.length - 1] : null);
    before = page.nextCursor;
    if (seen.length === 5) {
      // A new delivery above the cursor must not repeat earlier entries on page two.
      db.rows.push(journalRow(String(firstId + BigInt(1))));
    }
  }
  assert.deepEqual(seen, ids.map((id) => `synthetic-${id}.ktsp`));
  assert.deepEqual(seenIds, ids, 'journal identity, not only cursor, must preserve BIGINT precision');
  assert.equal(new Set(seenIds).size, ids.length);
  assert.deepEqual(db.queries.map((item) => item.params), [[], [ids[4]], [ids[9]]]);
});

test('empty, short, and exactly-full final journal pages have no next cursor', async () => {
  for (const count of [0, 1, 5, 6]) {
    const db = repository(Array.from({ length: count }, (_, index) => String(index + 1)));
    const page = await db.repo.listPersonalDashboardImports();
    assert.equal(page.imports.length, Math.min(5, count));
    assert.equal(page.nextCursor, count === 6 ? '2' : null);
    assert.equal(db.queries.length, 1);
    const exhausted = await db.repo.listPersonalDashboardImports('1');
    assert.deepEqual(exhausted, { imports: [], nextCursor: null });
  }
});

test('overview reuses the bounded first journal page without changing audience groups', async () => {
  const db = repository(Array.from({ length: 250 }, (_, index) => String(index + 1)));
  const overview = await db.repo.listPersonalDashboardAdmin();
  assert.equal(overview.imports.length, 5);
  assert.equal(overview.importsNextCursor, '246');
  assert.deepEqual(overview.imports.map((row) => row.originalName),
    [250, 249, 248, 247, 246].map((id) => `synthetic-${id}.ktsp`));
  assert.deepEqual(overview.groups.map((group) => group.audience), ['development', 'support']);
  assert.equal(db.queries.filter((item) => item.text.includes('from personal_dashboard_imports')).length, 1);
  const page = await db.repo.listPersonalDashboardImports();
  assert.deepEqual({ imports: overview.imports, nextCursor: overview.importsNextCursor }, page);
});

test('repository rejects an invalid cursor before any schema or database access', async () => {
  const db = repository([]);
  for (const before of ['', '01', '0', '-1', '9223372036854775808', '1; delete from personal_dashboard_imports']) {
    await assert.rejects(db.repo.listPersonalDashboardImports(before), { code: 'INVALID_CURSOR' });
  }
  assert.equal(db.schemaCalls, 0);
  assert.deepEqual(db.queries, []);
});

type Session = Parameters<typeof security.personalDashboardMode>[0];
function importsRoute(session: Session, fail = false) {
  const calls: (string | null)[] = [];
  const shared = compile<typeof import('../src/app/api/admin/manager-dashboard/_shared')>(
    '../src/app/api/admin/manager-dashboard/_shared.ts', {
      '@/shared/lib/adminAuth': { getAdminSession: async () => session },
      '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => { assert.fail('GET must not use the write rate limiter'); } },
      '@/shared/lib/db/wholesaleAdminRepo/managerRepo': { getWholesaleManagerById: async () => { assert.fail('manage-only journal must reject viewers before manager lookup'); } },
      '@/shared/lib/managerDashboardSecurity': security,
      '@/shared/lib/originProtection': { enforceSameOriginRequest: () => { assert.fail('GET must not use a write guard'); } },
    },
  );
  const page = { imports: [journalRow('5')], nextCursor: '5' };
  const route = compile<typeof import('../src/app/api/admin/manager-dashboard/imports/route')>(
    '../src/app/api/admin/manager-dashboard/imports/route.ts', {
      '@/shared/lib/db/managerDashboardRepo': { listPersonalDashboardImports: async (before: string | null) => {
        calls.push(before);
        if (fail) throw new Error('synthetic confidential database failure');
        return page;
      } },
      '@/shared/lib/managerDashboardImportPagination': pagination,
      '../_shared': shared,
    },
  );
  return { route, calls, page };
}

function request(query = '') { return new Request(`https://example.test/api/admin/manager-dashboard/imports${query}`); }
function assertPrivate(response: Response) {
  assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('journal route allows admin and admintop, preserves BIGINT cursor, and prevents caching', async () => {
  for (const session of [
    { role: 'admin', sessionId: 'synthetic-admin' },
    { role: 'admintop', sessionId: 'synthetic-top', adminUserId: 1 },
  ] as Session[]) {
    const api = importsRoute(session);
    assert.equal(api.route.runtime, 'nodejs');
    assert.equal(api.route.dynamic, 'force-dynamic');
    for (const query of ['', '?before=9223372036854775807']) {
      const response = await api.route.GET(request(query));
      assert.equal(response.status, 200);
      assertPrivate(response);
      assert.deepEqual(await response.json(), api.page);
    }
    assert.deepEqual(api.calls, [null, '9223372036854775807']);
  }
});

test('journal route rejects unauthenticated sessions and both manager roles before reading imports', async () => {
  for (const session of [null,
    { role: 'manager', sessionId: 'synthetic', managerId: 1 },
    { role: 'support_manager', sessionId: 'synthetic', managerId: 2 },
    { role: 'admin' },
  ] as Session[]) {
    const api = importsRoute(session);
    const response = await api.route.GET(request());
    assert.equal(response.status, session ? 403 : 401);
    assertPrivate(response);
    assert.deepEqual(api.calls, []);
  }
});

test('journal route rejects duplicate, unknown, and invalid parameters without database access', async () => {
  const api = importsRoute({ role: 'admin', sessionId: 'synthetic' } as Session);
  for (const query of ['?before=', '?before=0', '?before=01', '?before=-1', '?before=%2B1', '?before=1.0',
    '?before=1e3', '?before=%201', '?before=9223372036854775808', '?before=1&before=2',
    '?before=1&before=1', '?before=1&%62efore=2', '?limit=200', '?audience=support', '?before=2&unknown=1']) {
    const response = await api.route.GET(request(query));
    assert.equal(response.status, 400, query);
    assertPrivate(response);
  }
  assert.deepEqual(api.calls, []);
});

test('journal route returns a safe uncached error for a database failure', async () => {
  const api = importsRoute({ role: 'admin', sessionId: 'synthetic' } as Session, true);
  const response = await api.route.GET(request());
  assert.equal(response.status, 500);
  assertPrivate(response);
  assert.doesNotMatch(await response.text(), /confidential|database/i);
});
