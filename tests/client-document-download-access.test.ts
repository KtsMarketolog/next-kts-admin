import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import type { AdminSessionRole } from '../src/shared/lib/adminAuth';
import type { ClientDocumentFile } from '../src/shared/lib/db/clientDocumentsRepo';

function load<T>(filename: string, modules: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const instance = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, instance, instance.exports);
  return instance.exports as T;
}

type DownloadOptions = {
  cookie?: boolean;
  revoked?: boolean;
  userActive?: boolean;
  companyActive?: boolean;
  archived?: boolean;
  passwordChanged?: boolean;
  role?: AdminSessionRole;
  managerId?: number;
  clientCompanyId?: number;
  visible?: boolean;
  diskFailure?: boolean;
};

// Execute the real handler -> auth -> stored-session -> document repository ->
// company-scope guard chain. Only cookies, SQL transport and the final file read
// are synthetic; no database, physical file or working account is used.
function harness(audience: 'admin' | 'client', options: DownloadOptions = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const files: ClientDocumentFile[] = [];
  const role = options.role ?? 'admin';
  const managerRole = role === 'manager' || role === 'support_manager';
  const document = {
    id: '2', company_id: '13', title: 'Synthetic invoice', original_name: 'invoice.pdf',
    mime_type: 'application/pdf', file_path: 'client-documents/13/synthetic.pdf',
    file_size: '5', is_visible: options.visible !== false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('from client_sessions s') || sql.includes('from admin_sessions s')) {
      assert.match(sql, /s\.revoked_at is null/);
      assert.match(sql, /s\.expires_at > now\(\)/);
      assert.match(sql, /password_changed_at[\s\S]*<= s\.created_at, true\) as password_is_current/);
      if (options.revoked) return { rows: [] };
      const timestamps = { created_at: '2026-01-01T00:00:00Z', expires_at: '2030-01-01T00:00:00Z' };
      const passwordChanged = options.passwordChanged ? '2026-01-02T00:00:00Z' : null;
      if (sql.includes('from client_sessions')) {
        assert.match(sql, /cc\.is_active and cc\.archived_at is null/);
        return { rows: [{ ...timestamps, id: 'synthetic-session', client_user_id: '31',
          company_id: String(options.clientCompanyId ?? 13), user_is_active: options.userActive !== false,
          company_is_active: options.companyActive !== false && !options.archived,
          password_changed_at: passwordChanged, password_is_current: !options.passwordChanged }] };
      }
      return { rows: [{ ...timestamps, id: 'synthetic-session', role,
        admin_user_id: managerRole ? null : '1', manager_id: managerRole ? String(options.managerId ?? 21) : null,
        admin_is_active: options.userActive !== false, admin_role: role,
        manager_is_active: options.userActive !== false, manager_role: role,
        admin_password_changed_at: passwordChanged, manager_password_changed_at: passwordChanged,
        password_is_current: !options.passwordChanged,
        dashboard_access: [], admin_can_manage_top_dashboard: true,
        manager_can_access_top_dashboard: true, manager_can_manage_top_dashboard: true }] };
    }
    if (sql.startsWith('update client_sessions') || sql.startsWith('update admin_sessions')) return { rows: [] };
    if (sql.includes('from client_companies')) {
      assert.match(sql, /id = \$1/);
      assert.match(sql, /manager_id = \$2 or support_manager_id = \$2/);
      assert.equal(params[2], false, 'Only ordinary employees require an assignment query');
      const allowed = params[0] === 13 && (params[1] === 21 || params[1] === 22);
      return { rows: allowed ? [{ id: '13' }] : [] };
    }
    if (sql.includes('from client_documents')) {
      assert.match(sql, /where company_id = \$1 and id = \$2/);
      if (audience === 'client') assert.match(sql, /and is_visible = true/);
      const allowed = params[0] === 13 && params[1] === 2
        && (audience !== 'client' || document.is_visible);
      return { rows: allowed ? [document] : [] };
    }
    assert.fail(`Unexpected query: ${sql}`);
  };
  const client = { query, withTransaction: () => assert.fail('Downloads do not mutate business data') };
  const schema = { ensureSiteSchema: async () => undefined };
  const securityHash = { hashSensitiveValue: (value: string) => `hash:${value}`, safeHeaderValue: (value: string) => value };
  const sessions = load<typeof import('../src/shared/lib/db/clientSessionsRepo') & typeof import('../src/shared/lib/db/adminSessionsRepo')>(
    `src/shared/lib/db/${audience === 'client' ? 'clientSessionsRepo' : 'adminSessionsRepo'}.ts`, {
      crypto, '../securityHash': securityHash, '../dashboardAccess': { parseDashboardAccess: () => [] },
      './client': client, './schema': schema,
      './loginCredentialsRepo': { lockVerifiedLoginCredential: () => assert.fail('Document downloads never issue sessions') },
      '../loginCredentialProof': {},
    },
  );
  const cookies = async () => ({ get: () => options.cookie === false ? undefined
    : { value: 'synthetic-session-token-with-more-than-32-chars' } });
  const auth = load<typeof import('../src/shared/lib/clientAuth') & typeof import('../src/shared/lib/adminAuth')>(
    `src/shared/lib/${audience === 'client' ? 'clientAuth' : 'adminAuth'}.ts`, {
      'next/headers': { cookies }, crypto,
      './db/clientSessionsRepo': sessions, './db/adminSessionsRepo': sessions,
      './authSecret': { getAdminSessionSecret: () => 'synthetic-test-key' }, './dashboardPermissions': {},
    },
  );
  const helpers = load<typeof import('../src/shared/lib/db/clientCompaniesRepo.helpers')>(
    'src/shared/lib/db/clientCompaniesRepo.helpers.ts', {
      './client': client, '../wholesalePriceWorkflowStatus': {}, '../clientPasswordVault': {},
    },
  );
  const companies = load<typeof import('../src/shared/lib/db/clientCompaniesRepo')>(
    'src/shared/lib/db/clientCompaniesRepo.ts', {
      './client': client, './schema': schema, './clientCompaniesRepo.helpers': helpers,
      './clientCompanyPriceListAssignments': {}, './clientSessionsRepo': {},
      '../clientPasswordVault': {},
      '../loginCredentialProof': {},
    },
  );
  const documents = load<typeof import('../src/shared/lib/db/clientDocumentsRepo')>(
    'src/shared/lib/db/clientDocumentsRepo.ts', {
      './client': client, './schema': schema, './clientCompaniesRepo': companies,
    },
  );
  const route = load<{ GET: (request: Request, context: unknown) => Promise<Response> }>(
    audience === 'admin'
      ? 'src/app/api/admin/clients/[id]/documents/[documentId]/download/route.ts'
      : 'src/app/api/client/documents/[documentId]/download/route.ts', {
      '@/shared/lib/adminAuth': auth, '@/shared/lib/clientAuth': auth, '@/shared/lib/db': documents,
      '@/shared/lib/clientDocumentDownloadResponse': { createClientDocumentDownloadResponse: async (file: ClientDocumentFile) => {
        files.push(file);
        if (options.diskFailure) throw new Error("ENOENT: open '/private/storage/client-documents/13/synthetic.pdf'");
        return new Response('hello', { headers: { 'Cache-Control': 'private, no-store', 'Content-Disposition': 'attachment' } });
      } },
    },
  );
  return {
    queries, files,
    run: (documentId = '2', companyId = '13') => route.GET(new Request('https://example.test/api/download?companyId=13'), {
      params: Promise.resolve({ id: companyId, documentId }),
    }),
  };
}

