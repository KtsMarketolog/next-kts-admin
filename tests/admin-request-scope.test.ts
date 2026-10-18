import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import type { AdminRequestOptions } from '../src/features/admin/shared/adminRequest';

function scope() {
  const slots: unknown[] = [];
  const effects: Array<() => () => void> = [];
  const requests: Array<{ url: string; signal: AbortSignal; options?: AdminRequestOptions; finish: () => void }> = [];
  let cursor = 0;
  const modules = {
    react: {
      useRef(value: unknown) { const id = cursor++; return slots[id] ??= { current: value }; },
      useCallback(callback: unknown) { const id = cursor++; return slots[id] ??= callback; },
      useEffect(effect: () => () => void) { const id = cursor++; if (!(id in slots)) { slots[id] = true; effects.push(effect); } },
    },
    './adminRequest': { adminRequest: (url: string, init: RequestInit, options?: AdminRequestOptions) => new Promise<Response>((resolve, reject) => {
      const signal = init.signal!;
      const abort = () => reject(new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      requests.push({ url, signal, options, finish: () => {
        signal.removeEventListener('abort', abort);
        resolve(Response.json({ ok: true }));
      } });
      if (signal.aborted) abort();
    }) },
  };
  const code = ts.transpileModule(readFileSync(new URL('../src/features/admin/shared/useAdminRequestScope.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const result = { exports: {} as typeof import('../src/features/admin/shared/useAdminRequestScope') };
  new Function('require', 'module', 'exports', code)((name: keyof typeof modules) => {
    assert.ok(name in modules, name);
    return modules[name];
  }, result, result.exports);
  const render = () => { cursor = 0; return result.exports.useAdminRequestScope(); };
  const api = render();
  let cleanup = effects[0]();
  return { api, render, requests, unmount: () => cleanup(), remount: () => { cleanup = effects[0](); } };
}

test('component request scope has stable callbacks and cancels all active requests without disabling later explicit attempts', async () => {
  const view = scope();
  const first = view.api.request('/first', { method: 'PUT' }, { timeoutMs: 1_200_000 });
  const second = view.api.request('/second');
  const rejected = Promise.all([assert.rejects(first, /cancelled/), assert.rejects(second, /cancelled/)]);
  assert.equal(view.render().request, view.api.request);
  assert.equal(view.render().cancelAll, view.api.cancelAll);
  assert.equal(view.requests[0].options?.timeoutMs, 1_200_000);
  view.api.cancelAll();
  await rejected;
  assert.ok(view.requests.every(({signal}) => signal.aborted));
  assert.equal(view.api.isActive(), true, 'explicit cancellation is not unmount');
  const next = view.api.request('/next');
  view.requests.at(-1)!.finish();
  assert.equal((await next).ok, true);
  view.unmount();
});

test('component scope forwards caller abort and cleans it up after settlement', async () => {
  const view = scope();
  const controller = new AbortController();
  const pending = view.api.request('/snapshot', { method: 'POST', signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled/);
  controller.abort();
  await rejected;
  const completedController = new AbortController();
  const completed = view.api.request('/saved', { signal: completedController.signal });
  const request = view.requests.at(-1)!;
  request.finish();
  await completed;
  completedController.abort();
  assert.equal(request.signal.aborted, false, 'settled request no longer has a caller abort listener');
  view.unmount();
});

test('unmount aborts pending bodies, blocks late requests and allows the StrictMode effect remount', async () => {
  const view = scope();
  const pending = view.api.request('/pending');
  const rejected = assert.rejects(pending, /cancelled/);
  view.unmount();
  await rejected;
  assert.equal(view.api.isActive(), false);
  await assert.rejects(view.api.request('/late'), /cancelled/);
  assert.equal(view.requests.at(-1)!.signal.aborted, true);
  view.remount();
  assert.equal(view.api.isActive(), true);
  const next = view.api.request('/mounted-again');
  assert.equal(view.requests.at(-1)!.signal.aborted, false);
  view.requests.at(-1)!.finish();
  await next;
  view.unmount();
});
