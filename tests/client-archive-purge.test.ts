import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as outcomes from '../src/shared/lib/db/transactionOutcome';
import * as postCommit from '../src/shared/lib/postCommitTasks';

class ArchiveConflict extends Error {}
const allowed = (session: AdminSession) => session.role === 'admin' || session.role === 'wholesale_admin';
const counts = { users: 1, sessions: 2, twoFactorChallenges: 3, chatMessages: 4, chatReadStates: 1,
  documents: 2, files: 2, fileBytes: 10, priceRequests: 5, priceLists: 6 };
const expectedUpdatedAt = '2026-10-18T12:00:00.000Z';
const confirmationTitle = 'Synthetic archived client';
const expectedRevision = crypto.createHash('sha256').update(JSON.stringify({ updatedAt: expectedUpdatedAt, counts })).digest('hex');

function load<T>(filename: string, modules: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const instance = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, instance, instance.exports);
  return instance.exports as T;
}

function repoHarness(options: { missing?: boolean; active?: boolean; stale?: boolean; queueFailure?: boolean; queueCount?: number; deleteFailure?: boolean } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const policies: unknown[] = [];
  let companyPresent = true;
  let receipts = 0;
  let schemaCalls = 0;
  const db = { query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('as matches')) return { rows: options.missing ? [] : [{ title: confirmationTitle, archived_at: options.active ? null : expectedUpdatedAt, matches: !options.stale }] };
    if (sql.includes('select cc.id::text')) return { rows: options.missing ? [] : [{ id: '13', title: confirmationTitle,
      archived_at: options.active ? null : expectedUpdatedAt, updated_at: expectedUpdatedAt, ...counts }] };
    if (sql.includes('insert into client_document_file_cleanup')) {
      if (options.queueFailure) throw new Error('synthetic queue unavailable');
      receipts = options.queueCount ?? 2;
      return { rows: Array.from({ length: receipts }, (_, index) => ({ id: String(index + 8) })) };
    }
    if (sql.startsWith('delete from client_companies')) {
      if (options.deleteFailure) throw new Error('synthetic cascade failure');
      companyPresent = false;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  } };
  const repo = load<typeof import('../src/shared/lib/db/clientArchivePurgeRepo')>('src/shared/lib/db/clientArchivePurgeRepo.ts', {
    'node:crypto': crypto,
    './schema': { ensureSiteSchema: async () => { schemaCalls++; } },
    './clientCompaniesRepo': { ClientArchiveConflictError: ArchiveConflict },
    './clientCompaniesRepo.helpers': { canSeeAllClients: allowed },
    './client': { query: db.query, withTransaction: async (run: (client: unknown) => Promise<unknown>, policy: unknown) => {
      policies.push(policy);
      try { return await run(db); } catch (error) { companyPresent = true; receipts = 0; throw error; }
    } },
  });
  return { repo, calls, policies, schemaCalls: () => schemaCalls, companyPresent: () => companyPresent, receipts: () => receipts };
}

test('purge preview uses one read-only SQL snapshot with complete consequences and no deletion receipts', async () => {
  const h = repoHarness();
  const preview = await h.repo.getClientCompanyDeletionPreview(13, { role: 'admin' });
  assert.deepEqual(preview.counts, counts);
  assert.equal(preview.revision, expectedRevision);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].sql, /^select/);
  assert.equal(h.receipts(), 0);
  assert.equal(h.companyPresent(), true);
});

test('purge repository rejects manager, invalid ids and malformed revision before schema/DB access', async () => {
  const h = repoHarness();
  const confirmation = { expectedUpdatedAt, expectedRevision, confirmationTitle };
  await assert.rejects(h.repo.getClientCompanyDeletionPreview(13, { role: 'manager', managerId: 1 }), /администратору/);
  await assert.rejects(h.repo.purgeArchivedClientCompany(13, { role: 'support_manager', managerId: 2 }, confirmation), /администратору/);
  await assert.rejects(h.repo.purgeArchivedClientCompany(0, { role: 'admin' }, confirmation), /Некорректная/);
  await assert.rejects(h.repo.purgeArchivedClientCompany(13, { role: 'admin' }, { ...confirmation, expectedUpdatedAt: 'invalid' }), ArchiveConflict);
  assert.equal(h.schemaCalls(), 0);
  assert.deepEqual(h.calls, []);
});