for (const audience of ['admin', 'client'] as const) {
  test(`${audience} document download without a session never queries documents or reads a file`, async () => {
    const h = harness(audience, { cookie: false });
    const response = await h.run();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(h.queries, []);
    assert.deepEqual(h.files, []);
  });

  for (const [name, flags] of [
    ['revoked', { revoked: true }], ['inactive user', { userActive: false }], ['changed password', { passwordChanged: true }],
  ] as const) {
    test(`${audience} ${name} session is denied before document lookup or file read`, async () => {
      const h = harness(audience, flags);
      assert.equal((await h.run()).status, 401);
      assert.equal(h.queries.some(({ sql }) => sql.includes('from client_documents')), false);
      assert.deepEqual(h.files, []);
    });
  }

  test(`${audience} invalid/unsafe document identifiers cannot reach the file repository`, async () => {
    for (const id of ['0', '-1', '1.5', '9007199254740992', 'Infinity', 'not-an-id']) {
      const h = harness(audience);
      const response = await h.run(id);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.equal(h.queries.some(({ sql }) => sql.includes('from client_documents')), false);
      assert.deepEqual(h.files, []);
    }
  });

  test(`${audience} asynchronous file failure is controlled and never exposes storage paths`, async () => {
    const h = harness(audience, { diskFailure: true });
    const response = await h.run();
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await response.json(), { error: 'Документ не найден или недоступен' });
    assert.equal(h.files.length, 1);
  });
}

