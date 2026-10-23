import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import { MAX_CLIENT_DOCUMENT_SIZE } from '../src/shared/lib/clientDocumentStorage';
import * as clientDocumentStorage from '../src/shared/lib/clientDocumentStorage';
import * as boundedMultipartUpload from '../src/shared/lib/boundedMultipartUpload';
import { TransactionCommitUnknownError } from '../src/shared/lib/db/transactionOutcome';
import { UploadRequestError } from '../src/shared/lib/uploadRequestGuard';
import { normalizeTextField } from '../src/shared/lib/wholesaleSecurity';

function load<T>(filename: string, modules: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const instance = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, instance, instance.exports);
  return instance.exports as T;
}

class BoundedMultipartUploadError extends Error {
  readonly code = 'INVALID_MULTIPART';
  readonly status = 400;
}

function uploadHarness(options: {
  denied?: boolean;
  forbidden?: boolean;
  limited?: boolean;
  preflightError?: Error;
  busy?: boolean;
  parseError?: Error;
  missingFile?: boolean;
  createError?: Error;
  cleanupError?: boolean;
  releaseError?: boolean;
  notificationError?: boolean;
  abortAfterFile?: boolean;
  abortAfterCommit?: boolean;
  loseSlotAfterFile?: boolean;
  loseSlotAfterCommit?: boolean;
} = {}) {
  const calls: string[] = [];
  const controller = new AbortController();
  const slotController = new AbortController();
  let parsedSignal: AbortSignal | null = null;
  const session = { role: 'manager', managerId: 21 };
  const file = new File(['synthetic document only'], 'Счёт.pdf', { type: 'application/pdf' });
  const savedFile = { originalName: file.name, mimeType: file.type, filePath: 'client-documents/13/synthetic.pdf', fileSize: file.size };
  const document = { id: 3, companyId: 13, title: 'Счёт', ...savedFile };
  const body = new FormData();
  if (!options.missingFile) body.set('file', file);
  body.set('title', ' Счёт ');
  body.set('isVisible', 'false');
  const request = new Request('https://example.test/api/admin/clients/13/documents', { method: 'POST', body, signal: controller.signal });

  const handler = load<typeof import('../src/app/api/admin/clients/[id]/documents/route')>('src/app/api/admin/clients/[id]/documents/route.ts', {
    '@/shared/lib/adminAuth': { requireEmployee: async () => ({ session, denied: options.denied ? new Response('', { status: 401 }) : null }) },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => options.limited ? new Response('', { status: 429 }) : null },
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => options.forbidden ? new Response('', { status: 403 }) : null },
    '@/shared/lib/db/clientDocumentsRepo': { assertClientDocumentUploadAllowed: async (id: number, actualSession: unknown) => {
      calls.push('authorize-company');
      assert.equal(id, 13);
      assert.equal(actualSession, session);
      if (options.preflightError) throw options.preflightError;
    } },
    '@/shared/lib/resourceUploadConcurrency': { acquireResourceUploadSlot: async (kind: string) => {
      assert.equal(kind, 'document');
      calls.push('admit');
      if (options.busy) return null;
      const release = async () => {
        calls.push('release');
        if (options.releaseError) throw new Error('synthetic release failure');
      };
      return Object.assign(release, { signal: slotController.signal });
    } },
    '@/shared/lib/boundedMultipartUpload': { BoundedMultipartUploadError, readBoundedMultipartUpload: async (source: Request, limits: Record<string, unknown>) => {
      calls.push('read-body');
      assert.equal(source, request);
      const { signal, ...resourceLimits } = limits;
      assert.ok(signal instanceof AbortSignal);
      parsedSignal = signal;
      assert.deepEqual(resourceLimits, {
        maxBodyBytes: MAX_CLIENT_DOCUMENT_SIZE + 256 * 1024,
        maxFileBytes: MAX_CLIENT_DOCUMENT_SIZE,
        maxFiles: 1,
        maxFields: 2,
        maxFieldBytes: 4096,
        allowedFileFields: ['file'],
        allowedTextFields: ['title', 'isVisible'],
      });
      if (options.parseError) throw options.parseError;
      return source.formData();
    } },
    '@/shared/lib/clientDocumentStorage': { MAX_CLIENT_DOCUMENT_SIZE, saveClientDocumentUpload: async (id: number, upload: File, storageOptions: { signal: AbortSignal }) => {
      calls.push('save-file');
      assert.equal(id, 13);
      assert.equal(upload.name, file.name);
      assert.equal(storageOptions.signal, parsedSignal);
      if (options.abortAfterFile) controller.abort();
      if (options.loseSlotAfterFile) slotController.abort(new Error('synthetic private connection details'));
      return savedFile;
    } },
    '@/shared/lib/db': { createClientDocument: async (id: number, input: unknown, actualSession: unknown) => {
      calls.push('create-document');
      assert.equal(id, 13);
      assert.equal(actualSession, session);
      assert.deepEqual(input, { ...savedFile, title: 'Счёт', isVisible: false });
      if (options.createError) throw options.createError;
      if (options.abortAfterCommit) controller.abort();
      if (options.loseSlotAfterCommit) slotController.abort(new Error('synthetic private connection details'));
      return document;
    } },
    '@/shared/lib/db/clientDocumentCleanupRepo': { removeUnreferencedClientDocumentUpload: async (filePath: string, id: number) => {
      calls.push('cleanup-unreferenced-file');
      assert.equal(filePath, savedFile.filePath);
      assert.equal(id, 13);
      if (options.cleanupError) throw new Error('synthetic cleanup failure');
      return options.createError instanceof TransactionCommitUnknownError ? 'referenced' : 'removed';
    } },
    '@/shared/lib/clientRealtime': { publishClientRealtimeEvent: () => {
      calls.push('notify');
      if (options.notificationError) throw new Error('synthetic notification failure');
    } },
    '@/shared/lib/db/transactionOutcome': { TransactionCommitUnknownError },
    '@/shared/lib/uploadRequestGuard': { UploadRequestError },
    '@/shared/lib/wholesaleSecurity': { normalizeTextField },
  });
  return { calls, request, document, run: () => handler.POST(request, { params: Promise.resolve({ id: '13' }) }) };
}

