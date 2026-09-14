import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { mergeClientChatMessages } from '../src/shared/lib/clientChatState';
import type { startClientRealtimeSync } from '../src/shared/lib/clientRealtimeSync';
import { emptyDraft, readApiError, readApiErrorFallback, toDraft, type ClientCompany, type ClientDraft } from '../src/features/admin/clients/AdminClientsModel';
import type { ClientCompanyOption, PriceEditor } from '../src/features/admin/wholesale/AdminWholesaleTypes';

// Run the actual browser helper with isolated events/timers: no HTTP, real timers or server.
function harness(unsupportedSse = false) {
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const browser = new EventTarget();
  const network = { onLine: true };
  const streams: Array<EventTarget & { closed: boolean }> = [];
  class Events extends EventTarget {
    closed = false;
    constructor() {
      super();
      if (unsupportedSse) throw new Error('SSE is unavailable');
      streams.push(this);
    }
    close() { this.closed = true; }
  }
  const testModule = { exports: {} as { startClientRealtimeSync: typeof startClientRealtimeSync } };
  const source = readFileSync(new URL('../src/shared/lib/clientRealtimeSync.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, {
    module: testModule, exports: testModule.exports, document: page, window: browser, navigator: network,
    EventSource: Events, AbortController,
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { due: now + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const target = now + ms;
    await flush();
    while (true) {
      const first = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!first || first[1].due > target) break;
      now = first[1].due;
      timers.delete(first[0]);
      first[1].callback();
      await flush();
    }
    now = target;
  };
  return { start: testModule.exports.startClientRealtimeSync, page, browser, network, streams, timers, advance, flush };
}

test('another worker change is recovered without any SSE event, including documents and unread data', async () => {
  const env = harness();
  let persisted = { unread: 0, documents: 0 };
  let view = persisted;
  let calls = 0;
  const stop = env.start({ eventsEndpoint: '/authenticated/events', eventTypes: ['chat.updated', 'documents.updated'], refresh: async () => { calls += 1; view = persisted; } });
  await env.flush();
  persisted = { unread: 2, documents: 1 }; // Independent worker writes shared DB, but this stream hears nothing.
  await env.advance(14_999);
  assert.deepEqual(view, { unread: 0, documents: 0 });
  await env.advance(1);
  assert.deepEqual(view, persisted);
  assert.equal(calls, 2);
  stop();
  assert.equal(env.streams[0].closed, true);
  assert.equal(env.timers.size, 0);
});

test('hidden/offline tabs stop polling and resume on visibility, focus or online', async () => {
  const env = harness();
  let calls = 0;
  env.page.visibilityState = 'hidden';
  const stop = env.start({ eventsEndpoint: '/events', eventTypes: [], refresh: async () => { calls += 1; } });
  await env.advance(30_000);
  assert.equal(calls, 0);
  env.page.visibilityState = 'visible';
  env.page.dispatchEvent(new Event('visibilitychange'));
  await env.advance(250);
  assert.equal(calls, 1);
  env.network.onLine = false;
  await env.advance(30_000);
  assert.equal(calls, 1);
  env.network.onLine = true;
  env.browser.dispatchEvent(new Event('online'));
  await env.advance(250);
  assert.equal(calls, 2);
  stop();
  env.browser.dispatchEvent(new Event('focus'));
  await env.advance(30_000);
  assert.equal(calls, 2);
});

test('SSE bursts/reconnect coalesce into one refresh with no concurrent requests', async () => {
  const env = harness();
  let finish!: () => void;
  let calls = 0;
  const stop = env.start({ eventsEndpoint: '/events', eventTypes: ['chat.updated'], refresh: async () => {
    calls += 1;
    if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
  } });
  for (let i = 0; i < 20; i += 1) env.streams[0].dispatchEvent(new Event('chat.updated'));
  env.streams[0].dispatchEvent(new Event('connected'));
  assert.equal(calls, 1);
  finish();
  await env.advance(250);
  assert.equal(calls, 2);
  stop();
});

test('unsupported SSE still polls and a timed-out refresh retries rather than remaining blocked', async () => {
  const env = harness(true);
  let calls = 0;
  let errors = 0;
  const stop = env.start({ eventsEndpoint: '/events', eventTypes: [], onError: () => { errors += 1; }, refresh: async (signal) => {
    calls += 1;
    if (calls === 1) await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  } });
  await env.advance(10_000);
  assert.equal(errors, 1);
  await env.advance(15_000);
  assert.equal(calls, 2);
  stop();
});

test('cleanup aborts in-flight IO without retrying or reporting an error after unmount', async () => {
  const env = harness();
  let observedSignal!: AbortSignal;
  let errors = 0;
  const stop = env.start({ eventsEndpoint: '/events', eventTypes: [], onError: () => { errors += 1; }, refresh: async (signal) => {
    observedSignal = signal;
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('unmounted')), { once: true }));
  } });
  stop();
  await env.advance(60_000);
  assert.equal(observedSignal.aborted, true);
  assert.equal(errors, 0);
  assert.equal(env.timers.size, 0);
});