test('client owner receives only the authorized visible document, not a path supplied in the URL', async () => {
  const h = harness('client');
  const response = await h.run();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'hello');
  assert.equal(h.files.length, 1);
  assert.equal(h.files[0].companyId, 13);
  assert.equal(h.files[0].filePath, 'client-documents/13/synthetic.pdf');
});

test('another company cannot download a known document ID or override its company through URL parameters', async () => {
  const h = harness('client', { clientCompanyId: 14 });
  assert.equal((await h.run('2', '13')).status, 404);
  assert.deepEqual(h.files, []);
  assert.deepEqual(h.queries.find(({ sql }) => sql.includes('from client_documents'))?.params, [14, 2]);
});

test('hidden document is unavailable to its client owner', async () => {
  const h = harness('client', { visible: false });
  assert.equal((await h.run()).status, 404);
  assert.deepEqual(h.files, []);
});

for (const flags of [{ archived: true }, { companyActive: false }]) {
  test(`client ${flags.archived ? 'archived' : 'inactive'} company invalidates its session before download`, async () => {
    const h = harness('client', flags);
    assert.equal((await h.run()).status, 401);
    assert.equal(h.queries.some(({ sql }) => sql.includes('from client_documents')), false);
    assert.deepEqual(h.files, []);
  });
}

for (const role of ['admin', 'wholesale_admin', 'manager', 'support_manager'] as const) {
  test(`${role} can download documents within its existing company scope, including hidden archived records`, async () => {
    const h = harness('admin', { role, managerId: role === 'support_manager' ? 22 : 21, visible: false, archived: true });
    assert.equal((await h.run()).status, 200);
    assert.equal(h.files.length, 1);
    assert.equal(h.files[0].isVisible, false, 'Visibility controls the client cabinet, not authorized staff archive reading');
  });
}

for (const role of ['manager', 'support_manager'] as const) {
  test(`${role} outside company scope is denied before document lookup or file read`, async () => {
    const h = harness('admin', { role, managerId: 99 });
    const response = await h.run();
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(h.queries.some(({ sql }) => sql.includes('from client_documents')), false);
    assert.deepEqual(h.files, []);
  });

  test(`inactive ${role} cannot retain document access through a stored session`, async () => {
    const h = harness('admin', { role, userActive: false });
    assert.equal((await h.run()).status, 401);
    assert.equal(h.queries.some(({ sql }) => sql.includes('from client_documents')), false);
    assert.deepEqual(h.files, []);
  });
}

for (const role of ['top', 'admintop', 'purchaser'] as const) {
  test(`${role} dashboard privileges do not grant client-document API access`, async () => {
    const h = harness('admin', { role });
    assert.equal((await h.run()).status, 401);
    assert.equal(h.queries.some(({ sql }) => sql.includes('from client_documents')), false);
    assert.deepEqual(h.files, []);
  });
}

test('administrator cannot mismatch document and company IDs, or use unsafe company IDs', async () => {
  const h = harness('admin');
  assert.equal((await h.run('2', '14')).status, 404);
  assert.deepEqual(h.files, []);
  const unsafe = harness('admin');
  assert.equal((await unsafe.run('2', '9007199254740992')).status, 400);
  assert.equal(unsafe.queries.some(({ sql }) => sql.includes('from client_documents')), false);
  assert.deepEqual(unsafe.files, []);
});
