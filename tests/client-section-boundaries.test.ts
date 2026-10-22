import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import type { useAdminClientOperations } from '../src/features/admin/clients/useAdminClientOperations';

function operationHarness() {
  const state: unknown[] = [];
  const timers: Array<() => void> = [];
  let cancelled = 0;
  const requestScope = { request: async () => new Response(), cancelAll: () => { cancelled += 1; }, isActive: () => true };
  const testModule = { exports: {} as { useAdminClientOperations: typeof useAdminClientOperations } };
  const source = readFileSync('src/features/admin/clients/useAdminClientOperations.ts', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, {
    module: testModule, exports: testModule.exports,
    window: { setTimeout: (callback: () => void) => { timers.push(callback); } },
    require: (specifier: string) => {
      if (specifier === '../shared/useAdminRequestScope') return { useAdminRequestScope: () => requestScope };
      if (specifier !== 'react') throw new Error(`Unexpected dependency: ${specifier}`);
      return {
        useRef: (current: unknown) => ({ current }),
        useCallback: (callback: unknown) => callback,
        useState: (initial: unknown) => {
          const index = state.length;
          state.push(initial);
          return [initial, (next: unknown) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
        },
      };
    },
  });
  return { operations: testModule.exports.useAdminClientOperations(), state, timers, requestScope, cancelled: () => cancelled };
}

test('client editing and lifecycle operations share a single mutation fence and cancellation scope', () => {
  const { operations, state, requestScope, cancelled } = operationHarness();
  assert.equal(operations.request, requestScope.request);
  assert.equal(operations.isActive, requestScope.isActive);
  assert.equal(operations.startMutation(), true);
  assert.equal(operations.mutationRef.current, true);
  assert.equal(operations.dataGeneration.current, 1, 'reads started before a mutation become stale');
  assert.equal(state[1], true);
  assert.equal(operations.startMutation(), false, 'another write cannot begin while editing/archive is in flight');
  assert.equal(operations.dataGeneration.current, 1);
  operations.cancelAll();
  assert.equal(cancelled(), 1);
  assert.equal(operations.mutationRef.current, true, 'cancellation keeps the fence until the active operation settles');
  operations.finishMutation();
  assert.equal(operations.mutationRef.current, false);
  assert.equal(operations.dataGeneration.current, 2, 'reads started during a mutation are also fenced out');
  assert.equal(state[1], false);
  assert.equal(operations.startMutation(), true);
});

test('an older transient status timer cannot clear a newer client operation result', () => {
  const { operations, state, timers } = operationHarness();
  operations.showStatus('First result');
  operations.showStatus('Second result');
  timers[0]();
  assert.equal(state[0], 'Second result');
  timers[1]();
  assert.equal(state[0], '');
});

test('client section remains a view facade over one shared editor/list/operation lifetime', () => {
  const source = readFileSync('src/features/admin/clients/AdminClientsSection.tsx', 'utf8');
  const parsed = ts.createSourceFile('AdminClientsSection.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  for (const name of ['useAdminClientOperations', 'useAdminClientDrafts', 'useAdminClientList', 'useAdminClientEditing', 'useAdminClientLifecycle']) {
    assert.equal(calls.filter(call => call === name).length, 1, `${name} must not fork its state for individual cards`);
  }
  assert.doesNotMatch(source, /\/api\/admin\/clients|startClientRealtimeSync|openClientDraftWorkspace|submitClientMutation/);
  assert.match(source, /useAdminClientEditing\(operations, editor, list\)/);
  assert.match(source, /useAdminClientLifecycle\(operations, editor, list\)/);
});
