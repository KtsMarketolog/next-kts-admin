import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmployeeActionLock, employeeRequest, EMPLOYEE_UNKNOWN_OUTCOME, readLegacyEmployeePasswordCandidates, removeLegacyEmployeePasswordCandidates, withoutEmployeePassword } from '../src/features/admin/shared/employeeRequest';

test('employee mutations report an unknown outcome on network rejection, not a definite failed save', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Network down'); });
  await assert.rejects(employeeRequest('/synthetic', { method: 'PUT' }, { mutation: true }), { message: EMPLOYEE_UNKNOWN_OUTCOME });
});

test('a never-resolving fetch times out, aborts, and allows the action lock to release', async (context) => {
  let signal: AbortSignal | undefined;
  context.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => { signal = init.signal ?? undefined; return new Promise(() => {}); });
  const lock = createEmployeeActionLock();
  assert.equal(lock.acquire(), true);
  assert.equal(lock.acquire(), false, 'overlapping actions and same-tick double clicks are blocked');
  try {
    await assert.rejects(employeeRequest('/synthetic', { method: 'POST' }, { mutation: true, timeoutMs: 5 }), { message: EMPLOYEE_UNKNOWN_OUTCOME });
  } finally { lock.release(); }
  assert.equal(signal?.aborted, true);
  assert.equal(lock.acquire(), true, 'timeout never permanently locks the UI');
  lock.release();
});

test('response body is also covered by the deadline', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: () => new Promise(() => {}) }));
  await assert.rejects(employeeRequest('/synthetic', {}, { mutation: true, timeoutMs: 5 }), { message: EMPLOYEE_UNKNOWN_OUTCOME });
});

test('reveal calls always fetch fresh no-store data with no cached password in their payload', async (context) => {
  const calls: RequestInit[] = [];
  context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => { calls.push(init); return Response.json({ password: calls.length === 1 ? 'SyntheticFirst123' : 'SyntheticNewer123' }); });
  const first = await employeeRequest<{ password: string }>('/synthetic/password', { method: 'POST', body: '{}' });
  const second = await employeeRequest<{ password: string }>('/synthetic/password', { method: 'POST', body: '{}' });
  assert.notEqual(first.password, second.password);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.cache === 'no-store' && call.body === '{}'));
});

test('HTTP validation errors retain useful messages; ambiguous server failures do not claim rollback', async (context) => {
  const mock = context.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Логин уже занят' }, { status: 400 }));
  await assert.rejects(employeeRequest('/synthetic', {}, { mutation: true }), { message: 'Логин уже занят', status: 400 });
  mock.mock.mockImplementation(async () => Response.json({ error: 'Server failed after commit' }, { status: 503 }));
  await assert.rejects(employeeRequest('/synthetic', {}, { mutation: true }), { message: EMPLOYEE_UNKNOWN_OUTCOME });
});

test('legacy recovery reads only the exact account and cleanup preserves other accounts and concurrent changes', () => {
  const source = { id: 'manager:1', displayPassword: 'StaleSynthetic123', password: 'UnexpectedSynthetic123' };
  assert.deepEqual(withoutEmployeePassword(source), { id: 'manager:1' });
  assert.equal(source.displayPassword, 'StaleSynthetic123', 'does not mutate caller data');
  const memory: Record<string, string> = {
    'kts-admin-users-passwords-v1': JSON.stringify({ 'manager:1': 'FirstSynthetic123', 'manager:2': 'OtherSynthetic123', 'admin:1': 'AdminSynthetic123' }),
    'kts-admin-wholesale-manager-passwords-v1': JSON.stringify({ '1': 'SecondSynthetic123', '2': 'OtherSynthetic123' }),
    'kts-admin-client-company-passwords-v1': 'client-data-preserved',
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => memory[key] ?? null,
    setItem: (key: string, value: string) => { memory[key] = value; },
    removeItem: (key: string) => { delete memory[key]; },
  } } });
  try {
    const beforeRead = JSON.stringify(memory);
    const candidates = readLegacyEmployeePasswordCandidates('/api/admin/users/manager%3A1/password');
    assert.deepEqual(candidates.map((entry) => entry.password), ['FirstSynthetic123', 'SecondSynthetic123']);
    assert.equal(JSON.stringify(memory), beforeRead, 'reading candidates is nondestructive');
    assert.deepEqual(readLegacyEmployeePasswordCandidates('/api/admin/users/admin:1/password').map((entry) => entry.password), ['AdminSynthetic123']);
    assert.deepEqual(readLegacyEmployeePasswordCandidates('/api/admin/wholesale/managers/1/password').map((entry) => entry.password), ['SecondSynthetic123', 'FirstSynthetic123']);
    assert.deepEqual(readLegacyEmployeePasswordCandidates('/api/admin/users/manager:1/unknown'), []);
    memory['kts-admin-wholesale-manager-passwords-v1'] = JSON.stringify({ '1': 'ConcurrentNewer123', '2': 'OtherSynthetic123' });
    removeLegacyEmployeePasswordCandidates(candidates);
    assert.deepEqual(JSON.parse(memory['kts-admin-users-passwords-v1']), { 'manager:2': 'OtherSynthetic123', 'admin:1': 'AdminSynthetic123' });
    assert.deepEqual(JSON.parse(memory['kts-admin-wholesale-manager-passwords-v1']), { '1': 'ConcurrentNewer123', '2': 'OtherSynthetic123' });
    assert.equal(memory['kts-admin-client-company-passwords-v1'], 'client-data-preserved');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { throw new Error('Storage unavailable'); } } });
    assert.deepEqual(readLegacyEmployeePasswordCandidates('/api/admin/users/manager:1/password'), []);
    assert.doesNotThrow(() => removeLegacyEmployeePasswordCandidates(candidates));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
