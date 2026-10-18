import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import { AdminRequestError, ADMIN_UNKNOWN_OUTCOME, ADMIN_UPLOAD_TIMEOUT_MS } from '../src/features/admin/shared/adminRequest';
import { readApiError } from '../src/features/admin/wholesale/AdminWholesaleApiModel';

function callback(file: string, name: string, scope: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/features/admin/wholesale/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isArrowFunction(node.initializer)) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found);
  const js = ts.transpileModule(`const action=${found.getText(source)};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(scope), `${js}\nreturn action;`)(...Object.values(scope)) as (...args: unknown[]) => Promise<void>;
}

test('price deletion releases lock after network failure, retains prices and never retries automatically', async () => {
  let status = '';
  let busy = false;
  let calls = 0;
  const prices = [{ id: 41 }];
  const savingRef = { current: false };
  const remove = callback('AdminWholesaleGateway.tsx', 'deletePriceList', {
    savingRef, confirm: () => true, setBusy: (value: boolean) => { busy = value; },
    request: async () => { calls++; throw new AdminRequestError(ADMIN_UNKNOWN_OUTCOME, 'network'); },
    isActive: () => true, editorKey: 'manager', viewKeyRef: { current: 'manager' },
    setStatus: (value: string) => { status = value; }, AdminRequestError, ADMIN_UNKNOWN_OUTCOME,
    setPriceLists: () => assert.fail('Unconfirmed delete cannot remove a price from UI'), readApiError,
  });
  await Promise.all([remove(41), remove(41)]);
  assert.equal(calls, 1);
  assert.equal(busy, false);
  assert.equal(savingRef.current, false);
  assert.deepEqual(prices, [{ id: 41 }]);
  assert.match(status, /могло сохраниться/);
});

test('confirmed price deletion followed by failed refresh reports saved result and releases lock', async () => {
  let status = '';
  let busy = false;
  let prices = [{ id: 41 }, { id: 42 }];
  const savingRef = { current: false };
  const remove = callback('AdminWholesaleGateway.tsx', 'deletePriceList', {
    savingRef, confirm: () => true, setBusy: (value: boolean) => { busy = value; },
    request: async () => Response.json({ ok: true }),
    isActive: () => true, editorKey: 'manager', viewKeyRef: { current: 'manager' },
    screen: 'manager', managerDetailId: null,
    setStatus: (value: string) => { status = value; }, showStatus: (value: string) => { status = value; },
    AdminRequestError, ADMIN_UNKNOWN_OUTCOME, readApiError,
    setPriceLists: (update: (old: typeof prices) => typeof prices) => { prices = update(prices); },
    loadPriceLists: async () => { throw new Error('Synthetic list failure'); },
  });
  await remove(41);
  assert.equal(busy, false);
  assert.equal(savingRef.current, false);
  assert.deepEqual(prices, [{ id: 42 }]);
  assert.match(status, /Прайс удалён, но список не обновился/);
});

for (const failure of ['timeout', 'network', 'cancelled'] as const) {
  test(`analytics email ${failure} releases synchronous busy lock without falsely reporting unsent`, async () => {
    let busy = false;
    let status = '';
    let calls = 0;
    const exportBusyRef = { current: false };
    const send = callback('AdminWholesaleAnalytics.tsx', 'sendAnalyticsEmail', {
      exportBusyRef, exportEmail: 'synthetic@example.invalid', period: '30d', exportFormat: 'pdf', exportManagerId: 'all',
      setExportBusy: (value: boolean) => { busy = value; }, setExportStatus: (value: string) => { status = value; },
      setExportSendDone: () => {}, isActive: () => true,
      AdminRequestError, ADMIN_UNKNOWN_OUTCOME, ADMIN_UPLOAD_TIMEOUT_MS,
      request: async (_url: string, _init: unknown, options: { timeoutMs: number }) => {
        assert.equal(options.timeoutMs, ADMIN_UPLOAD_TIMEOUT_MS);
        calls++;
        throw new AdminRequestError(ADMIN_UNKNOWN_OUTCOME, failure);
      },
    });
    await Promise.all([send(), send()]);
    assert.equal(calls, 1);
    assert.equal(busy, false);
    assert.equal(exportBusyRef.current, false);
    assert.match(status, /могло сохраниться/);
  });
}

test('cleared analytics journal with failed reload does not invite repeated deletion', async () => {
  let busy = false;
  let status = '';
  const clearEventsBusyRef = { current: false };
  const clear = callback('AdminWholesaleAnalytics.tsx', 'clearEventLog', {
    analytics: { recentEvents: [{}] }, clearEventsBusyRef, window: { confirm: () => true },
    setClearEventsBusy: (value: boolean) => { busy = value; }, setClearEventsStatus: (value: string) => { status = value; },
    request: async () => Response.json({ ok: true }), loadAnalytics: async () => false,
    setEventTypeFilter: () => {}, setActorFilter: () => {}, setManagerFilter: () => {},
    isActive: () => true, AdminRequestError, ADMIN_UNKNOWN_OUTCOME,
  });
  await clear();
  assert.equal(busy, false);
  assert.equal(clearEventsBusyRef.current, false);
  assert.match(status, /Журнал очищен, но отображение не обновилось/);
});
