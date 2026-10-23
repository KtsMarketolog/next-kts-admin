import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import type { AdminSession } from '../src/shared/lib/adminAuth';

function load<T>(filename: string, modules: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const instance = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, instance, instance.exports);
  return instance.exports as T;
}

function harness(options: { session?: AdminSession | null; failure?: boolean; archived?: boolean } = {}) {
  const session = options.session === undefined ? { role: 'admin' } as AdminSession : options.session;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const row = {
    id: '13', title: 'Synthetic company', inn: '', kpp: '', contact_name: '', email: 'synthetic@example.test',
    phone: '', address: '', note: 'Keep note', manager_id: '21', manager_name: 'Synthetic manager',
    support_manager_id: '22', support_manager_name: 'Synthetic support', require_2fa: false,
    user_count: '2', client_login: 'synthetic', client_user_id: '31', password_changed_at: '2026-01-01T00:00:00Z',
    chat_unread_count: '3', is_active: !options.archived, archived_at: options.archived ? '2026-01-02T00:00:00Z' : null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    // Even an accidentally extended SQL projection must not become a response credential store.
    display_password: 'SyntheticSecret', password_hash: 'SyntheticHash', password_ciphertext: 'SyntheticCiphertext',
  };
  const client = { query: async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    assert.match(sql, /and cc\.id = \$4/);
    assert.match(sql, /where \(\$1::boolean = true or cc\.manager_id = \$2 or cc\.support_manager_id = \$2\)/);
    assert.match(sql, /ccm\.company_id = cc\.id/);
    assert.doesNotMatch(sql, /\b(?:update|insert|delete|password_hash|password_ciphertext|display_password)\b/i);
    assert.equal(params.length, 4);
    assert.equal(params[2], 'all', 'archived records retain the detail screen visibility rule');
    if (options.failure) throw new Error('synthetic SQL transport secret');
    return { rows: params[3] === 13 && (params[0] || params[1] === 21 || params[1] === 22) ? [row] : [] };
  }, withTransaction: () => assert.fail('Read-only detail must not start a write transaction') };
  const helpers = load<typeof import('../src/shared/lib/db/clientCompaniesRepo.helpers')>('src/shared/lib/db/clientCompaniesRepo.helpers.ts', {
    './client': client, '../wholesalePriceWorkflowStatus': {}, '../clientPasswordVault': {},
  });
  const repo = load<typeof import('../src/shared/lib/db/clientCompaniesRepo')>('src/shared/lib/db/clientCompaniesRepo.ts', {
    './client': client, './schema': { ensureSiteSchema: async () => {} }, './clientCompaniesRepo.helpers': helpers,
    './clientCompanyPriceListAssignments': {}, './clientSessionsRepo': {}, '../clientPasswordVault': {}, '../loginCredentialProof': {},
  });
  const route = load<typeof import('../src/app/api/admin/clients/[id]/route')>('src/app/api/admin/clients/[id]/route.ts', {
    '@/shared/lib/adminAuth': { requireEmployee: async () => session
      ? { denied: null, session } : { denied: Response.json({ error: 'Unauthorized' }, { status: 401 }), session: null } },
    '@/shared/lib/db': repo, '@/shared/lib/adminSecurity': {}, '@/shared/lib/clientRealtime': {},
    '@/shared/lib/db/securityAuditRepo': {}, '@/shared/lib/originProtection': {}, '@/shared/lib/passwordPolicy': {},
    '@/shared/lib/rateLimit': {}, '@/shared/lib/wholesaleSecurity': {}, '@/shared/lib/postCommitTasks': {},
    '@/shared/lib/db/transactionOutcome': {},
  });
  return { queries, repo, run: (id = '13') => route.GET(new Request(`https://example.test/api/admin/clients/${id}`), { params: Promise.resolve({ id }) }) };
}

test('client detail denies unauthenticated reads before any company query', async () => {
  const h = harness({ session: null });
  const response = await h.run();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(h.queries, []);
});

test('invalid and unsafe company identifiers never reach SQL', async () => {
  for (const id of ['0', '-1', '1.5', 'Infinity', '9007199254740992', 'not-an-id']) {
    const h = harness();
    assert.equal((await h.run(id)).status, 400);
    assert.deepEqual(h.queries, []);
    assert.equal(await h.repo.getClientCompany(Number(id), { role: 'admin' }), null);
    assert.deepEqual(h.queries, []);
  }
});

test('one scoped SQL query returns the company for admins and both assigned manager roles, including archive', async () => {
  for (const archived of [false, true]) {
    for (const session of [{ role: 'admin' }, { role: 'wholesale_admin' }, { role: 'manager', managerId: 21 }, { role: 'support_manager', managerId: 22 }] as AdminSession[]) {
      const h = harness({ session, archived });
      const response = await h.run();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ['company']);
      assert.equal(body.company.id, 13);
      assert.equal(body.company.userCount, 2);
      assert.equal(body.company.chatUnreadCount, 3);
      assert.equal(Boolean(body.company.archivedAt), archived);
      assert.equal('passwordChangedAt' in body.company, false);
      assert.doesNotMatch(JSON.stringify(body), /SyntheticSecret|SyntheticHash|SyntheticCiphertext|passwordHash|password_hash|passwordCiphertext|password_ciphertext|displayPassword|display_password/);
      assert.equal(h.queries.length, 1);
      assert.deepEqual(h.queries[0].params, [session.role === 'admin' || session.role === 'wholesale_admin', session.managerId ?? 0, 'all', 13]);
    }
  }
});

test('unassigned managers and missing companies receive the same non-disclosing response', async () => {
  const missing = await harness().run('99');
  assert.equal(missing.status, 404);
  const expected = await missing.json();
  for (const session of [{ role: 'manager', managerId: 999 }, { role: 'support_manager', managerId: 999 }, { role: 'manager' }] as AdminSession[]) {
    const response = await harness({ session }).run();
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), expected);
  }
});

test('database failure is retryable and never exposes database details', async () => {
  const response = await harness({ failure: true }).run();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.doesNotMatch(JSON.stringify(await response.json()), /synthetic SQL transport secret/);
});