test('unauthorized, cross-origin and rate-limited document requests never read or save files', async () => {
  for (const [options, status] of [[{ denied: true }, 401], [{ forbidden: true }, 403], [{ limited: true }, 429]] as const) {
    const h = uploadHarness(options);
    assert.equal((await h.run()).status, status);
    assert.equal(h.request.bodyUsed, false);
    assert.deepEqual(h.calls, []);
  }
});

test('unassigned, missing and archived companies reject document uploads before reading or writing files', async () => {
  for (const message of ['Компания клиента не найдена', 'Клиент в архиве. Сначала восстановите его; данные не изменены.']) {
    const h = uploadHarness({ preflightError: new Error(message) });
    const response = await h.run();
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, message);
    assert.equal(h.request.bodyUsed, false);
    assert.deepEqual(h.calls, ['authorize-company']);
  }
});

test('exhausted shared upload capacity does not read the document body and gives a retry hint', async () => {
  const h = uploadHarness({ busy: true });
  const response = await h.run();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.equal((await response.json()).saved, false);
  assert.equal(h.request.bodyUsed, false);
  assert.deepEqual(h.calls, ['authorize-company', 'admit']);
});

test('valid document authorizes first, uses bounded parsing and releases admission after confirmed save', async () => {
  const h = uploadHarness();
  const response = await h.run();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { document: h.document });
  assert.deepEqual(h.calls, ['authorize-company', 'admit', 'read-body', 'save-file', 'create-document', 'notify', 'release']);
});

