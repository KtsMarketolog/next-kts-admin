import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';
import { removeClientDocumentFile } from '../src/shared/lib/clientDocumentStorage';
import * as outcome from '../src/shared/lib/db/transactionOutcome';

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

test('document file removal is exact, idempotent, company-bound and rejects symlinks/traversal', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kts-document-cleanup-'));
  const oldRoot = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = root;
  t.after(async () => {
    if (oldRoot === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = oldRoot;
    await rm(root, { recursive: true });
  });
  await mkdir(path.join(root, 'client-documents', '13'), { recursive: true });
  const relative = 'client-documents/13/example.pdf';
  await writeFile(path.join(root, relative), 'synthetic only');
  await writeFile(path.join(root, 'keep.txt'), 'preserve');
  for (const invalid of ['client-documents/../keep.txt', 'client-documents/13/../../keep.txt', '/tmp/keep.txt', 'client-documents/13/..', 'client-documents\\13\\example.pdf']) {
    await assert.rejects(removeClientDocumentFile(invalid, 13), /Некорректный путь/);
  }
  await assert.rejects(removeClientDocumentFile(relative, 14), /Некорректный путь/);
  await symlink(path.join(root, 'keep.txt'), path.join(root, 'client-documents', '13', 'link.pdf'));
  await assert.rejects(removeClientDocumentFile('client-documents/13/link.pdf', 13), /Небезопасный файл/);
  await symlink(path.join(root, 'client-documents', '13'), path.join(root, 'client-documents', '14'));
  await assert.rejects(removeClientDocumentFile('client-documents/14/example.pdf', 14), /Небезопасный каталог/);
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'preserve');
  assert.equal(await removeClientDocumentFile(relative, 13), 'removed');
  assert.equal(await removeClientDocumentFile(relative, 13), 'missing');
  process.env.UPLOAD_DIR = path.join(root, 'unavailable-storage-root');
  await assert.rejects(removeClientDocumentFile(relative, 13), { code: 'ENOENT' });
});

function cleanupHarness(options: { referenced?: boolean; completed?: boolean; missingJob?: boolean; failure?: Error } = {}) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const files: unknown[][] = [];
  const policies: unknown[] = [];
  const client = { query: async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args });
    if (sql.includes('from client_document_file_cleanup') && sql.includes('for update')) return {
      rows: options.missingJob ? [] : [{ company_id: '13', file_path: 'client-documents/13/synthetic.pdf', completed_at: options.completed ? '2026-01-01' : null }],
    };
    if (sql.includes('as referenced')) return { rows: [{ referenced: options.referenced ?? false }] };
    return { rows: [] };
  } };
  const repo = load<typeof import('../src/shared/lib/db/clientDocumentCleanupRepo')>('src/shared/lib/db/clientDocumentCleanupRepo.ts', {
    '../clientDocumentStorage': { removeClientDocumentFile: async (...args: unknown[]) => {
      files.push(args);
      if (options.failure) throw options.failure;
      return 'removed';
    } },
    './client': { query: client.query, withTransaction: async (run: (client: unknown) => Promise<unknown>, policy: unknown) => {
      policies.push(policy);
      return run(client);
    } },
  });
  return { repo, calls, files, policies };
}

test('cleanup locks exact queue entry, prevents new references, checks references, then removes exact file', async () => {
  const h = cleanupHarness();
  assert.deepEqual(await h.repo.processClientDocumentCleanup(8), { pending: false });
  assert.match(h.calls[0].sql, /for update/);
  assert.deepEqual(h.calls[0].args, [8]);
  assert.match(h.calls[1].sql, /lock table client_documents in share mode/);
  assert.match(h.calls[2].sql, /pg_advisory_xact_lock/);
  assert.match(h.calls[3].sql, /as referenced/);
  assert.deepEqual(h.files, [['client-documents/13/synthetic.pdf', 13]]);
  assert.deepEqual(h.calls.at(-1)?.args, [8, null]);
  assert.deepEqual(h.policies, [{ trackCommitOutcome: true }], 'Filesystem operations cannot auto-replay after transaction conflicts');
});

test('cleanup keeps referenced file pending and never unlinks it', async () => {
  const h = cleanupHarness({ referenced: true });
  assert.deepEqual(await h.repo.processClientDocumentCleanup(8), { pending: true, reason: 'FILE_STILL_REFERENCED' });
  assert.deepEqual(h.files, []);
  assert.deepEqual(h.calls.at(-1)?.args, [8, 'FILE_STILL_REFERENCED']);
});

