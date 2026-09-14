import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { lockPriceListCompany, writePriceListCompanyAssignment } from '../src/shared/lib/db/wholesaleAdminRepo/priceListCompanyWrite';

function fixture(options: { badRole?: boolean; inactive?: boolean; companyMissing?: boolean; affected?: number } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes('from wholesale_managers')) return { rows: [
      { id: '2', role: options.badRole ? 'support_manager' : 'manager', is_active: !options.inactive },
      { id: '3', role: 'support_manager', is_active: true },
    ] };
    if (sql.includes('from client_companies')) return { rows: options.companyMissing ? [] : [{ id: '1', title: 'Verified company' }] };
    if (sql.includes('update client_companies')) return { rowCount: options.affected ?? 1 };
    throw new Error('Unexpected SQL');
  } } as unknown as PoolClient;
  return { client, calls };
}
const assignment = { managerId: 2, supportManagerId: 3 };

test('assignment validation uses the supplied transaction and locks roles/company without writing', async () => {
  const f = fixture();
  assert.deepEqual(await lockPriceListCompany(f.client, 1, assignment, { role: 'admin' }), { id: 1, title: 'Verified company' });
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].sql, /order by id for share/);
  assert.match(f.calls[1].sql, /for update/);
  assert.deepEqual(f.calls[0].params, [[2, 3]]);
  assert.deepEqual(f.calls[1].params, [1, true, 0]);
  for (const call of f.calls) assert.match(call.sql, /^select/);
});

test('manager company access is checked in the same locked SELECT; admin and wholesale admin keep full access', async () => {
  for (const role of ['manager', 'support_manager', 'admin', 'wholesale_admin'] as const) {
    const f = fixture();
    await lockPriceListCompany(f.client, 1, assignment, { role, managerId: 2 });
    assert.deepEqual(f.calls[1].params, [1, ['admin', 'wholesale_admin'].includes(role), 2]);
    assert.match(f.calls[1].sql, /is_active = true/);
    assert.match(f.calls[1].sql, /manager_id = \$3 or support_manager_id = \$3/);
  }
});

test('missing required company/manager input fails before any query', async () => {
  for (const [company, managers] of [[null, assignment], [0, assignment], [1, { managerId: null, supportManagerId: 3 }],
    [1, { managerId: 2, supportManagerId: null }]] as const) {
    const f = fixture();
    await assert.rejects(lockPriceListCompany(f.client, company, managers));
    assert.equal(f.calls.length, 0);
  }
});

test('wrong role and inactive managers are rejected before reading or changing company', async () => {
  for (const options of [{ badRole: true }, { inactive: true }]) {
    const f = fixture(options);
    await assert.rejects(lockPriceListCompany(f.client, 1, assignment), /Менеджер по развитию/);
    assert.equal(f.calls.length, 1);
  }
});

test('missing/inactive/inaccessible company cannot be assigned by a zero-row operation', async () => {
  const f = fixture({ companyMissing: true });
  await assert.rejects(lockPriceListCompany(f.client, 1, assignment), /Клиент/);
  assert.equal(f.calls.length, 2);
});

test('assignment update is scoped to the selected company on the supplied transaction', async () => {
  const f = fixture();
  await writePriceListCompanyAssignment(f.client, 1, assignment);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params, [1, 2, 3]);
  assert.match(f.calls[0].sql, /where id = \$1/);
  assert.doesNotMatch(f.calls[0].sql, /wholesale_price_lists|delete|truncate/i);
});

test('unexpected affected-row count fails so the outer price transaction can roll back', async () => {
  for (const affected of [0, 2]) {
    const f = fixture({ affected });
    await assert.rejects(writePriceListCompanyAssignment(f.client, 1, assignment), /Не удалось сохранить назначение/);
  }
});
