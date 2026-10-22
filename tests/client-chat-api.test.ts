import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as chatApi from '../src/shared/lib/clientChatApi';

test('chat pagination accepts bounded keyset IDs and receipt IDs, rejects ambiguous or invalid cursors', () => {
  assert.deepEqual(chatApi.parseClientChatPage('https://example.test/chat'), {});
  assert.deepEqual(chatApi.parseClientChatPage('https://example.test/chat?before=301&receiptIds=4,7,4'), { before: 301, receiptIds: [4, 7] });
  assert.deepEqual(chatApi.parseClientChatPage('https://example.test/chat?after=15'), { after: 15 });
  assert.deepEqual(chatApi.parseClientChatPage('https://example.test/chat?after=0'), { after: 0 });
  for (const query of ['before=1&after=2', 'before=1&before=2', 'after=1&after=2', 'receiptIds=1&receiptIds=2',
    'before=', 'before=0', 'after=-1', 'before=1.1', 'before=01', 'before=1e2', 'before=9007199254740992', 'receiptIds=', 'receiptIds=1,x',
    `receiptIds=${Array.from({ length: 101 }, (_, i) => i + 1).join(',')}`]) {
    assert.throws(() => chatApi.parseClientChatPage(`https://example.test/chat?${query}`), chatApi.ClientChatRequestError);
  }
});

test('read confirmation cannot carry a high-water timestamp or unbounded IDs', () => {
  assert.deepEqual(chatApi.parseClientChatReadBody({ messageIds: [3, 5, 3] }), [3, 5]);
  for (const body of [null, [], {}, { messageIds: [] }, { messageIds: ['3'] }, { messageIds: [0] }, { messageIds: [-1] },
    { messageIds: [1.5] }, { messageIds: [Number.MAX_SAFE_INTEGER + 1] }, { messageIds: [1], readAt: 'now' },
    { messageIds: Array.from({ length: 101 }, (_, i) => i + 1) }]) {
    assert.throws(() => chatApi.parseClientChatReadBody(body), chatApi.ClientChatRequestError);
  }
});

test('read body reader limits declared and chunked bodies and stops aborted reads', async () => {
  const request = (body: string, headers?: Record<string, string>) => new Request('https://example.test/chat/read', { method: 'POST', body, headers });
  assert.deepEqual(await chatApi.readClientChatAcknowledgement(request('{"messageIds":[9]}')), [9]);
  for (const value of [request('x'.repeat(4097)), request('{}', { 'content-length': '4097' }), request('{}', { 'content-length': '-1' })]) {
    await assert.rejects(chatApi.readClientChatAcknowledgement(value), (error: unknown) => error instanceof chatApi.ClientChatRequestError && error.status === 413);
  }
  await assert.rejects(chatApi.readClientChatAcknowledgement(request('{')), chatApi.ClientChatRequestError);
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = chatApi.readClientChatAcknowledgement(new Request('https://example.test/chat/read', {
    method: 'POST', body: stream, signal: controller.signal, duplex: 'half',
  } as RequestInit));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof chatApi.ClientChatRequestError && error.status === 408);
  assert.equal(cancelled, true);
});

