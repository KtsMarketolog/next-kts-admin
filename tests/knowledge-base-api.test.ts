import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import type { AdminSession, AdminSessionRole } from '../src/shared/lib/adminAuth';
import * as shared from '../src/shared/lib/knowledgeBase';
import * as origin from '../src/shared/lib/originProtection';
import * as uploadGuard from '../src/shared/lib/uploadRequestGuard';
import * as transactionOutcome from '../src/shared/lib/db/transactionOutcome';

function load<T>(filename: string, deps: Record<string, unknown>): T {
  const code = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name];
  }, output, output.exports);
  return output.exports as T;
}
const uuid = 'f2cc608e-7a53-4653-b6fc-f423fc7d7120';
const roles: AdminSessionRole[] = ['admin', 'admintop', 'top', 'wholesale_admin', 'manager', 'support_manager', 'purchaser'];
const folder: shared.KnowledgeBaseNode = { id: 19, parentId: null, kind: 'folder', title: 'Synthetic', revision: '1', archivedAt: null,
  createdAt: '', updatedAt: '', originalName: null, mimeType: null, size: null };
const fileNode = { ...folder, kind: 'file' as const, parentId: 9, originalName: 'doc.pdf', mimeType: 'application/pdf', size: 12 };
const storedFile = { storagePath: `knowledge-base/${uuid}.pdf`, originalName: 'doc.pdf', mimeType: 'application/pdf', size: 12, sha256: '0'.repeat(64) };
function req(endpoint = '', method = 'GET', body?: unknown, headers: HeadersInit = {}) {
  return new Request(`https://example.test/api/admin/knowledge-base${endpoint}`, { method,
    headers: { origin: 'https://example.test', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
function harness(options: { role?: AdminSessionRole | null; denied?: boolean; limited?: boolean; failure?: boolean;
  storageFailure?: boolean; auditFailure?: boolean; duplicate?: boolean; busy?: boolean; unknownCommit?: boolean;
  knownRejection?: boolean; releaseFailure?: boolean; cleanupFailure?: boolean } = {}) {
  const role = options.role === undefined ? 'admin' : options.role;
  const session: AdminSession | null = role ? { role, sessionId: uuid, ...(role.includes('manager') ? { managerId: 7 } : { adminUserId: 8 }) } : null;
  const calls: string[] = []; const inputs: unknown[][] = []; const cleanup: string[] = [];
  let released = 0; let closed = 0;
  const repo = Object.fromEntries(['listKnowledgeBase', 'listKnowledgeBaseActors', 'listKnowledgeBaseStats', 'createKnowledgeBaseFolder',
    'createKnowledgeBaseFile', 'updateKnowledgeBaseNode', 'setKnowledgeBaseArchive', 'recordKnowledgeBaseEvent', 'getKnowledgeBaseNode', 'getKnowledgeBaseFileForRead']
    .map(name => [name, async (...args: unknown[]) => {
      calls.push(name); inputs.push(args); assert.equal(args[0], session, 'current authenticated session always reaches ACL repository');
      if (options.failure && name !== 'getKnowledgeBaseNode') throw new Error('synthetic private DB path secret');
      if (name === 'createKnowledgeBaseFile' && options.unknownCommit) throw new transactionOutcome.TransactionCommitUnknownError();
      if (name === 'createKnowledgeBaseFile' && options.knownRejection) throw new shared.KnowledgeBaseError(409, 'CONFLICT', 'Список изменён');
      if (name === 'getKnowledgeBaseFileForRead') return options.denied ? null : { node: fileNode, storagePath: storedFile.storagePath, sha256: storedFile.sha256 };
      if (name === 'getKnowledgeBaseNode') return options.denied ? null : folder;
      if (options.denied) throw shared.knowledgeBaseNotFound();
      if (name === 'recordKnowledgeBaseEvent') { if (options.auditFailure) throw new Error('private audit failure'); return { recorded: true }; }
      if (name.startsWith('create')) return { node: folder, created: !options.duplicate };
      if (name === 'listKnowledgeBase') return { nodes: [folder], breadcrumbs: [], nextCursor: null, canManage: shared.canManageKnowledgeBase(session) };
      if (name === 'listKnowledgeBaseActors') return { actors: [], nextCursor: null };
      if (name === 'listKnowledgeBaseStats') return { rows: [], nextCursor: null };
      return folder;
    }]));
  const api = load<typeof import('../src/shared/lib/knowledgeBaseApi')>('../src/shared/lib/knowledgeBaseApi.ts', {
    './adminAuth': { getAdminSession: async () => session },
    './adminSecurity': { enforceAdminActionRateLimit: async () => options.limited ? Response.json({}, { status: 429 }) : null },
    './originProtection': origin, './uploadRequestGuard': uploadGuard, './knowledgeBase': shared, './db/transactionOutcome': transactionOutcome,
  });
  const deps = { '@/shared/lib/knowledgeBaseApi': api, '@/shared/lib/knowledgeBase': shared, '@/shared/lib/db/knowledgeBaseRepo': repo, crypto,
    '@/shared/lib/knowledgeBaseStorage': {
      saveKnowledgeBaseUpload: async () => { calls.push('save'); if (options.storageFailure) throw new Error('private path'); return storedFile; },
      removeUncommittedKnowledgeBaseFile: async (path: string) => { cleanup.push(path); if (options.cleanupFailure) throw new Error('synthetic cleanup private path'); },
      openKnowledgeBaseFile: async () => { calls.push('open'); if (options.storageFailure) throw new Error('private path'); return { close: async () => { closed++; } }; },
      knowledgeBaseFilename: () => ({ name: 'doc.pdf', mimeType: 'application/pdf', extension: 'pdf' }),
      knowledgeBaseFileStream: () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([65])); controller.close(); } }),
    },
    '@/shared/lib/knowledgeBaseUploadConcurrency': { acquireKnowledgeBaseUploadSlot: async () => options.busy ? null : async () => { released++; if (options.releaseFailure) throw new Error('synthetic unlock error'); } },
  };
  return { calls, inputs, cleanup, released: () => released, closed: () => closed,
    base: load<typeof import('../src/app/api/admin/knowledge-base/route')>('../src/app/api/admin/knowledge-base/route.ts', deps),
    patch: load<typeof import('../src/app/api/admin/knowledge-base/[id]/route')>('../src/app/api/admin/knowledge-base/[id]/route.ts', deps),
    actors: load<typeof import('../src/app/api/admin/knowledge-base/employees/route')>('../src/app/api/admin/knowledge-base/employees/route.ts', deps),
    usage: load<typeof import('../src/app/api/admin/knowledge-base/usage/route')>('../src/app/api/admin/knowledge-base/usage/route.ts', deps),
    events: load<typeof import('../src/app/api/admin/knowledge-base/events/route')>('../src/app/api/admin/knowledge-base/events/route.ts', deps),
    upload: load<typeof import('../src/app/api/admin/knowledge-base/upload/route')>('../src/app/api/admin/knowledge-base/upload/route.ts', deps),
    files: load<typeof import('../src/app/api/admin/knowledge-base/files/[id]/route')>('../src/app/api/admin/knowledge-base/files/[id]/route.ts', deps),
  };
}
const context = (id = '19') => ({ params: Promise.resolve({ id }) });
function privateResponse(response: Response) {
  assert.match(response.headers.get('cache-control')!, /private.*no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('vary'), 'Cookie');
}
function uploadRequest() { return req(`/upload?parentId=19&operationId=${uuid}`, 'POST', 'synthetic', {
  'x-kb-file-name': encodeURIComponent('doc.pdf'), 'x-kb-title': encodeURIComponent('Инструкция'), 'content-type': 'application/octet-stream',
}); }