test('purge rejects active, missing, stale and mistyped target before any destructive SQL', async () => {
  for (const options of [{ active: true }, { missing: true }, { stale: true }, {}]) {
    const h = repoHarness(options);
    await assert.rejects(h.repo.purgeArchivedClientCompany(13, { role: 'admin' }, {
      expectedUpdatedAt, expectedRevision, confirmationTitle: Object.keys(options).length ? confirmationTitle : 'different title',
    }));
    assert.equal(h.calls.length, 1);
    assert.equal(h.companyPresent(), true);
    assert.equal(h.receipts(), 0);
  }
});

test('purge locks exact company and dependencies then enqueues ALL file paths before company cascade', async () => {
  const h = repoHarness();
  const result = await h.repo.purgeArchivedClientCompany(13, { role: 'wholesale_admin' }, { expectedUpdatedAt, expectedRevision, confirmationTitle });
  assert.match(h.calls[0].sql, /where id=\$1 for update/);
  assert.deepEqual(h.calls[0].params, [13, expectedUpdatedAt]);
  for (const table of ['client_users', 'client_documents', 'wholesale_price_lists']) {
    assert.ok(h.calls.some(({ sql }) => sql.includes(`from ${table}`) && sql.includes('order by id for update')));
  }
  const queueIndex = h.calls.findIndex(({ sql }) => sql.includes('insert into client_document_file_cleanup'));
  const deleteIndex = h.calls.findIndex(({ sql }) => sql.startsWith('delete from client_companies'));
  assert.ok(queueIndex >= 0 && queueIndex < deleteIndex);
  assert.match(h.calls[queueIndex].sql, /select id,company_id,file_path from client_documents where company_id=\$1/);
  assert.equal(h.calls.some(({ sql }) => /delete from wholesale_price/.test(sql)), false);
  assert.deepEqual(result.cleanupIds, [8, 9]);
  assert.equal(result.detachedPriceLists, counts.priceLists);
  assert.equal('priceLists' in result.removed, false);
  assert.equal(h.companyPresent(), false);
  assert.equal(h.receipts(), 2);
  assert.deepEqual(h.policies, [{ profile: 'interactive', trackCommitOutcome: true }]);
});

test('queue failure, incomplete queue and cascade failure rollback all destructive work', async () => {
  for (const options of [{ queueFailure: true }, { queueCount: 1 }, { deleteFailure: true }]) {
    const h = repoHarness(options);
    await assert.rejects(h.repo.purgeArchivedClientCompany(13, { role: 'admin' }, { expectedUpdatedAt, expectedRevision, confirmationTitle }));
    assert.equal(h.companyPresent(), true);
    assert.equal(h.receipts(), 0);
    if (!options.deleteFailure) assert.equal(h.calls.some(({ sql }) => sql.startsWith('delete from client_companies')), false);
  }
});

function routeHarness(options: { role?: AdminSession['role']; denied?: boolean; crossOrigin?: boolean; limited?: boolean;
  error?: Error; postCommitFails?: boolean; jobs?: number } = {}) {
  const calls: string[] = [];
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { requireEmployee: async () => options.denied
      ? { denied: new Response(null, { status: 401 }) } : { session: { role: options.role ?? 'admin' } } },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => options.limited ? new Response(null, { status: 429 }) : null },
    '@/shared/lib/db/clientCompaniesRepo.helpers': { canSeeAllClients: allowed },
    '@/shared/lib/db/clientCompaniesRepo': { ClientArchiveConflictError: ArchiveConflict },
    '@/shared/lib/db/transactionOutcome': outcomes,
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => options.crossOrigin ? new Response(null, { status: 403 }) : null },
    '@/shared/lib/postCommitTasks': postCommit,
    '@/shared/lib/rateLimit': { getClientIp: () => '127.0.0.1' },
    '@/shared/lib/db/clientArchivePurgeRepo': {
      purgeArchivedClientCompany: async (id: number, _session: unknown, confirmation: unknown) => {
        assert.equal(id, 13);
        assert.deepEqual(confirmation, { expectedUpdatedAt, expectedRevision, confirmationTitle });
        calls.push('purge');
        if (options.error) throw options.error;
        return { id, title: confirmationTitle, removed: counts, detachedPriceLists: 6,
          cleanupIds: Array.from({ length: options.jobs ?? 2 }, (_, index) => index + 8) };
      },
      getClientCompanyDeletionPreview: async () => { calls.push('preview'); return { id: 13, counts }; },
    },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async () => {
      calls.push('audit'); if (options.postCommitFails) throw new Error('synthetic audit failure');
    } },
    '@/shared/lib/clientRealtime': { publishClientRealtimeEvent: () => {
      calls.push('notify'); if (options.postCommitFails) throw new Error('synthetic notification failure');
    } },
  };
  const purge = load<{ POST: (request: Request, context: unknown) => Promise<Response> }>('src/app/api/admin/clients/[id]/purge/route.ts', modules);
  const preview = load<{ GET: (request: Request, context: unknown) => Promise<Response> }>('src/app/api/admin/clients/[id]/deletion-preview/route.ts', modules);
  const context = { params: Promise.resolve({ id: '13' }) };
  return { calls,
    run: (body: unknown = { expectedUpdatedAt, expectedRevision, confirmationTitle }) => purge.POST(new Request('https://example.test', { method: 'POST', body: JSON.stringify(body) }), context),
    preview: () => preview.GET(new Request('https://example.test'), context),
  };
}

