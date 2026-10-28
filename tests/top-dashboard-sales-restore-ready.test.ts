import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {
  instrumentReviewedSalesRestoreReady,
  instrumentSalesRestoreReadySource,
  type SalesRestoreReadyRanges,
} from '../src/shared/lib/topDashboardContentSecurity/salesRestoreReady';

const READY = 'kts-top-dashboard-data-ready';
const ERROR = 'kts-top-dashboard-data-error';
const START = 'kts-top-dashboard-restore-start';
const source = `"use strict";
var trace = [];
function acceptBundle(u, source) {
  trace.push([this && this.tag, arguments.length, source]);
  render(u.first);
  trace.push('after-first-render');
  if (u.afterFirst) u.afterFirst();
  if (u.second) render(u.second);
  if (u.error) throw u.error;
  trace.push('accepted');
  return u.result;
}
function render(failure) {
  try {
    if (failure === 'render') throw Error('render failed');
    k3Capture(failure);
    trace.push('rendered');
  } catch (err){
    trace.push('render-caught');
  }
}
function k3Capture(failure) {
  try { if (failure === 'k3') throw Error('baseline failed'); }
  catch (e){ trace.push('baseline-caught'); }
}
async function handleFiles(files) {
  for (const file of files) {
    try {
      if (file.outerError) throw Error('read failed');
      const buf = file;
      let u = null;
      try { u = unpackBundle(await readBundle(buf)); }
        catch (e){ trace.push('decode-caught'); continue; }
      if (!u){ trace.push('invalid-bundle'); continue; }
      if (u){ acceptBundle(u, file.name); return; }
    } catch (err){ trace.push('file-caught'); }
  }
}
async function readBundle(file) {
  if (file.parseError) throw Error('bad snapshot');
  return file;
}
function unpackBundle(file) { return file.invalid ? null : file; }
render('render'); // Startup failures have no active restore.
window.fixture = {acceptBundle, handleFiles, render, trace};
`;

function bodyRanges(script: string): SalesRestoreReadyRanges {
  const ast = ts.createSourceFile('fixture.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const result: Partial<SalesRestoreReadyRanges> = {};
  for (const statement of ast.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    const name = statement.name.text as keyof SalesRestoreReadyRanges;
    if (name === 'acceptBundle' || name === 'render' || name === 'k3Capture' || name === 'handleFiles') {
      result[name] = { bodyStart: statement.body.getStart(ast), bodyEnd: statement.body.end };
    }
  }
  assert.ok(result.acceptBundle && result.render && result.k3Capture);
  return result as SalesRestoreReadyRanges;
}

function fixture() {
  type Event = { type: string; detail?: { restoreId?: unknown } };
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const messages: Array<{ type: string; restoreId: unknown; trace: unknown[] }> = [];
  type FixtureApi = {
    acceptBundle(input: Record<string, unknown>, source?: string): unknown;
    handleFiles(files: Array<Record<string, unknown>>): Promise<unknown>;
    render(failure: string): void;
    trace: unknown[];
  };
  const window = {
    addEventListener(type: string, fn: (event: Event) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatchEvent(event: Event) {
      if (event.type === READY || event.type === ERROR) {
        messages.push({type: event.type, restoreId: event.detail?.restoreId, trace: [...(window.fixture?.trace ?? [])]});
      }
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    fixture: undefined as FixtureApi | undefined,
  };
  class CustomEvent {
    detail?: Event['detail'];
    constructor(readonly type: string, options?: {detail: Event['detail']}) { this.detail = options?.detail; }
  }
  const transformed = instrumentSalesRestoreReadySource(source, bodyRanges(source));
  assert.ok(transformed);
  assert.ok(transformed.startsWith('"use strict";'));
  vm.runInNewContext(transformed, {window, CustomEvent});
  const api = window.fixture!;
  return {api, messages, start: (restoreId: unknown) => window.dispatchEvent({type: START, detail: {restoreId}}),
    cancel: (restoreId: unknown) => window.dispatchEvent({type: ERROR, detail: {restoreId}})};
}

test('native sales completion follows the entire synchronous acceptance and preserves this, arguments and return', () => {
  const f = fixture();
  f.start(4);
  const value = {};
  assert.equal(f.api.acceptBundle.call({tag: 'receiver'}, {
    second: 'success', result: value,
    afterFirst: () => assert.equal(f.messages.length, 0, 'first render cannot signal completion'),
  }, 'synthetic.json'), value);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].type, READY);
  assert.equal(f.messages[0].restoreId, 4);
  assert.equal(f.messages[0].trace.at(-1), 'accepted');
  assert.deepEqual(Array.from(f.api.trace[1] as unknown[]), ['receiver', 2, 'synthetic.json']);
  f.api.acceptBundle({});
  f.api.render('success');
  assert.equal(f.messages.length, 1, 'later activity cannot duplicate completion');
});

test('internally caught render and baseline errors suppress readiness while preserving native catches', () => {
  for (const input of [{first: 'render'}, {second: 'render'}, {first: 'k3'}]) {
    const f = fixture();
    f.start(7);
    const value = {};
    assert.equal(f.api.acceptBundle({...input, result: value}), value);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].type, ERROR);
    assert.equal(f.messages[0].restoreId, 7);
    assert.equal(f.messages[0].trace.at(-1), 'accepted', 'native execution continues after a swallowed failure');
  }
});

