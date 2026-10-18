import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as identifierConflicts from '../src/shared/lib/employeeIdentifierConflict';
import * as management from '../src/shared/lib/accessUserManagement';
import * as dashboards from '../src/shared/lib/dashboardAccess';
import * as versions from '../src/shared/lib/recordVersion';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';

test('only employee identifier constraints become a generic conflict, without database details', () => {
  for (const constraint of ['employee_login_identifiers_unique', 'admin_users_login_key', 'wholesale_managers_login_key']) {
    const pgError = Object.assign(new Error('Conflicting sensitive SQL detail'), { code: '23505', constraint, detail: 'Synthetic-private-identifier' });
    assert.throws(() => identifierConflicts.rethrowEmployeeIdentifierConflict(pgError), (error: unknown) => {
      assert.ok(error instanceof identifierConflicts.EmployeeIdentifierConflictError);
      assert.equal(error.code, 'EMPLOYEE_IDENTIFIER_CONFLICT');
      assert.match(error.message, /логин или email уже используется/);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /sensitive|Synthetic-private|SQL/);
      return true;
    });
  }
  for (const error of [new Error('Unrelated failure'), { code: '23505', constraint: 'other_unique' }, { code: '40P01' }, null]) {
    assert.throws(() => identifierConflicts.rethrowEmployeeIdentifierConflict(error), (received: unknown) => received === error);
  }
});

function route(path: string) {
  let attemptedWrites = 0;
  const audits: unknown[] = [];
  const conflict = async () => { attemptedWrites++; throw new identifierConflicts.EmployeeIdentifierConflictError(); };
  const session = { role: 'admin', adminUserId: 1, sessionId: 'synthetic' };
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { requireDashboardAccessManagementSession: async () => ({ session }), requireWholesaleAdminSession: async () => ({ session }) },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => null },
    '@/shared/lib/employeeIdentifierConflict': identifierConflicts,
    '@/shared/lib/employeePasswordHash': { hashEmployeePassword: async () => 'synthetic-not-returned-hash' },
    '@/shared/lib/accessUserManagement': management,
    '@/shared/lib/dashboardAccess': dashboards,
    '@/shared/lib/recordVersion': versions,
    '@/shared/lib/db': { createAccessUser: conflict, updateAccessUser: conflict, createWholesaleManager: conflict, updateWholesaleManager: conflict,
      getWholesaleManagerById: async () => ({ id: 42, revision: '1', isActive: true, canAccessTopDashboard: false, canManageTopDashboard: false }) },
    '@/shared/lib/db/dashboardAccessRepo': {},
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async (event: unknown) => { audits.push(event); } },
    '@/shared/lib/managerSessionPolicy': { shouldRevokeManagerSessionsForUpdate: () => false },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
    '@/shared/lib/passwordPolicy': { validatePasswordPolicy: () => ({ ok: true }) },
    '@/shared/lib/rateLimit': { getClientIp: () => '127.0.0.1' },
    '@/shared/lib/wholesaleSecurity': { normalizeTextField: (value: unknown) => typeof value === 'string' ? value.trim() : '' },
  };
  type Route = Record<'POST' | 'PUT', (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>>;
  const loaded = { exports: {} as Route };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'module', 'exports', code)((key: string) => { assert.ok(key in modules, key); return modules[key]; }, loaded, loaded.exports);
  return { handlers: loaded.exports, audits, attemptedWrites: () => attemptedWrites };
}

for (const [path, method, id] of [
  ['src/app/api/admin/users/route.ts', 'POST', 'admin:42'],
  ['src/app/api/admin/users/[id]/route.ts', 'PUT', 'admin:42'],
  ['src/app/api/admin/wholesale/managers/route.ts', 'POST', '42'],
  ['src/app/api/admin/wholesale/managers/[id]/route.ts', 'PUT', '42'],
] as const) {
  test(`${method} ${path} returns a friendly 409 and no success audit on identifier collision`, async () => {
    const api = route(path);
    const request = new Request('https://example.test/api/admin/users', { method,
      headers: { origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Synthetic', login: 'Synthetic-conflict', email: 'Synthetic-private@example.test',
        password: method === 'POST' ? 'SyntheticPassword123!' : '', role: 'top', expectedRevision: '1' }),
    });
    const response = await api.handlers[method](request, { params: Promise.resolve({ id }) });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: 'EMPLOYEE_IDENTIFIER_CONFLICT', error: new identifierConflicts.EmployeeIdentifierConflictError().message });
    assert.equal(api.attemptedWrites(), 1);
    assert.deepEqual(api.audits, []);
  });
}