test('oversized, interrupted and malformed bodies never create files and always release admission', async () => {
  for (const error of [new UploadRequestError('TOO_LARGE'), new UploadRequestError('IDLE_TIMEOUT'), new UploadRequestError('ABORTED'), new BoundedMultipartUploadError('Invalid form')]) {
    const h = uploadHarness({ parseError: error });
    const response = await h.run();
    assert.equal(response.status, error.status);
    const body = await response.json();
    assert.equal(body.saved, false);
    assert.equal(body.code, error.code);
    assert.deepEqual(h.calls, ['authorize-company', 'admit', 'read-body', 'release']);
  }
});

test('a missing file releases admission without writing a document', async () => {
  const h = uploadHarness({ missingFile: true });
  assert.equal((await h.run()).status, 400);
  assert.deepEqual(h.calls, ['authorize-company', 'admit', 'read-body', 'release']);
});

test('access/archive change during upload still rejects the final write and cleans only the unreferenced file', async () => {
  const h = uploadHarness({ createError: new Error('Клиент в архиве') });
  const response = await h.run();
  assert.equal(response.status, 400);
  assert.deepEqual(h.calls, ['authorize-company', 'admit', 'read-body', 'save-file', 'create-document', 'cleanup-unreferenced-file', 'release']);
});

test('uncertain document commit keeps unknown-result semantics and uses reference-checked cleanup', async () => {
  const h = uploadHarness({ createError: new TransactionCommitUnknownError() });
  const response = await h.run();
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.saved, null);
  assert.equal(result.code, 'COMMIT_OUTCOME_UNKNOWN');
  assert.deepEqual(h.calls.slice(-3), ['create-document', 'cleanup-unreferenced-file', 'release']);
});

test('disconnect before the transaction removes the unsaved file and never starts a DB mutation', async () => {
  const h = uploadHarness({ abortAfterFile: true });
  const response = await h.run();
  assert.equal(response.status, 400);
  assert.equal((await response.json()).saved, false);
  assert.deepEqual(h.calls, ['authorize-company', 'admit', 'read-body', 'save-file', 'cleanup-unreferenced-file', 'release']);
});

test('confirmed save stays successful after disconnect, notification failure or admission cleanup failure', async () => {
  for (const options of [{ abortAfterCommit: true }, { notificationError: true }, { releaseError: true }, { loseSlotAfterCommit: true }]) {
    const h = uploadHarness(options);
    const response = await h.run();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { document: h.document });
    assert.equal(h.calls.includes('cleanup-unreferenced-file'), false);
    assert.equal(h.calls.at(-1), 'release');
  }
});

test('lost shared admission cancels the upload before a DB mutation without leaking connection details', async () => {
  const h = uploadHarness({ loseSlotAfterFile: true });
  const response = await h.run();
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.saved, false);
  assert.doesNotMatch(result.error, /private connection details/);
  assert.equal(h.calls.includes('create-document'), false);
  assert.deepEqual(h.calls.slice(-2), ['cleanup-unreferenced-file', 'release']);
});

test('failed file cleanup does not mask a failed document save and still releases admission', async () => {
  const h = uploadHarness({ createError: new TransactionCommitUnknownError(), cleanupError: true });
  const response = await h.run();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'COMMIT_OUTCOME_UNKNOWN');
  assert.equal(h.calls.at(-1), 'release');
});

test('document upload preflight uses the same company write authorization in a short, completed transaction', async () => {
  const calls: string[] = [];
  const session = { role: 'manager' as const, managerId: 21 };
  const client = {};
  const repo = load<typeof import('../src/shared/lib/db/clientDocumentsRepo')>('src/shared/lib/db/clientDocumentsRepo.ts', {
    './schema': { ensureSiteSchema: async () => { calls.push('schema'); } },
    './client': { withTransaction: async (run: (client: unknown) => Promise<unknown>, options: unknown) => {
      calls.push('begin');
      assert.deepEqual(options, { retryOnConflict: true });
      await run(client);
      calls.push('end');
    } },
    './clientCompaniesRepo': { assertClientCompanyWritable: async (id: number, actualSession: unknown, actualClient: unknown) => {
      calls.push('assert-writable');
      assert.equal(id, 13);
      assert.equal(actualSession, session);
      assert.equal(actualClient, client);
    } },
  });
  await repo.assertClientDocumentUploadAllowed(13, session);
  assert.deepEqual(calls, ['schema', 'begin', 'assert-writable', 'end']);
});