test('chat POST/SSE/poll races preserve new messages, deduplicate and keep read receipts monotonic', () => {
  const current = [{ id: 1, readByOther: true, body: 'old' }, { id: 2, readByOther: false, body: 'new' }];
  assert.deepEqual(mergeClientChatMessages(current, [{ id: 1, readByOther: false, body: 'old' }]), current);
  assert.deepEqual(mergeClientChatMessages(current, [{ id: 2, readByOther: true, body: 'new' }]), [current[0], { ...current[1], readByOther: true }]);
  const many = Array.from({ length: 400 }, (_, id) => ({ id: id + 1, readByOther: false }));
  assert.equal(mergeClientChatMessages([], many).length, 300);
  assert.equal(mergeClientChatMessages([], many)[0].id, 101);
});

test('chat merging preserves server createdAt/id order even when IDs are not chronological', () => {
  const messages = [
    { id: 30, createdAt: '2026-09-14T10:00:00.000Z', readByOther: false },
    { id: 20, createdAt: '2026-09-14T11:00:00.000Z', readByOther: false },
    { id: 10, createdAt: '2026-09-14T11:00:00.000Z', readByOther: false },
  ];
  assert.deepEqual(mergeClientChatMessages([], messages).map((message) => message.id), [30, 10, 20]);
});

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (child: ts.Node) => { nodes.push(child); ts.forEachChild(child, visit); };
  visit(node);
  return nodes;
}