test('KB read accepts all authenticated employee roles including TOP, while only Admin/Admin TOP manage or inspect people/statistics', async () => {
  for (const role of [...roles, null]) {
    const h = harness({ role }); const manage = role === 'admin' || role === 'admintop';
    const read = await h.base.GET(req()); privateResponse(read); assert.equal(read.status, role ? 200 : 401, String(role));
    const post = await h.base.POST(req('', 'POST', { operationId: uuid, parentId: null, title: 'Section' }));
    privateResponse(post); assert.equal(post.status, manage ? 200 : role ? 403 : 401, String(role));
    for (const response of [await h.actors.GET(req('/employees')), await h.usage.GET(req('/usage'))]) {
      assert.equal(response.status, manage ? 200 : role ? 403 : 401); privateResponse(response);
    }
  }
});

test('KB auth, origin and actor limits precede storage, metadata and mutations', async () => {
  for (const options of [{ role: null }, { role: 'top' as const }, { limited: true }]) {
    const h = harness(options); const response = await h.upload.POST(uploadRequest());
    assert.ok([401, 403, 429].includes(response.status)); privateResponse(response); assert.deepEqual(h.calls, []);
  }
  for (const headers of [{ origin: 'https://evil.test' }, { origin: '' }]) {
    const h = harness(); const response = await h.base.POST(req('', 'POST', {}, headers));
    assert.equal(response.status, 403); privateResponse(response); assert.deepEqual(h.calls, []);
  }
});

test('KB rejects noncanonical IDs, unknown mutation fields, wrong JSON and oversized chunked JSON before DB changes', async () => {
  for (const id of ['0', '-1', '01', '19.0', '19e0', '9007199254740992', 'a/b']) {
    const h = harness(); const response = await h.patch.PATCH(req('/19', 'PATCH', { expectedRevision: '1', title: 'X' }), context(id));
    assert.equal(response.status, 400); assert.deepEqual(h.calls, []);
  }
  for (const body of [{ unexpected: true }, '{bad', ' '.repeat(65 * 1024)]) {
    const h = harness(); const response = await h.base.POST(req('', 'POST', body));
    assert.ok([400, 413].includes(response.status)); assert.deepEqual(h.calls, []); privateResponse(response);
  }
});