function routes(kind: 'employee' | 'client', mode: 'chat' | 'read', options: { denied?: boolean; forbidden?: boolean; limited?: boolean; changed?: boolean; failure?: boolean } = {}) {
  const calls: Array<{ operation: string; args: unknown[] }> = [];
  const result = { messages: [], unreadCount: 301, olderCursor: 201, newerCursor: 301, hasOlder: true, hasNewer: false, readMessageIds: [] };
  const actor = { companyId: 7, clientUserId: 19, role: 'admin', adminUserId: 4 };
  const requireSession = async () => options.denied ? { denied: Response.json({}, { status: 401 }) } : { session: actor };
  const get = async (...args: unknown[]) => { calls.push({ operation: 'get', args }); return result; };
  const ack = async (...args: unknown[]) => {
    calls.push({ operation: 'ack', args });
    if (options.failure) throw new Error('Компания недоступна');
    return { acknowledgedIds: [301], unreadCount: 300, changed: options.changed ?? true };
  };
  const dependencies: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { requireEmployee: requireSession },
    '@/shared/lib/clientAuth': { requireClientSession: requireSession },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => options.limited ? Response.json({}, { status: 429 }) : null },
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => options.forbidden ? Response.json({}, { status: 403 }) : null },
    '@/shared/lib/rateLimit': { checkDbRateLimit: async () => ({ allowed: !options.limited, retryAfter: 1 }), getClientIp: () => 'synthetic' },
    '@/shared/lib/clientChatApi': chatApi,
    '@/shared/lib/wholesaleSecurity': { normalizeTextField: (value: string) => value },
    '@/shared/lib/clientRealtime': { publishClientRealtimeEvent: (...args: unknown[]) => calls.push({ operation: 'publish', args }) },
    '@/shared/lib/db': {
      getClientChatConversationForAdmin: get, getClientChatConversationForClient: get,
      markClientChatReadForAdmin: ack, markClientChatReadForClient: ack,
      getClientChatUnreadCountForAdmin: () => { throw new Error('GET must not cause implicit read flow'); },
      getClientChatUnreadCountForClient: () => { throw new Error('GET must not cause implicit read flow'); },
    },
  };
  const route = kind === 'employee' ? 'admin/clients/[id]/chat' : 'client/chat';
  const file = new URL(`../src/app/api/${route}${mode === 'read' ? '/read' : ''}/route.ts`, import.meta.url);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  const testModule = { exports: {} as { GET: Handler; POST: Handler } };
  vm.runInNewContext(code, { module: testModule, exports: testModule.exports, require: (key: string) => {
    if (!(key in dependencies)) throw new Error(`Unexpected import: ${key}`);
    return dependencies[key];
  }, Response, Request, Error });
  return { handlers: testModule.exports, calls, result, actor, context: { params: Promise.resolve({ id: '7' }) } };
}

for (const kind of ['employee', 'client'] as const) {
  test(`${kind} chat GET is a private read-only page, never marks unseen messages or publishes read events`, async () => {
    const fixture = routes(kind, 'chat');
    const response = await fixture.handlers.GET(new Request('https://example.test/chat?before=201&receiptIds=8,9'), fixture.context);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await response.json(), fixture.result);
    assert.deepEqual(fixture.calls.map(call => call.operation), ['get']);
    assert.deepEqual(fixture.calls[0].args.at(-1), { before: 201, receiptIds: [8, 9] });
    const invalid = await fixture.handlers.GET(new Request('https://example.test/chat?after=1&before=2'), fixture.context);
    assert.equal(invalid.status, 400);
    assert.equal(fixture.calls.length, 1);
  });

  test(`${kind} explicit read confirmation is bounded, authenticated, origin checked and idempotent`, async () => {
    const makeRequest = () => new Request('https://example.test/chat/read', { method: 'POST', body: JSON.stringify({ messageIds: [301] }) });
    for (const [options, expected] of [[{ denied: true }, 401], [{ forbidden: true }, 403], [{ limited: true }, 429]] as const) {
      const fixture = routes(kind, 'read', options);
      const response = await fixture.handlers.POST(makeRequest(), fixture.context);
      assert.equal(response.status, expected); assert.equal(fixture.calls.length, 0);
    }
    for (const changed of [true, false]) {
      const fixture = routes(kind, 'read', { changed });
      const response = await fixture.handlers.POST(makeRequest(), fixture.context);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { acknowledgedIds: [301], unreadCount: 300, changed });
      assert.deepEqual(fixture.calls[0].args.at(-1), [301]);
      assert.deepEqual(fixture.calls.filter(call => call.operation === 'publish').length, Number(changed));
    }
    const fixture = routes(kind, 'read', { failure: true });
    assert.equal((await fixture.handlers.POST(makeRequest(), fixture.context)).status, 400);
    assert.equal(fixture.calls.some(call => call.operation === 'publish'), false);
  });
}