test('cleanup persists bounded storage error codes, not filesystem details', async () => {
  for (const error of [Object.assign(new Error('/secret/server/path'), { code: 'EACCES' }), new Error('/secret/server/path')]) {
    const h = cleanupHarness({ failure: error });
    const result = await h.repo.processClientDocumentCleanup(8);
    assert.equal(result.pending, true);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    assert.doesNotMatch(JSON.stringify(h.calls.at(-1)), /secret/);
    assert.equal(h.calls.at(-1)?.args[1], 'code' in error ? 'EACCES' : 'UNSAFE_OR_UNAVAILABLE_FILE');
  }
});

test('completed cleanup is an idempotent no-op and invalid/missing ids cannot delete', async () => {
  const h = cleanupHarness({ completed: true });
  assert.deepEqual(await h.repo.processClientDocumentCleanup(8), { pending: false });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.files, []);
  await assert.rejects(h.repo.processClientDocumentCleanup(0), /Некорректный/);
  const missing = cleanupHarness({ missingJob: true });
  await assert.rejects(missing.repo.processClientDocumentCleanup(999), /не найдено/);
  assert.deepEqual(missing.files, []);
});

test('failed upload cleanup preserves a reference committed despite an interrupted response', async () => {
  const h = cleanupHarness({ referenced: true });
  assert.equal(await h.repo.removeUnreferencedClientDocumentUpload('client-documents/13/synthetic.pdf', 13), 'referenced');
  assert.deepEqual(h.files, []);
  assert.match(h.calls[0].sql, /lock table/);
});

test('pending inventory only reads queue metadata, without schema changes or disk access', async () => {
  const h = cleanupHarness();
  await h.repo.listPendingClientDocumentCleanup();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].sql, /^select/);
  assert.match(h.calls[0].sql, /limit 100/);
  assert.deepEqual(h.files, []);
  assert.deepEqual(h.policies, []);
});

function documentsHarness(options: { archived?: boolean; queueFailure?: boolean } = {}) {
  let documentExists = true;
  let queueExists = false;
  const calls: string[] = [];
  const original = { id: '2', company_id: '13', title: 'Synthetic document', original_name: 'example.pdf',
    mime_type: 'application/pdf', file_path: 'client-documents/13/example.pdf', file_size: '5',
    is_visible: true, created_at: '2026-01-01', updated_at: '2026-01-01' };
  const client = { query: async (sql: string) => {
    calls.push(sql);
    if (sql.includes('delete from client_documents')) {
      documentExists = false;
      return { rows: [original] };
    }
    if (sql.includes('insert into client_document_file_cleanup')) {
      if (options.queueFailure) throw new Error('synthetic queue storage failure');
      queueExists = true;
      return { rows: [{ id: '8' }] };
    }
    if (sql.includes('insert into client_documents') || sql.includes('update client_documents')) return { rows: [original] };
    return { rows: [] };
  } };
  const repo = load<typeof import('../src/shared/lib/db/clientDocumentsRepo')>('src/shared/lib/db/clientDocumentsRepo.ts', {
    './schema': { ensureSiteSchema: async () => undefined },
    './clientCompaniesRepo': { assertClientCompanyWritable: async (companyId: number, _session: unknown, db: unknown) => {
      assert.equal(companyId, 13);
      assert.equal(db, client, 'Archive/write check must share the mutation transaction');
      calls.push('assert-writable');
      if (options.archived) throw new Error('Клиент в архиве');
    } },
    './client': { query: () => assert.fail('Document mutations must not escape their transaction'),
      withTransaction: async (run: (db: unknown) => Promise<unknown>) => {
        try { return await run(client); } catch (error) {
          documentExists = true;
          queueExists = false;
          throw error;
        }
      },
    },
  });
  return { repo, calls, documentExists: () => documentExists, queueExists: () => queueExists };
}

test('explicit document deletion persists its cleanup receipt in the same transaction', async () => {
  const h = documentsHarness();
  const result = await h.repo.deleteClientDocument(13, 2, { role: 'admin' });
  assert.equal(result.cleanupId, 8);
  assert.equal(h.calls[0], 'assert-writable');
  assert.equal(h.documentExists(), false);
  assert.equal(h.queueExists(), true);
});

test('cleanup receipt failure rolls back document deletion rather than creating an untracked orphan', async () => {
  const h = documentsHarness({ queueFailure: true });
  await assert.rejects(h.repo.deleteClientDocument(13, 2, { role: 'admin' }), /queue storage failure/);
  assert.equal(h.documentExists(), true);
  assert.equal(h.queueExists(), false);
});