test('a thrown native acceptance error is preserved and reports failure once', () => {
  const f = fixture();
  const error = new Error('apply failed');
  f.start(8);
  assert.throws(() => f.api.acceptBundle({error}), (caught: unknown) => caught === error);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].type, ERROR);
  f.api.acceptBundle({});
  assert.equal(f.messages.length, 1);
});

test('caught decoding, invalid bundle and file-read failures report immediately without changing loader fulfillment', async () => {
  for (const input of [{parseError: true}, {invalid: true}, {outerError: true}]) {
    const f = fixture(); f.start(11);
    assert.equal(await f.api.handleFiles([input]), undefined);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].type, ERROR);
    assert.equal(f.messages[0].restoreId, 11);
    f.api.acceptBundle({});
    assert.equal(f.messages.length, 1, 'later native loads cannot ACK the failed restore');
  }
  const f = fixture(); f.start(12);
  await f.api.handleFiles([{error: new Error('apply failed')}]);
  assert.equal(f.messages.length, 1, 'acceptance throw plus outer catch reports only once');
  assert.equal(f.messages[0].type, ERROR);
});

test('only active positive safe restore ids can complete, and stale or cancelled acceptance cannot ACK', () => {
  for (const id of [undefined, null, 0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(); f.start(id); f.api.acceptBundle({});
    assert.equal(f.messages.length, 0);
  }
  const f = fixture();
  f.start(1);
  f.api.acceptBundle({afterFirst: () => f.start(2)});
  assert.equal(f.messages.length, 0);
  f.api.acceptBundle({});
  assert.equal(f.messages[0].restoreId, 2);
  f.start(3); f.cancel(3); f.api.acceptBundle({});
  assert.equal(f.messages.length, 2);
  assert.equal(f.messages[1].type, ERROR);
});

test('unknown HTML and modified reviewed body shapes are never recognized implicitly', () => {
  const html = `<html><title>Аналитика продаж</title><script>${source}</script></html>`;
  assert.equal(instrumentReviewedSalesRestoreReady(html), html);
  const ranges = bodyRanges(source);
  assert.equal(instrumentSalesRestoreReadySource(source, {...ranges, acceptBundle: ranges.render}), null);
  const changed = source.replace('} catch (err){', '} catch (different){');
  assert.equal(instrumentSalesRestoreReadySource(changed, bodyRanges(changed)), null);
});

const fixtureDirectory = process.env.KTS_SALES_READY_HTML_FIXTURES;
test('optional actual reviewed sales scripts have exact ranges, retain native source and remain idempotent', {
  skip: !fixtureDirectory,
}, () => {
  let reviewed = 0;
  for (const file of readdirSync(fixtureDirectory!).filter(name => /^top4-version-(?:124|128)\.html$/.test(name))) {
    const html = readFileSync(path.join(fixtureDirectory!, file), 'utf8');
    const adapted = instrumentReviewedSalesRestoreReady(html);
    assert.notEqual(adapted, html, file);
    assert.equal(instrumentReviewedSalesRestoreReady(adapted), adapted);
    const before = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]);
    const after = [...adapted.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]);
    assert.equal(before.length, after.length);
    let changed = 0;
    for (let index = 0; index < before.length; index++) {
      if (before[index] === after[index]) continue;
      changed++;
      assert.equal(after[index].slice(0, 80), before[index].slice(0, 80));
      const ast = ts.createSourceFile('adapted.js', after[index], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      assert.equal((ast as unknown as {parseDiagnostics: unknown[]}).parseDiagnostics.length, 0);
      const ranges = bodyRanges(before[index]);
      const originalAcceptance = before[index].slice(ranges.acceptBundle.bodyStart + 1, ranges.acceptBundle.bodyEnd - 1);
      assert.ok(after[index].includes(originalAcceptance), 'complete original acceptance body is retained');
      const unreviewed = html.replace(before[index], `${before[index]}\n/* changed author script */`);
      assert.equal(instrumentReviewedSalesRestoreReady(unreviewed), unreviewed);
    }
    assert.equal(changed, 1);
    reviewed++;
  }
  assert.equal(reviewed, 2);
});