test('KB PATCH forwards expected revision; archive cannot be mixed with a silent rename or ACL update', async () => {
  const h = harness();
  assert.equal((await h.patch.PATCH(req('/19', 'PATCH', { expectedRevision: '9', title: 'X' }), context())).status, 200);
  assert.deepEqual(h.inputs[0].slice(1), [19, { expectedRevision: '9', title: 'X' }]);
  assert.equal((await h.patch.PATCH(req('/19', 'PATCH', { expectedRevision: '9', archived: true, title: 'X' }), context())).status, 400);
  assert.equal(h.calls.length, 1);
});

test('KB files enforce repository ACL for every request before reading bytes or recording events', async () => {
  for (const role of roles) {
    const h = harness({ role, denied: true });
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await h.files[method](req('/files/19?mode=preview', method), context());
      assert.equal(response.status, 404); privateResponse(response);
    }
    assert.deepEqual(h.calls, ['getKnowledgeBaseFileForRead', 'getKnowledgeBaseFileForRead']);
  }
});

test('KB file events happen only after storage opens; HEAD never records a view/download and errors disclose no storage details', async () => {
  const h = harness();
  const response = await h.files.GET(req(`/files/19?mode=download&eventId=${uuid}`), context());
  assert.equal(response.status, 200); privateResponse(response);
  assert.match(response.headers.get('content-disposition')!, /^attachment;/);
  assert.deepEqual(h.calls, ['getKnowledgeBaseFileForRead', 'open', 'recordKnowledgeBaseEvent']);
  assert.deepEqual(h.inputs[1][1], { eventId: uuid, nodeId: 19, action: 'download_started' });
  await response.text();
  const head = harness();
  assert.equal((await head.files.HEAD(req('/files/19?mode=preview', 'HEAD'), context())).status, 200);
  assert.deepEqual(head.calls, ['getKnowledgeBaseFileForRead', 'open']); assert.equal(head.closed(), 1);
  for (const options of [{ storageFailure: true }, { auditFailure: true }, { failure: true }]) {
    const denied = harness(options); const error = await denied.files.GET(req('/files/19'), context());
    assert.equal(error.status, 503); privateResponse(error); assert.doesNotMatch(await error.text(), /private path|secret|audit failure/);
  }
});

test('KB UI cannot forge successful file events, and scoped parent is checked before reading an upload', async () => {
  for (const action of ['file_view', 'download_started']) {
    const h = harness(); assert.equal((await h.events.POST(req('/events', 'POST', { action, eventId: uuid, nodeId: 19 }))).status, 400);
    assert.deepEqual(h.calls, []);
  }
  const h = harness({ denied: true }); assert.equal((await h.upload.POST(uploadRequest())).status, 404);
  assert.deepEqual(h.calls, ['getKnowledgeBaseNode']);
});

test('KB uploads release every slot; uncertain DB commits preserve bytes and duplicate retries discard only the new file', async () => {
  for (const options of [{}, { failure: true }, { storageFailure: true }, { duplicate: true }]) {
    const h = harness(options); const response = await h.upload.POST(uploadRequest());
    assert.equal(response.status, options.failure || options.storageFailure ? 503 : 200);
    assert.equal(h.released(), 1);
    assert.deepEqual(h.cleanup, options.duplicate ? [storedFile.storagePath] : []);
  }
  const busy = harness({ busy: true }); assert.equal((await busy.upload.POST(uploadRequest())).status, 429);
  assert.equal(busy.released(), 0); assert.deepEqual(busy.calls, ['getKnowledgeBaseNode']);
});

test('KB upload reports uncertain commit honestly and never erases its possibly referenced file', async () => {
  const h = harness({ unknownCommit: true }); const response = await h.upload.POST(uploadRequest());
  assert.equal(response.status, 503); privateResponse(response);
  assert.equal((await response.json()).code, 'COMMIT_OUTCOME_UNKNOWN');
  assert.deepEqual(h.cleanup, []); assert.equal(h.released(), 1);
  const rejected = harness({ knownRejection: true });
  assert.equal((await rejected.upload.POST(uploadRequest())).status, 409);
  assert.deepEqual(rejected.cleanup, [storedFile.storagePath]);
});

test('KB successful save is not misreported as failure if cleanup or lock release fails afterward', async () => {
  const warnings: unknown[][] = [];
  const original = console.warn; console.warn = (...args) => { warnings.push(args); };
  try {
    for (const options of [{ releaseFailure: true }, { duplicate: true, cleanupFailure: true }]) {
      const h = harness(options); const response = await h.upload.POST(uploadRequest());
      assert.equal(response.status, 200); const body = await response.json();
      assert.equal(body.node.id, 19); assert.match(body.warning, /сохранён/);
      assert.equal(h.released(), 1);
    }
  } finally { console.warn = original; }
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(JSON.stringify(warnings), /private path|unlock error|synthetic/);
});