function componentCallbacks(filename: string, name: string) {
  const source = ts.createSourceFile(filename, readFileSync(new URL(filename, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(component && ts.isFunctionDeclaration(component) && component.body);
  const effects = component.body.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const call = statement.expression;
    return ts.isIdentifier(call.expression) && call.expression.text === 'useEffect' ? [call.arguments[0]] : [];
  });
  return { source, component, effects };
}

// Extract complete AST callbacks, not rewritten implementations or source-text
// assertions. Only their browser/React IO bindings are supplied by the fixture.
function executeCallback<T>(node: ts.Node, source: ts.SourceFile, bindings: Record<string, unknown>): T {
  const expression = ts.isFunctionDeclaration(node)
    ? ts.createPrinter().printNode(ts.EmitHint.Expression, ts.factory.createFunctionExpression(undefined, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, node.body!), source)
    : node.getText(source);
  const code = ts.transpileModule(`module.exports = (${expression});`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  new Function('module', 'exports', ...Object.keys(bindings), code)(testModule, testModule.exports, ...Object.values(bindings));
  return testModule.exports as T;
}

function hasNamedCall(node: ts.Node, name: string) {
  return descendants(node).some((child) => ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name);
}

test('clients mount starts one initial GET and background refresh preserves drafts and respects cleanup', async () => {
  const env = harness();
  const parsed = componentCallbacks('../src/features/admin/clients/AdminClientsSection.tsx', 'AdminClientsSection');
  const declaration = descendants(parsed.component).find((node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'loadClients');
  assert.ok(declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer));
  const requests: Array<{ resolve: (value: unknown) => void; signal?: AbortSignal }> = [];
  const companiesRef = { current: [] as ClientCompany[] };
  let drafts: Record<number, ClientDraft> = {};
  let managerLoads = 0;
  const loadClients = executeCallback<(preserve?: boolean, signal?: AbortSignal) => Promise<void>>(declaration.initializer.arguments[0], parsed.source, {
    fetch: (_url: string, options: { signal?: AbortSignal }) => new Promise((resolve) => { requests.push({ resolve, signal: options.signal }); }),
    companiesRef, toDraft, readApiError,
    setCompanies: () => {},
    setCompanyDrafts: (update: (current: Record<number, ClientDraft>) => Record<number, ClientDraft>) => { drafts = update(drafts); },
  });
  const cleanups = parsed.effects.map((effect) => executeCallback<() => (() => void) | undefined>(effect, parsed.source, {
    loadClients,
    loadManagers: async () => { managerLoads += 1; },
    startClientRealtimeSync: env.start,
    showStatus: () => {}, setStatus: () => {}, readApiErrorFallback,
  })());
  await env.flush();
  assert.equal(managerLoads, 1);
  assert.equal(requests.length, 1, 'a second non-preserving mount GET could arrive late and erase typing');
  const companies = [1, 2].map((id) => ({ ...emptyDraft, id, title: `Company ${id}` }));
  const response = (rows: typeof companies) => ({ ok: true, json: async () => ({ companies: rows }) });
  requests[0].resolve(response(companies));
  await env.flush();
  drafts[1] = { ...drafts[1], title: 'Unsaved local name' };
  await env.advance(15_000);
  requests[1].resolve(response(companies.map((company) => ({ ...company, title: `Updated ${company.id}` }))));
  await env.flush();
  assert.equal(drafts[1].title, 'Unsaved local name');
  assert.equal(drafts[2].title, 'Updated 2');
  await env.advance(15_000);
  for (const cleanup of cleanups) cleanup?.();
  assert.equal(requests[2].signal?.aborted, true);
  requests[2].resolve(response(companies));
  await env.flush();
  assert.equal(drafts[2].title, 'Updated 2', 'late responses after unmount must not update state');
  assert.equal(env.timers.size, 0);
});

test('wholesale assignment sync starts after editor init and uses its exact snapshot without overwriting local edits', async () => {
  const env = harness();
  const parsed = componentCallbacks('../src/features/admin/wholesale/AdminWholesaleGateway.tsx', 'AdminWholesaleGateway');
  const initEffect = parsed.effects.find((effect) => descendants(effect).some((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'loadEditorData'));
  const syncEffect = parsed.effects.find((effect) => hasNamedCall(effect, 'startClientRealtimeSync'));
  assert.ok(initEffect && syncEffect);
  const builderSource = ts.createSourceFile('helpers.ts', readFileSync(new URL('../src/features/admin/wholesale/AdminWholesaleGateway.helpers.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const builder = builderSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'buildPriceEditorFromPayload');
  assert.ok(builder);
  const buildPriceEditorFromPayload = executeCallback(builder, builderSource, {
    mergeEditorItems: (_catalog: unknown[], items: unknown[]) => items,
    normalizePriceGroupStockSettings: () => [],
    makeToken: () => 'synthetic-token',
  });
  const initial: ClientCompanyOption[] = [{ id: 1, title: 'Initial company', managerId: 2, supportManagerId: 3, isActive: true }];
  let serverCompanies = initial;
  const editorCompaniesRef = { current: initial as ClientCompanyOption[] | null };
  let editorLoading = true;
  let editor: PriceEditor | null = null;
  const bindings = {
    screen: 'edit', editId: 45, canManageWholesale: true, createManagerId: null,
    editorCompaniesRef,
    loadClientCompanies: async () => serverCompanies,
    setEditor: (update: PriceEditor | ((current: PriceEditor) => PriceEditor)) => {
      if (typeof update === 'function') { assert.ok(editor); editor = update(editor); }
      else editor = update;
    },
    setEditorLoading: (value: boolean) => { editorLoading = value; },
    startClientRealtimeSync: env.start,
    loadCatalog: async () => [],
    fetch: async () => ({ ok: true, json: async () => ({ priceList: { id: 45, clientCompanyId: 1, clientName: 'Initial company', token: 'synthetic-token' } }) }),
    buildPriceEditorFromPayload,
    showStatus: (message: string) => { assert.fail(message); },
  };
  const startSync = () => executeCallback<() => (() => void) | undefined>(syncEffect, parsed.source, { ...bindings, editorLoading })();
  assert.equal(startSync(), undefined, 'an old snapshot must not allow sync while a new editor is loading');
  assert.equal(env.streams.length, 0);
  const stopInit = executeCallback<() => () => void>(initEffect, parsed.source, bindings)();
  assert.equal(editorCompaniesRef.current, null);
  await env.flush();
  assert.equal(editorLoading, false);
  assert.equal(editorCompaniesRef.current, initial);
  const currentEditor = () => { assert.ok(editor); return editor; };
  assert.equal(currentEditor().managerId, 2);
  serverCompanies = [{ ...initial[0], title: 'Second company', managerId: 22 }];
  const stopSync = startSync();
  await env.flush();
  assert.equal(currentEditor().managerId, 22, 'the first poll must apply changes since the editor snapshot');
  assert.equal(currentEditor().clientName, 'Second company');
  editor = { ...currentEditor(), managerId: 77, comment: 'Unsaved comment' };
  serverCompanies = [{ ...initial[0], title: 'Third company', managerId: 33 }];
  await env.advance(15_000);
  assert.equal(currentEditor().managerId, 77);
  assert.equal(currentEditor().clientName, 'Third company');
  assert.equal(currentEditor().comment, 'Unsaved comment');
  stopSync?.();
  stopInit();
  assert.equal(env.timers.size, 0);
});

for (const succeeds of [false, true]) {
  test(`chat send ${succeeds ? 'preserves newly typed draft on success' : 'releases sending state and retains draft on network failure'} without duplicate submissions`, async () => {
    const parsed = componentCallbacks('../src/features/client-chat/ClientChatPanel.tsx', 'ClientChatPanel');
    const declaration = descendants(parsed.component).find((node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'sendMessage');
    assert.ok(declaration && ts.isVariableDeclaration(declaration) && declaration.initializer);
    let draft = 'Outgoing message';
    let status = '';
    let posts = 0;
    let settle!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    let messages: Array<{ id: number; readByOther: boolean; body: string }> = [];
    const sending: boolean[] = [];
    const sendingRef = { current: false };
    const send = executeCallback<(event: { preventDefault: () => void }) => Promise<void>>(declaration.initializer, parsed.source, {
      draft, sendingRef, endpoint: '/authorized/chat',
      fetch: (_url: string, options: { body: string; signal: AbortSignal }) => {
        posts += 1;
        assert.deepEqual(JSON.parse(options.body), { message: 'Outgoing message' });
        assert.ok(options.signal instanceof AbortSignal);
        return new Promise((resolve, fail) => { settle = resolve; reject = fail; });
      },
      AbortSignal: { timeout: () => new AbortController().signal },
      setSending: (value: boolean) => { sending.push(value); },
      setStatus: (value: string) => { status = value; },
      setDraft: (update: (current: string) => string) => { draft = update(draft); },
      setMessages: (update: (current: typeof messages) => typeof messages) => { messages = update(messages); },
      mergeClientChatMessages, readApiError,
      loadMessages: async () => { assert.fail('POST returned its message; no additional GET expected'); },
      scrollToBottom: () => {},
    });
    const first = send({ preventDefault: () => {} });
    await send({ preventDefault: () => {} });
    assert.equal(posts, 1);
    assert.equal(sendingRef.current, true);
    if (succeeds) {
      draft = 'New unsent draft';
      settle({ ok: true, json: async () => ({ message: { id: 1, body: 'Outgoing message', readByOther: false } }) });
    } else reject(new Error('Network unavailable'));
    await first;
    assert.equal(sendingRef.current, false);
    assert.deepEqual(sending, [true, false]);
    assert.equal(posts, 1, 'an uncertain POST result must not automatically resubmit');
    assert.equal(draft, succeeds ? 'New unsent draft' : 'Outgoing message');
    assert.equal(messages.length, succeeds ? 1 : 0);
    assert.equal(status, succeeds ? '' : 'Network unavailable');
  });
}
