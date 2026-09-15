import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as audience from '../src/shared/lib/managerDashboardAudience';
import * as domain from '../src/shared/lib/managerDashboardDomain';
import * as pagination from '../src/shared/lib/managerDashboardImportPagination';
import * as security from '../src/shared/lib/managerDashboardSecurity';
import * as origin from '../src/shared/lib/originProtection';

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

type Audience = audience.PersonalDashboardAudience;
type State = { active_version_id: string | null; previous_version_id: string | null; updated_by: string };
function repository(options: { deleteFails?: boolean; emptyDelete?: boolean; missingState?: boolean; publishOnLock?: boolean } = {}) {
  const states: Record<Audience, State> = {
    development: { active_version_id: '2', previous_version_id: '1', updated_by: 'admin:before' },
    support: { active_version_id: '12', previous_version_id: '11', updated_by: 'admin:before' },
  };
  const versions = new Map<number, Audience>([[1, 'development'], [2, 'development'], [3, 'development'], [4, 'development'],
    [11, 'support'], [12, 'support'], [13, 'support']]);
  const queries: { text: string; params: unknown[] }[] = [];
  let schemaCalls = 0;
  let commits = 0;
  let rollbacks = 0;
  let locked: Audience | null = null;
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      const sql = text.replace(/\s+/g, ' ').trim();
      assert.doesNotMatch(sql, /snapshot|wholesale_|personal_dashboard_imports/i, 'HTML deletion must not access unrelated data');
      if (sql.startsWith('select pg_advisory_xact_lock')) {
        assert.match(String(params[0]), /^kts-personal-dashboard-html:(development|support)$/);
        locked = String(params[0]).split(':')[1] as Audience;
        if (options.publishOnLock) states[locked].active_version_id = '3';
        return { rows: [], rowCount: 1 };
      }
      assert.ok(locked, 'acquire the publication lock before inspecting state or versions');
      if (sql.startsWith('select active_version_id::text')) {
        assert.match(sql, /where audience=\$1 for update$/);
        assert.deepEqual(params, [locked]);
        return { rows: options.missingState ? [] : [{ ...states[locked] }], rowCount: options.missingState ? 0 : 1 };
      }
      if (sql.startsWith('select id from personal_dashboard_html_versions')) {
        assert.match(sql, /where id=\$1 and audience=\$2$/);
        assert.equal(params[1], locked);
        const exists = versions.get(params[0] as number) === locked;
        return { rows: exists ? [{ id: params[0] }] : [], rowCount: exists ? 1 : 0 };
      }
      if (sql.startsWith('update personal_dashboard_html_state')) {
        assert.match(sql, /set previous_version_id=case when previous_version_id=\$1 then null else previous_version_id end, updated_by=\$2,updated_at=now\(\) where audience=\$3$/);
        assert.equal(params[2], locked);
        const state = states[locked];
        if (state.previous_version_id === String(params[0])) state.previous_version_id = null;
        state.updated_by = params[1] as string;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('delete from personal_dashboard_html_versions')) {
        assert.match(sql, /where id=\$1 and audience=\$2 returning id$/);
        assert.equal(params[1], locked);
        assert.notEqual(states[locked].active_version_id, String(params[0]));
        assert.notEqual(states[locked].previous_version_id, String(params[0]), 'previous pointer must be cleared before RESTRICT delete');
        if (options.deleteFails) throw new Error('synthetic database delete failure');
        if (options.emptyDelete) return { rows: [], rowCount: 0 };
        assert.equal(versions.get(params[0] as number), locked);
        versions.delete(params[0] as number);
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      assert.fail(`Unexpected SQL: ${sql}`);
    },
  };
  const repo = compile<typeof import('../src/shared/lib/db/managerDashboardRepo')>(
    '../src/shared/lib/db/managerDashboardRepo.ts', {
      'node:crypto': crypto,
      '../managerDashboardAudience': audience,
      '../managerDashboardDomain': domain,
      '../managerDashboardImportPagination': pagination,
      './client': { query: () => assert.fail('deletion must be transactional'), withTransaction: async (callback: (value: typeof client) => unknown) => {
        const before = structuredClone(states);
        const beforeVersions = new Map(versions);
        try { const result = await callback(client); commits++; return result; }
        catch (error) {
          Object.assign(states, before);
          versions.clear();
          for (const [id, group] of beforeVersions) versions.set(id, group);
          rollbacks++;
          throw error;
        } finally { locked = null; }
      } },
      './schema': { ensureSiteSchema: async () => { schemaCalls++; } },
    },
  );
  return { repo, queries, states, versions, get schemaCalls() { return schemaCalls; },
    get commits() { return commits; }, get rollbacks() { return rollbacks; } };
}

