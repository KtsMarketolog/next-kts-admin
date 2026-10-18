import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as postCommitTasks from '../src/shared/lib/postCommitTasks';
import * as outcome from '../src/shared/lib/db/transactionOutcome';
import * as security from '../src/shared/lib/wholesaleSecurity';

// Execute actual handlers, replacing authentication/database IO only. No live
// customer, password, database, email or realtime provider is used.
class ClientArchiveConflictError extends Error {}

function handler(method: 'POST' | 'PUT' | 'DELETE' | 'RESTORE', options: {
  saveError?: Error;
  realtimeError?: boolean;
  failedAudits?: string[];
  denied?: boolean;
  forbidden?: boolean;
  limited?: boolean;
} = {}) {
  const writes: unknown[][] = [];
  const audits: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
  let notifications = 0;
  const company = { id: 13, title: 'Synthetic company', managerId: 21, supportManagerId: 22, clientUserId: 31, userCount: 1 };
  const save = async (...args: unknown[]) => {
    if (options.saveError) throw options.saveError;
    writes.push(args);
    return company;
  };
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => options.limited ? new Response('', { status: 429 }) : null },
    '@/shared/lib/adminAuth': {
      requireEmployee: async () => ({ denied: options.denied ? new Response('', { status: 401 }) : null, session: { role: 'admin', adminUserId: 1 } }),
      hashPassword: () => 'synthetic-hash',
    },
    '@/shared/lib/db': {
      createClientCompany: save, updateClientCompany: save, deleteClientCompany: save,
      restoreClientCompany: save, ClientArchiveConflictError,
      revokeClientUserSessions: () => assert.fail('Session revocation must be inside the transaction'),
      updateWholesalePriceListManagerAssignmentsForClientCompany: () => assert.fail('Assignments must be inside the transaction'),
    },
    '@/shared/lib/clientRealtime': { publishClientRealtimeEvent: () => {
      notifications++;
      if (options.realtimeError) throw new Error('Synthetic realtime failure');
    } },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async (input: { eventType: string }, auditOptions: { required?: boolean }) => {
      assert.equal(auditOptions.required, true, 'A failed audit must be observable');
      audits.push(input);
      if (options.failedAudits?.includes(input.eventType)) throw new Error('Synthetic audit failure');
    } },
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => options.forbidden ? new Response('', { status: 403 }) : null },
    '@/shared/lib/passwordPolicy': { validatePasswordPolicy: () => ({ ok: true }) },
    '@/shared/lib/rateLimit': { getClientIp: () => '127.0.0.1' },
    '@/shared/lib/wholesaleSecurity': security,
    '@/shared/lib/postCommitTasks': postCommitTasks,
    '@/shared/lib/db/transactionOutcome': outcome,
  };
  const path = method === 'RESTORE' ? '../src/app/api/admin/clients/[id]/restore/route.ts'
    : method === 'POST' ? '../src/app/api/admin/clients/route.ts' : '../src/app/api/admin/clients/[id]/route.ts';
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const stubModule = { exports: {} as Record<string, (request: Request, context: unknown) => Promise<Response>> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, stubModule, stubModule.exports);
  return {
    company, writes, audits, notifications: () => notifications,
    run: (body: Record<string, unknown> = { title: company.title, email: 'synthetic@example.invalid', password: 'Synthetic123!', expectedUpdatedAt: '2026-10-18T10:00:00.123456Z' }) => stubModule.exports[method === 'RESTORE' ? 'POST' : method](
      new Request('https://example.test/api/admin/clients/13', { method: method === 'RESTORE' ? 'POST' : method, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: '13' }) },
    ),
  };
}

for (const method of ['POST', 'PUT', 'DELETE', 'RESTORE'] as const) {
  test(`${method} client save responds with a confirmed result and no duplicate database steps`, async () => {
    const h = handler(method);
    const response = await h.run();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.saved, true);
    assert.deepEqual(body.warnings, []);
    if (method !== 'DELETE') assert.deepEqual(body.company, h.company);
    assert.equal(h.writes.length, 1);
    assert.equal(h.notifications(), 1);
    assert.deepEqual(h.audits.map((event) => event.eventType), method === 'PUT'
      ? ['password_changed', 'client_company_updated']
      : [method === 'POST' ? 'client_company_created' : method === 'DELETE' ? 'client_company_archived' : 'client_company_restored']);
    assert.doesNotMatch(JSON.stringify(h.audits), /Synthetic123!|synthetic-hash/);
  });

  test(`${method} client business failure does not notify or record a successful save`, async () => {
    const h = handler(method, { saveError: new Error('Компания клиента не найдена') });
    const response = await h.run();
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.saved, false);
    assert.equal(h.writes.length, 0);
    assert.equal(h.notifications(), 0);
    assert.deepEqual(h.audits, []);
  });

  test(`${method} realtime/audit failure after commit is a warning, not an unsaved response`, async () => {
    const h = handler(method, { realtimeError: true, failedAudits: ['password_changed', 'client_company_created', 'client_company_updated', 'client_company_archived', 'client_company_restored'] });
    const response = await h.run();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.saved, true);
    assert.equal(body.error, undefined);
    assert.equal(body.warnings.length, method === 'PUT' ? 3 : 2);
    assert.equal(h.writes.length, 1);
    assert.equal(h.audits.length, method === 'PUT' ? 2 : 1, 'One failed auxiliary task cannot skip another');
  });

  test(`${method} uncertain commit never claims the operation was rolled back`, async () => {
    const h = handler(method, { saveError: new outcome.TransactionCommitUnknownError() });
    const response = await h.run();
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.saved, null);
    assert.equal(body.code, 'COMMIT_OUTCOME_UNKNOWN');
    assert.equal(h.notifications(), 0);
    assert.deepEqual(h.audits, []);
  });
}

for (const method of ['PUT', 'DELETE', 'RESTORE'] as const) {
  test(`${method} requires a valid version from the confirmation`, async () => {
    for (const expectedUpdatedAt of [undefined, '', 'not-a-date', 123]) {
      const h = handler(method);
      assert.equal((await h.run({ expectedUpdatedAt })).status, 428);
      assert.equal(h.writes.length, 0);
    }
  });
  test(`${method} stale confirmation returns conflict without successful audit`, async () => {
    const h = handler(method, { saveError: new ClientArchiveConflictError('Reload before archive') });
    assert.equal((await h.run()).status, 409);
    assert.equal(h.notifications(), 0);
    assert.deepEqual(h.audits, []);
  });
  test(`${method} keeps authentication, origin and rate-limit gates`, async () => {
    for (const [key, status] of [['denied', 401], ['forbidden', 403], ['limited', 429]] as const) {
      const h = handler(method, { [key]: true });
      assert.equal((await h.run()).status, status);
      assert.equal(h.writes.length, 0);
    }
  });
}

test('PUT without a new password does not create a misleading password-change audit', async () => {
  const h = handler('PUT');
  const response = await h.run({ title: 'Synthetic company', email: 'synthetic@example.invalid', password: '', expectedUpdatedAt: '2026-10-18T10:00:00.123456Z' });
  assert.equal(response.status, 200);
  assert.deepEqual(h.audits.map((event) => event.eventType), ['client_company_updated']);
});
