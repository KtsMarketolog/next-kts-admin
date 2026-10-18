import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as save from '../src/shared/lib/wholesalePriceSave';
import * as security from '../src/shared/lib/wholesaleSecurity';
import * as access from '../src/shared/lib/wholesalePriceListAccess';
import * as workflow from '../src/shared/lib/wholesalePriceWorkflowStatus';
import * as versions from '../src/shared/lib/recordVersion';

// Execute the actual handlers. Stub only IO/auth, not the body parser or handler
// control flow. No connection to an application database is possible here.
function handler(method: 'POST' | 'PUT', options: { saveError?: Error; notificationError?: boolean } = {}) {
  const writes: Array<{ items: unknown[]; expectedRevision?: string }> = [];
  let assignments = 0;
  let notifications = 0;
  const filename = method === 'POST'
    ? '../src/app/api/admin/wholesale/price-lists/route.ts'
    : '../src/app/api/admin/wholesale/price-lists/[id]/route.ts';
  const code = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules: Record<string, unknown> = {
    crypto: { randomBytes: () => Buffer.alloc(12, 1) },
    '@/shared/lib/wholesalePriceSave': save,
    '@/shared/lib/wholesaleSecurity': security,
    '@/shared/lib/wholesalePriceListAccess': access,
    '@/shared/lib/wholesalePriceWorkflowStatus': workflow,
    '@/shared/lib/recordVersion': versions,
    '@/shared/lib/adminAuth': { requireEmployee: async () => ({ session: { role: 'admin' } }) },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => null },
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => null },
    '@/shared/lib/clientRealtime': { publishClientRealtimeEvent: () => {
      notifications++;
      if (options.notificationError) throw new Error('Synthetic notification failure');
    } },
    '@/shared/lib/db/securityAuditRepo': {},
    '@/shared/lib/rateLimit': {},
    '@/shared/lib/db': {
      getWholesalePriceListEditor: async () => ({ token: 'existing-token-not-changed', revision: '7' }),
      createWholesalePriceList: async (input: { items: unknown[] }) => {
        if (options.saveError) throw options.saveError;
        writes.push(input); return 45;
      },
      updateWholesalePriceList: async (_id: number, input: { items: unknown[] }) => {
        if (options.saveError) throw options.saveError;
        writes.push(input); return '8';
      },
      updateClientCompanyManagerAssignments: async () => { assignments++; },
    },
  };
  const stubModule = { exports: {} as Record<string, (request: Request, context: unknown) => Promise<Response>> };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, stubModule, stubModule.exports);
  return { run: (request: Request) => stubModule.exports[method](request, { params: Promise.resolve({ id: '45' }) }),
    writes, assignments: () => assignments, notifications: () => notifications };
}

function payload() {
  return {
    title: 'Synthetic large price', clientCompanyId: 1, managerId: 2, supportManagerId: 3, expectedRevision: '7',
    items: Array.from({ length: 7474 }, (_, i) => ({
      productId: i + 1, variantId: null, visible: i >= 5000, priceManuallyChanged: i === 7473,
      customWholesalePrice: '123.45', discountPercent: '61', sortOrder: i + 1,
    })),
  };
}

for (const method of ['POST', 'PUT'] as const) {
  test(`${method} passes all 7474 rows to persistence including late manual prices and hidden rows`, async () => {
    const h = handler(method);
    const body = payload();
    const response = await h.run(new Request('https://example.test/api/price', { method, body: JSON.stringify(body) }));
    assert.equal(response.status, 200);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.writes[0].items, body.items);
    assert.equal(h.assignments(), 0, 'company assignment belongs to the database transaction, not a second route write');
    assert.equal(h.notifications(), 1);
    if (method === 'PUT') {
      assert.equal(h.writes[0].expectedRevision, '7');
      assert.equal((await response.json()).revision, '8');
    }
  });

  test(`${method} rejected atomic save does not publish an event or run a second assignment write`, async () => {
    const h = handler(method, { saveError: new Error('Менеджер по развитию не найден или отключен') });
    const response = await h.run(new Request('https://example.test/api/price', { method, body: JSON.stringify(payload()) }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Менеджер по развитию/);
    assert.equal(h.writes.length, 0);
    assert.equal(h.assignments(), 0);
    assert.equal(h.notifications(), 0);
  });

  test(`${method} realtime failure after commit still reports a successful save`, async () => {
    const h = handler(method, { notificationError: true });
    const response = await h.run(new Request('https://example.test/api/price', { method, body: JSON.stringify(payload()) }));
    assert.equal(response.status, 200);
    assert.equal(h.writes.length, 1);
    assert.equal(h.assignments(), 0);
    assert.equal(h.notifications(), 1);
  });

  test(`${method} invalid late item or absent items rejects the whole save before any write`, async () => {
    for (const body of [{ ...payload(), items: undefined }, { ...payload(), items: [...payload().items, null] }]) {
      const h = handler(method);
      const response = await h.run(new Request('https://example.test/api/price', { method, body: JSON.stringify(body) }));
      assert.equal(response.status, 400);
      assert.equal(h.writes.length, 0);
      assert.equal(h.assignments(), 0);
    }
  });

  test(`${method} overlarge requests return 413 without saving any part of the price`, async () => {
    const h = handler(method);
    const response = await h.run(new Request('https://example.test/api/price', {
      method, body: '{}', headers: { 'content-length': String(save.MAX_WHOLESALE_PRICE_BODY_BYTES + 1) },
    }));
    assert.equal(response.status, 413);
    assert.equal(h.writes.length, 0);
    assert.equal(h.assignments(), 0);
  });
}

test('PUT returns a distinct 409 for stale revisions and never publishes a successful-save event', async () => {
  const h = handler('PUT', { saveError: new versions.RecordVersionConflictError() });
  const response = await h.run(new Request('https://example.test/api/price', { method: 'PUT', body: JSON.stringify(payload()) }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'RECORD_VERSION_CONFLICT');
  assert.equal(h.writes.length, 0);
  assert.equal(h.notifications(), 0);
});

test('PUT fails closed for older clients with no valid expected revision, rather than adopting a fresh server token', async () => {
  for (const expectedRevision of [undefined, null, '', '0', 7, '7.0']) {
    const h = handler('PUT');
    const response = await h.run(new Request('https://example.test/api/price', {
      method: 'PUT', body: JSON.stringify({ ...payload(), expectedRevision }),
    }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'RECORD_VERSION_CONFLICT');
    assert.equal(h.writes.length, 0);
    assert.equal(h.notifications(), 0);
  }
});