test('HTML deletion removes a single inactive version only within its audience and preserves publication', async () => {
  for (const [group, versionId] of [['development', 3], ['development', 4], ['support', 13]] as const) {
    const db = repository();
    const before = structuredClone(db.states);
    assert.deepEqual(await db.repo.deletePersonalDashboardHtml({ versionId, audience: group, actorId: 'admintop:test' }),
      { deletedVersionId: versionId, audience: group });
    assert.equal(db.versions.has(versionId), false);
    assert.equal(db.versions.size, 6);
    assert.equal(db.states[group].active_version_id, before[group].active_version_id);
    assert.equal(db.states[group].previous_version_id, before[group].previous_version_id);
    assert.equal(db.states[group].updated_by, 'admintop:test');
    const other = group === 'development' ? 'support' : 'development';
    assert.deepEqual(db.states[other], before[other]);
    assert.equal(db.commits, 1);
    assert.equal(db.rollbacks, 0);
  }
});

test('deleting the previous HTML clears its reference without choosing another rollback or active version', async () => {
  for (const [group, versionId] of [['development', 1], ['support', 11]] as const) {
    const db = repository();
    const activeId = db.states[group].active_version_id;
    await db.repo.deletePersonalDashboardHtml({ versionId, audience: group, actorId: 'admin:test' });
    assert.equal(db.states[group].active_version_id, activeId);
    assert.equal(db.states[group].previous_version_id, null);
    assert.equal(db.versions.has(versionId), false);
  }
});

test('active HTML and a version published while waiting for the lock fail closed without writes', async () => {
  for (const [group, versionId, publishOnLock] of [['development', 2, false], ['support', 12, false], ['development', 3, true]] as const) {
    const db = repository({ publishOnLock });
    await assert.rejects(db.repo.deletePersonalDashboardHtml({ versionId, audience: group, actorId: 'admin:test' }),
      { code: 'ACTIVE_VERSION_CONFLICT' });
    assert.equal(db.versions.size, 7);
    assert.equal(db.queries.some((item) => /^\s*(delete|update)/i.test(item.text)), false);
    assert.equal(db.commits, 0);
  }
});

test('wrong group, absent HTML, and repeated deletion never mutate another version or pointer', async () => {
  const db = repository();
  for (const versionId of [11, 12, 999]) {
    await assert.rejects(db.repo.deletePersonalDashboardHtml({ versionId, audience: 'development', actorId: 'admin:test' }), { code: 'NOT_FOUND' });
  }
  assert.equal(db.queries.some((item) => /^\s*(delete|update)/i.test(item.text)), false);
  await db.repo.deletePersonalDashboardHtml({ versionId: 3, audience: 'development', actorId: 'admin:test' });
  const after = structuredClone(db.states);
  await assert.rejects(db.repo.deletePersonalDashboardHtml({ versionId: 3, audience: 'development', actorId: 'admin:test' }), { code: 'NOT_FOUND' });
  assert.deepEqual(db.states, after);
  assert.equal(db.versions.size, 6);
});

test('delete errors roll back previous pointer and actor changes; missing state never allows a delete', async () => {
  for (const options of [{ deleteFails: true }, { emptyDelete: true }, { missingState: true }]) {
    const db = repository(options);
    const before = structuredClone(db.states);
    await assert.rejects(db.repo.deletePersonalDashboardHtml({ versionId: 1, audience: 'development', actorId: 'admin:test' }));
    assert.deepEqual(db.states, before);
    assert.equal(db.versions.size, 7);
    assert.equal(db.rollbacks, 1);
    assert.equal(db.commits, 0);
  }
});

test('repository requires explicit valid audience, safe version ID, and actor before database access', async () => {
  const db = repository();
  const valid = { versionId: 3, audience: 'development' as Audience, actorId: 'admin:test' };
  for (const input of [
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((versionId) => ({ ...valid, versionId })),
    { ...valid, audience: undefined }, { ...valid, audience: 'other' }, { ...valid, actorId: '' },
  ]) await assert.rejects(db.repo.deletePersonalDashboardHtml(input as typeof valid));
  assert.equal(db.schemaCalls, 0);
  assert.deepEqual(db.queries, []);
});

