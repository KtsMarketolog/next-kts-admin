import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as versions from '../src/shared/lib/recordVersion';
import * as identifierConflicts from '../src/shared/lib/employeeIdentifierConflict';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';

function route() {
  const writes: Array<Record<string, unknown>> = [];
  const audits: unknown[] = [];
  let hashes = 0;
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { requireWholesaleAdminSession: async () => ({ session: { role: 'admin', adminUserId: 1, sessionId: 'synthetic' } }) },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => null },
    '@/shared/lib/employeePasswordHash': { hashEmployeePassword: async () => { hashes++; return 'synthetic-hash'; } },
    '@/shared/lib/recordVersion': versions,
    '@/shared/lib/employeeIdentifierConflict': identifierConflicts,
    '@/shared/lib/db': {
      getWholesaleManagerById: async () => ({ id: 42, revision: '2', isActive: false, canAccessTopDashboard: false, canManageTopDashboard: false }),
      updateWholesaleManager: async (_id: number, input: Record<string, unknown>) => {
        versions.assertRecordRevision(input.expectedRevision, '2');
        writes.push(input);
        return { revision: '3' };
      },
    },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async (event: unknown) => { audits.push(event); } },
    '@/shared/lib/managerSessionPolicy': { shouldRevokeManagerSessionsForUpdate: () => false },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
    '@/shared/lib/passwordPolicy': { validatePasswordPolicy: () => ({ ok: true }) },
    '@/shared/lib/rateLimit': { getClientIp: () => '127.0.0.1' },
    '@/shared/lib/wholesaleSecurity': { normalizeTextField: (value: unknown) => typeof value === 'string' ? value.trim() : '' },
  };
  const code = ts.transpileModule(readFileSync('src/app/api/admin/wholesale/managers/[id]/route.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} as { PUT(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> } };
  new Function('require', 'module', 'exports', code)((key: string) => { assert.ok(key in modules, key); return modules[key]; }, loaded, loaded.exports);
  const request = (expectedRevision: unknown) => new Request('https://example.test/api/admin/wholesale/managers/42', {
    method: 'PUT', headers: { origin: 'https://example.test', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Synthetic', login: 'synthetic', isActive: true, password: 'SyntheticPassword123', expectedRevision }),
  });
  return { write: (revision: unknown) => loaded.exports.PUT(request(revision), { params: Promise.resolve({ id: '42' }) }), writes, audits, hashes: () => hashes };
}

test('legacy manager update requires loaded revision, rejects conflicts and returns committed revision', async () => {
  for (const revision of [undefined, '', 2, '0', '1']) {
    const api = route();
    const response = await api.write(revision);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'RECORD_VERSION_CONFLICT');
    assert.deepEqual(api.writes, []);
    assert.deepEqual(api.audits, []);
    if (revision !== '1') assert.equal(api.hashes(), 0, 'invalid version is rejected before hashing');
  }
  const api = route();
  const response = await api.write('2');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, '3');
  assert.equal(api.writes[0].expectedRevision, '2');
  assert.equal(api.audits.length, 1);
});