test('real streaming multipart and private storage preserve a legitimate document; rejected bodies never write', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kts-document-route-stream-'));
  const oldRoot = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = root;
  t.after(async () => {
    if (oldRoot === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
  });
  let documentsCreated = 0;
  let admissionsReleased = 0;
  const savedPaths: string[] = [];
  const handler = load<typeof import('../src/app/api/admin/clients/[id]/documents/route')>('src/app/api/admin/clients/[id]/documents/route.ts', {
    '@/shared/lib/adminAuth': { requireEmployee: async () => ({ session: { role: 'admin' } }) },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => null },
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => null },
    '@/shared/lib/db/clientDocumentsRepo': { assertClientDocumentUploadAllowed: async () => undefined },
    '@/shared/lib/resourceUploadConcurrency': { acquireResourceUploadSlot: async () => Object.assign(
      async () => { admissionsReleased++; }, { signal: new AbortController().signal },
    ) },
    '@/shared/lib/boundedMultipartUpload': boundedMultipartUpload,
    '@/shared/lib/clientDocumentStorage': clientDocumentStorage,
    '@/shared/lib/db': { createClientDocument: async (_id: number, input: clientDocumentStorage.SavedClientDocumentFile & { title: string; isVisible: boolean }) => {
      documentsCreated++;
      savedPaths.push(input.filePath);
      assert.equal(input.originalName, 'Документ.txt');
      assert.equal(input.title, 'Документ');
      assert.equal(input.isVisible, true);
      return { id: documentsCreated, title: input.title, fileSize: input.fileSize };
    } },
    '@/shared/lib/db/clientDocumentCleanupRepo': { removeUnreferencedClientDocumentUpload: async () => assert.fail('Rejected multipart must not create a file') },
    '@/shared/lib/clientRealtime': { publishClientRealtimeEvent: () => undefined },
    '@/shared/lib/db/transactionOutcome': { TransactionCommitUnknownError },
    '@/shared/lib/uploadRequestGuard': { UploadRequestError },
    '@/shared/lib/wholesaleSecurity': { normalizeTextField },
  });
  const context = { params: Promise.resolve({ id: '13' }) };
  const url = 'https://example.test/api/admin/clients/13/documents';
  const body = new FormData();
  body.set('file', new File(['Синтетический документ'], 'Документ.txt', { type: 'text/plain' }));
  body.set('title', 'Документ');
  body.set('isVisible', 'true');
  const response = await handler.POST(new Request(url, { method: 'POST', body }), context);
  assert.equal(response.status, 200);
  assert.equal((await clientDocumentStorage.readClientDocumentFile(savedPaths[0], 13)).toString(), 'Синтетический документ');
  const filesBefore = await readdir(path.join(root, 'client-documents', '13'));

  const oversized = new Request(url, {
    method: 'POST', body: 'not read', headers: {
      'content-type': 'multipart/form-data; boundary=x',
      'content-length': String(MAX_CLIENT_DOCUMENT_SIZE + 256 * 1024 + 1),
    },
  });
  assert.equal((await handler.POST(oversized, context)).status, 413);
  assert.equal(oversized.bodyUsed, false);
  body.set('title', 'x'.repeat(4097));
  const encoded = new Request(url, { method: 'POST', body });
  const invalidField = new Request(url, { method: 'POST', body: await encoded.arrayBuffer(), headers: encoded.headers });
  const invalidResponse = await handler.POST(invalidField, context);
  assert.equal(invalidResponse.status, 413);
  assert.equal((await invalidResponse.json()).code, 'FIELD_TOO_LARGE');
  assert.equal(documentsCreated, 1);
  assert.equal(admissionsReleased, 3);
  assert.deepEqual(await readdir(path.join(root, 'client-documents', '13')), filesBefore);
});