test('purge routes enforce authentication, elevated role, origin, rate and explicit confirmation', async () => {
  for (const [flags, expected] of [[{ denied: true }, 401], [{ role: 'manager' as const }, 403], [{ crossOrigin: true }, 403], [{ limited: true }, 429]] as const) {
    const h = routeHarness(flags);
    assert.equal((await h.run()).status, expected);
    assert.deepEqual(h.calls, []);
  }
  for (const [body, expected] of [[{}, 428], [{ expectedUpdatedAt }, 428], [{ expectedUpdatedAt, expectedRevision }, 400], [{ expectedUpdatedAt, expectedRevision, confirmationTitle: '' }, 400]] as const) {
    const h = routeHarness();
    assert.equal((await h.run(body)).status, expected);
    assert.deepEqual(h.calls, []);
  }
  const previewDenied = routeHarness({ role: 'support_manager' });
  assert.equal((await previewDenied.preview()).status, 403);
  assert.deepEqual(previewDenied.calls, []);
});

test('preview response is private/no-store and cannot start filesystem cleanup', async () => {
  const h = routeHarness();
  const response = await h.preview();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(h.calls, ['preview']);
});

test('purge conflict or uncertain commit never starts cleanup and distinguishes unsaved from unknown', async () => {
  for (const [error, status, saved] of [[new ArchiveConflict(), 409, false], [new outcomes.TransactionCommitUnknownError(), 503, null], [new Error('failed'), 400, false]] as const) {
    const h = routeHarness({ error });
    const response = await h.run();
    assert.equal(response.status, status);
    assert.equal((await response.json()).saved, saved);
    assert.deepEqual(h.calls, ['purge']);
  }
});

test('purge queues exact jobs without physical cleanup, including large document collections', async () => {
  const h = routeHarness({ jobs: 40 });
  const response = await h.run();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.saved, true);
  assert.equal(body.cleanupQueued, 40);
  assert.equal(body.cleanupPending, 40);
  assert.equal(h.calls[0], 'purge');
  assert.equal(h.calls.filter((call) => call === 'cleanup').length, 0);
  assert.ok(body.warnings.some((warning: { code: string }) => warning.code === 'CLIENT_FILE_CLEANUP_PENDING'));
});

test('postcommit audit/notification failure cannot claim the company deletion was rolled back', async () => {
  const h = routeHarness({ postCommitFails: true });
  const response = await h.run();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.saved, true);
  assert.equal(body.cleanupPending, 2);
  assert.equal(body.warnings.length, 3);
  assert.deepEqual(h.calls, ['purge', 'audit', 'notify']);
});

test('changed consequence revision rejects before creating receipts even when company timestamp matches', async () => {
  const h = repoHarness();
  await assert.rejects(h.repo.purgeArchivedClientCompany(13, { role: 'admin' }, {
    expectedUpdatedAt, expectedRevision: '0'.repeat(64), confirmationTitle,
  }), ArchiveConflict);
  assert.equal(h.companyPresent(), true);
  assert.equal(h.receipts(), 0);
  assert.equal(h.calls.some(({ sql }) => /insert into|delete from/.test(sql)), false);
});
