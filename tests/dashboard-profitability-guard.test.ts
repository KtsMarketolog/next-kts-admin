import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const marker = 'kts-profitability-audit-v1';
type TestEvent = { defaultPrevented?: boolean; preventDefault(): void; [name: string]: unknown };

function fixture() {
  const listeners = new Map<string, Array<(event: TestEvent) => void>>();
  const documents = new Map<string, Array<(event: TestEvent) => void>>();
  const add = (map: typeof listeners) => (key: string, fn: (event: TestEvent) => void) => map.set(key, [...(map.get(key) ?? []), fn]);
  const remove = (map: typeof listeners) => (key: string, fn: (event: TestEvent) => void) => map.set(key, (map.get(key) ?? []).filter(value => value !== fn));
  let now = 10000, accepted = false, confirmations = 0;
  const window = { location: { origin: 'https://fixture.test', href: 'https://fixture.test/report', pathname: '/report', search: '' },
    addEventListener: add(listeners), removeEventListener: remove(listeners),
    dispatchEvent(event: TestEvent & { type: string }) { listeners.get(event.type)?.forEach(fn => fn(event)); return !event.defaultPrevented; },
    confirm() { confirmations++; return accepted; },
  };
  const document = { addEventListener: add(documents), removeEventListener: remove(documents) };
  class Element { closest(): Element | null { return this; } }
  class Anchor extends Element {
    href = 'https://fixture.test/other'; target = ''; download = false;
    getAttribute() { return this.target; }
    hasAttribute() { return this.download; }
  }
  const exports: { useProfitabilityAuditGuard?: (ref: { current: unknown }) => void;
    requestProfitabilityFrameChange?: (frame: unknown, prompt?: boolean) => boolean } = {};
  let cleanup: (() => void) | undefined;
  const compiled = ts.transpileModule(readFileSync('src/features/admin/dashboard-usage/useProfitabilityAuditGuard.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, window, document, URL, Element, HTMLAnchorElement: Anchor, CustomEvent,
    Date: { now: () => now }, require(name: string) { assert.equal(name, 'react'); return { useEffect: (effect: () => () => void) => { cleanup = effect(); } }; },
  });
  const ref = { current: { contentWindow: {} } };
  exports.useProfitabilityAuditGuard!(ref);
  const fire = (key: string, fields: Record<string, unknown> = {}, source = listeners) => {
    const event = { ...fields, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    source.get(key)?.forEach(fn => fn(event));
    return event;
  };
  const pending = (value: boolean, extra: Record<string, unknown> = {}) => fire('message', {
    source: ref.current.contentWindow, origin: window.location.origin, data: { marker, type: 'pending-state', pending: value }, ...extra,
  });
  return { ref, window, document, fire, pending, Anchor, listeners, documents,
    request: (prompt = true) => exports.requestProfitabilityFrameChange!(ref.current, prompt),
    accepted: (value: boolean) => { accepted = value; }, confirmations: () => confirmations,
    advance: (ms: number) => { now += ms; }, cleanup: () => cleanup?.(),
  };
}

test('top guard trusts only exact same-origin wrapper and exact nonfinancial status envelope', () => {
  const state = fixture();
  state.pending(true, { source: {} });
  state.pending(true, { origin: 'null' });
  state.pending(true, { origin: 'https://other.test' });
  state.pending(true, { data: { marker, type: 'pending-state', pending: true, invoice: { secret: true } } });
  assert.equal(state.fire('beforeunload').defaultPrevented, false);
  state.pending(true);
  assert.equal(state.fire('beforeunload').defaultPrevented, true);
  state.pending(false, { source: {} });
  assert.equal(state.fire('beforeunload').defaultPrevented, true);
  state.pending(false);
  assert.equal(state.fire('beforeunload').defaultPrevented, false);
});

test('background replacement is blocked, explicit confirmation has bounded scope and never disables unload on failure', () => {
  const state = fixture();
  state.pending(true);
  assert.equal(state.request(false), false);
  assert.equal(state.confirmations(), 0);
  assert.equal(state.request(), false);
  assert.equal(state.confirmations(), 1);
  state.accepted(true);
  assert.equal(state.request(), true);
  assert.equal(state.request(false), true);
  assert.equal(state.fire('beforeunload').defaultPrevented, true, 'failed operation retains pending loss warning');
  state.advance(5001);
  assert.equal(state.request(false), false);
  state.pending(false);
  assert.equal(state.request(false), true);
  state.pending(true);
  const event = new CustomEvent('kts-profitability-before-frame-change', { cancelable: true, detail: { frame: {}, prompt: false } });
  assert.equal(state.window.dispatchEvent(event as unknown as TestEvent & { type: string }), true, 'other iframe is independent');
});

test('frame generations re-arm independently, cleanup removes listeners, and cancelled links block router handlers', () => {
  const state = fixture();
  state.pending(true);
  const target = new state.Anchor();
  const cancelled = state.fire('click', { target, button: 0 }, state.documents);
  assert.equal(cancelled.defaultPrevented, true);
  assert.equal(cancelled.stopped, true);
  for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal(state.fire('click', { target, button: 0, ...extra }, state.documents).defaultPrevented, false);
  }
  target.target = '_blank';
  assert.equal(state.fire('click', { target, button: 0 }, state.documents).defaultPrevented, false);
  target.target = ''; target.download = true;
  assert.equal(state.fire('click', { target, button: 0 }, state.documents).defaultPrevented, false);
  target.download = false; target.href = 'https://fixture.test/report#details';
  assert.equal(state.fire('click', { target, button: 0 }, state.documents).defaultPrevented, false);
  target.href = 'https://fixture.test/other'; state.accepted(true);
  assert.equal(state.fire('click', { target, button: 0 }, state.documents).defaultPrevented, false);
  assert.equal(state.fire('beforeunload').defaultPrevented, false, 'one accepted link does not prompt twice');
  state.advance(1501);
  assert.equal(state.fire('beforeunload').defaultPrevented, true);
  state.fire('load', { target: state.ref.current }, state.documents);
  assert.equal(state.fire('beforeunload').defaultPrevented, false);
  state.pending(true);
  assert.equal(state.fire('beforeunload').defaultPrevented, true);
  state.ref.current = { contentWindow: {} };
  assert.equal(state.fire('beforeunload').defaultPrevented, false);
  state.pending(true);
  assert.equal(state.fire('beforeunload').defaultPrevented, true);
  state.cleanup();
  assert.equal([...state.listeners.values(), ...state.documents.values()].every(value => !value.length), true);
});
