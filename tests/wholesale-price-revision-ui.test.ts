import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import { emptyEditor } from '../src/features/admin/wholesale/AdminWholesaleEditorModel';
import { readApiError } from '../src/features/admin/wholesale/AdminWholesaleApiModel';

// Execute the real save callback, isolating React state and HTTP only.
const source = ts.createSourceFile('gateway.tsx', readFileSync(new URL(
  '../src/features/admin/wholesale/AdminWholesaleGateway.tsx', import.meta.url,
), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.ArrowFunction | undefined;
function find(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'savePriceList'
    && node.initializer && ts.isArrowFunction(node.initializer)) callback = node.initializer;
  ts.forEachChild(node, find);
}
find(source);
assert.ok(callback);
const javascript = ts.transpileModule(`const save = ${callback.getText(source)};`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(status: number) {
  const editor = { ...emptyEditor(), id: 42, revision: '7', comment: 'Unsaved local comment', clientCompanyId: 1,
    managerId: 2, supportManagerId: 3,
    items: [{ productId: 4, variantId: null, customWholesalePrice: '17.50', discountPercent: null,
      priceManuallyChanged: true, visible: true, sortOrder: 1 }] };
  let conflict = false;
  let error = '';
  let busy = false;
  let navigated = false;
  const sent: Array<Record<string, unknown>> = [];
  const savingRef = { current: false };
  const bindings = {
    editor, editorReady: true, screen: 'edit', editId: 42, savingRef, canManageWholesale: true,
    clientCompanies: [{ id: 1, title: 'Synthetic company' }],
    catalogDiscountBaseByKey: new Map([['4:base', {}]]),
    setBusy: (value: boolean) => { busy = value; },
    setEditorSaveError: (value: string) => { error = value; },
    setEditorSaveConflict: (value: boolean) => { conflict = value; },
    showStatus: () => {}, readApiError,
    router: { push: () => { navigated = true; } }, editorBackHref: '/admin/wholesale',
    fetch: async (_url: string, options: { body: string }) => {
      sent.push(JSON.parse(options.body));
      return Response.json(status === 409 ? { error: 'Данные уже изменены другим пользователем', code: 'RECORD_VERSION_CONFLICT' }
        : { ok: true, revision: '8' }, { status });
    },
  };
  const save = () => {
    const scope = { ...bindings, editorSaveConflict: conflict };
    return (new Function(...Object.keys(scope), `${javascript}\nreturn save;`)(...Object.values(scope)) as () => Promise<void>)();
  };
  return { editor, save, sent, savingRef, get conflict() { return conflict; }, get error() { return error; },
    get busy() { return busy; }, get navigated() { return navigated; } };
}

test('conflicting price save retains the entire local draft and original revision, unlocks UI and forbids silent retry', async () => {
  const h = harness(409);
  const draft = structuredClone(h.editor);
  await h.save();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].expectedRevision, '7');
  assert.equal(h.conflict, true);
  assert.match(h.error, /изменены другим пользователем/);
  assert.deepEqual(h.editor, draft);
  assert.equal(h.busy, false);
  assert.equal(h.savingRef.current, false);
  assert.equal(h.navigated, false);
  await h.save();
  assert.equal(h.sent.length, 1, 'a stale form cannot be retried with a refreshed token and old values');
});

test('successful versioned price save keeps established return-to-list behavior', async () => {
  const h = harness(200);
  await h.save();
  assert.equal(h.sent[0].expectedRevision, '7');
  assert.equal(h.conflict, false);
  assert.equal(h.navigated, true);
  assert.equal(h.busy, false);
});

test('conflict reload requires explicit confirmation before replacing the draft with current server data', () => {
  let reload: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'retryEditorLoad'
      && node.initializer && ts.isJsxExpression(node.initializer)
      && node.initializer.expression && ts.isArrowFunction(node.initializer.expression)) reload = node.initializer.expression;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(reload);
  const js = ts.transpileModule(`const reload = ${reload.getText(source)};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let attempt = 0;
  let loading = false;
  for (const confirmed of [false, true]) {
    const scope = { editorSaveConflict: true, editorKey: 'edit:42',
      confirm: (message: string) => { assert.match(message, /несохранённые изменения/); return confirmed; },
      setEditorLoad: () => { loading = true; },
      setEditorLoadAttempt: (update: (value: number) => number) => { attempt = update(attempt); } };
    new Function(...Object.keys(scope), `${js}\nreturn reload();`)(...Object.values(scope));
    assert.equal(attempt, confirmed ? 1 : 0);
    assert.equal(loading, confirmed);
  }
});