test('archived company rejects document create, visibility edits and delete before any writes', async () => {
  const h = documentsHarness({ archived: true });
  const input = { title: 'Synthetic', originalName: 'example.pdf', mimeType: 'application/pdf',
    filePath: 'client-documents/13/example.pdf', fileSize: 5, isVisible: true };
  await assert.rejects(h.repo.createClientDocument(13, input, { role: 'admin' }), /архиве/);
  await assert.rejects(h.repo.updateClientDocumentVisibility(13, 2, false, { role: 'admin' }), /архиве/);
  await assert.rejects(h.repo.deleteClientDocument(13, 2, { role: 'admin' }), /архиве/);
  assert.deepEqual(h.calls, ['assert-writable', 'assert-writable', 'assert-writable']);
  assert.equal(h.documentExists(), true);
  assert.equal(h.queueExists(), false);
});

function deleteHandler(options: { deleteError?: boolean; uncertainCommit?: boolean; cleanupThrows?: boolean; cleanupPending?: boolean; realtimeThrows?: boolean } = {}) {
  const calls: string[] = [];
  const handlers = load<{ DELETE: (request: Request, context: unknown) => Promise<Response> }>('src/app/api/admin/clients/[id]/documents/[documentId]/route.ts', {
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => null },
    '@/shared/lib/adminAuth': { requireEmployee: async () => ({ session: { role: 'admin' } }) },
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => null },
    '@/shared/lib/db/transactionOutcome': outcome,
    '@/shared/lib/db': { deleteClientDocument: async () => {
      calls.push('delete');
      if (options.uncertainCommit) throw new outcome.TransactionCommitUnknownError();
      if (options.deleteError) throw new Error('synthetic delete failure');
      return { cleanupId: 8 };
    } },
    '@/shared/lib/db/clientDocumentCleanupRepo': { processClientDocumentCleanup: async (id: number) => {
      assert.equal(id, 8);
      calls.push('cleanup');
      if (options.cleanupThrows) throw new Error('synthetic disk failure');
      return { pending: options.cleanupPending ?? false };
    } },
    '@/shared/lib/clientRealtime': { publishClientRealtimeEvent: () => {
      calls.push('notify');
      if (options.realtimeThrows) throw new Error('synthetic notification failure');
    } },
  });
  return { calls, run: () => handlers.DELETE(new Request('https://example.test', { method: 'DELETE' }), { params: Promise.resolve({ id: '13', documentId: '2' }) }) };
}

test('failed DB deletion never schedules physical cleanup or notifies', async () => {
  const h = deleteHandler({ deleteError: true });
  assert.equal((await h.run()).status, 400);
  assert.deepEqual(h.calls, ['delete']);
});

test('uncertain deletion commit cannot report rollback or trigger file deletion', async () => {
  const h = deleteHandler({ uncertainCommit: true });
  const response = await h.run();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).saved, null);
  assert.deepEqual(h.calls, ['delete']);
});

test('confirmed deletion stays successful with an explicit warning when file cleanup is deferred', async () => {
  for (const flags of [{ cleanupThrows: true }, { cleanupPending: true }]) {
    const h = deleteHandler(flags);
    const response = await h.run();
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.cleanupPending, true);
    assert.match(result.warning, /Очистка файла/);
    assert.deepEqual(h.calls, ['delete', 'cleanup', 'notify']);
  }
});

test('notification failure does not change a successfully deleted document into an error', async () => {
  const h = deleteHandler({ realtimeThrows: true });
  const response = await h.run();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, cleanupPending: false });
});

test('cleanup CLI refuses sweeping or retrying without an exact id and confirmation before connecting', () => {
  for (const args of [['--all'], ['--retry-id', '8'], ['--retry-id', '../8', '--confirm-file-removal']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/client-document-cleanup.ts', ...args], {
      env: { ...process.env, DATABASE_URL: 'postgres://invalid@127.0.0.1:1/never_connect' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Повтор одного задания/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
  }
});

test('cleanup CLI requires an explicit absolute upload root before executing a confirmed job', () => {
  for (const uploadRoot of ['', 'relative/uploads']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/client-document-cleanup.ts', '--retry-id', '8', '--confirm-file-removal'], {
      env: { ...process.env, DATABASE_URL: 'postgres://invalid@127.0.0.1:1/never_connect', UPLOAD_DIR: uploadRoot }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UPLOAD_DIR явно/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
  }
});

test('deploy ships the standalone cleanup tool without invoking it', () => {
  const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(workflow, /entryPoints:\["scripts\/client-document-cleanup\.ts"\]/);
  assert.match(workflow, /outfile:"deploy-artifact\/scripts\/client-document-cleanup\.cjs"/);
  assert.doesNotMatch(workflow, /--confirm-file-removal/);
});