type Session = Parameters<typeof security.personalDashboardMode>[0];
function deleteRoute(session: Session, options: { error?: Error; limited?: boolean } = {}) {
  const calls: unknown[] = [];
  let rateCalls = 0;
  const shared = compile<typeof import('../src/app/api/admin/manager-dashboard/_shared')>(
    '../src/app/api/admin/manager-dashboard/_shared.ts', {
      '@/shared/lib/adminAuth': { getAdminSession: async () => session },
      '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => {
        rateCalls++;
        return options.limited ? Response.json({ error: 'Rate limited' }, { status: 429 }) : null;
      } },
      '@/shared/lib/db/wholesaleAdminRepo/managerRepo': { getWholesaleManagerById: async () => assert.fail('manage-only access must reject ordinary managers') },
      '@/shared/lib/managerDashboardSecurity': security,
      '@/shared/lib/originProtection': origin,
    },
  );
  const route = compile<typeof import('../src/app/api/admin/manager-dashboard/html/route')>(
    '../src/app/api/admin/manager-dashboard/html/route.ts', {
      '../../top-dashboard/blocks/routeUtils': {},
      '@/shared/lib/db/managerDashboardRepo': { deletePersonalDashboardHtml: async (input: { versionId: number; audience: Audience }) => {
        calls.push(input);
        if (options.error) throw options.error;
        return { deletedVersionId: input.versionId, audience: input.audience };
      } },
      '@/shared/lib/managerDashboardHtml': {},
      '@/shared/lib/managerDashboardSecurity': security,
      '@/shared/lib/managerDashboardAudience': audience,
      '../_shared': shared,
    },
  );
  return { route, calls, get rateCalls() { return rateCalls; } };
}
function request(query = '?audience=development&id=3', requestOrigin: string | null = 'https://example.test') {
  return new Request(`https://example.test/api/admin/manager-dashboard/html${query}`,
    { method: 'DELETE', headers: requestOrigin === null ? {} : { origin: requestOrigin } });
}
function assertPrivate(response: Response) {
  assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('HTML DELETE route permits existing management roles, uses verified actor, and disables caching', async () => {
  for (const session of [
    { role: 'admin', sessionId: 'synthetic-admin' },
    { role: 'admintop', sessionId: 'synthetic-top', adminUserId: 1 },
  ] as Session[]) {
    const api = deleteRoute(session);
    const response = await api.route.DELETE(request('?audience=support&id=13'));
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.deepEqual(await response.json(), { deletedVersionId: 13, audience: 'support' });
    assert.deepEqual(api.calls, [{ versionId: 13, audience: 'support', actorId: session!.role === 'admin' ? 'admin:synthetic-admin' : 'admintop:1' }]);
    assert.equal(api.rateCalls, 1);
  }
});

test('HTML DELETE rejects no session and viewer roles before any storage call', async () => {
  for (const session of [null, { role: 'manager', sessionId: 'synthetic', managerId: 1 },
    { role: 'support_manager', sessionId: 'synthetic', managerId: 2 }, { role: 'admin' }] as Session[]) {
    const api = deleteRoute(session);
    const response = await api.route.DELETE(request());
    assert.equal(response.status, session ? 403 : 401);
    assertPrivate(response);
    assert.deepEqual(api.calls, []);
    assert.equal(api.rateCalls, 0);
  }
});

test('HTML DELETE preserves same-origin CSRF and write rate protections', async () => {
  const api = deleteRoute({ role: 'admin', sessionId: 'synthetic' } as Session);
  for (const requestOrigin of [null, 'https://untrusted.example', 'null']) {
    assert.equal((await api.route.DELETE(request(undefined, requestOrigin))).status, 403);
  }
  assert.deepEqual(api.calls, []);
  assert.equal(api.rateCalls, 0);
  const limited = deleteRoute({ role: 'admin', sessionId: 'synthetic' } as Session, { limited: true });
  assert.equal((await limited.route.DELETE(request())).status, 429);
  assert.deepEqual(limited.calls, []);
});

test('HTML DELETE rejects invalid, duplicate, missing, and unknown target parameters', async () => {
  const api = deleteRoute({ role: 'admin', sessionId: 'synthetic' } as Session);
  for (const query of ['', '?id=3', '?audience=development', '?audience=other&id=3', '?audience=&id=3',
    '?audience=development&audience=support&id=3', '?audience=development&audience=development&id=3',
    '?audience=development&id=3&id=3', '?audience=development&id=3&%69d=4',
    '?audience=development&id=3&actorId=admin:other', '?audience=development&id=3&versionId=4',
    ...['', '0', '-1', '01', '1.5', '+1', '1e3', ' 1', '1\n', 'NaN', '9007199254740992', '999999999999999999999']
      .map((id) => `?audience=development&id=${encodeURIComponent(id)}`)]) {
    const response = await api.route.DELETE(request(query));
    assert.equal(response.status, 400, query);
    assertPrivate(response);
  }
  assert.deepEqual(api.calls, []);
});

test('HTML DELETE reports publication conflicts and safe internal errors without leaking database details', async () => {
  for (const [error, status, code] of [
    [new domain.PersonalDashboardError('ACTIVE_VERSION_CONFLICT', 'Сначала опубликуйте другую версию'), 409, 'ACTIVE_VERSION_CONFLICT'],
    [new domain.PersonalDashboardError('NOT_FOUND', 'HTML-версия не найдена'), 400, 'NOT_FOUND'],
    [new Error('synthetic confidential database password'), 500, undefined],
  ] as const) {
    const api = deleteRoute({ role: 'admin', sessionId: 'synthetic' } as Session, { error });
    const response = await api.route.DELETE(request());
    assert.equal(response.status, status);
    assertPrivate(response);
    const data = await response.json();
    assert.equal(data.code, code);
    assert.doesNotMatch(JSON.stringify(data), /confidential|password/);
  }
});
