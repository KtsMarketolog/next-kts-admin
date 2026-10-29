import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import * as shared from '../src/shared/lib/knowledgeBase';
import * as origin from '../src/shared/lib/originProtection';
import * as uploadGuard from '../src/shared/lib/uploadRequestGuard';
import * as transactionOutcome from '../src/shared/lib/db/transactionOutcome';
import { removeDeletedKnowledgeBaseFile, saveKnowledgeBaseUpload } from '../src/shared/lib/knowledgeBaseStorage';
import type { AdminSession, AdminSessionRole } from '../src/shared/lib/adminAuth';

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
const operationId = '1da2a1b7-5c74-4a9c-a86d-9153a32019ae';
const commit = { action: 'commit', expectedRevision: '2', previewToken: 'f'.repeat(64), confirmationTitle: 'Archive', operationId };
function harness(role: AdminSessionRole | null = 'admin', failure?: 'unknown' | 'private') {
  const session: AdminSession | null = role ? { role, sessionId: operationId, ...(role.includes('manager') ? { managerId: 1 } : { adminUserId: 1 }) } : null;
  const calls: unknown[][] = [];
  const api = load<typeof import('../src/shared/lib/knowledgeBaseApi')>('../src/shared/lib/knowledgeBaseApi.ts', {
    './adminAuth': { getAdminSession: async () => session }, './adminSecurity': { enforceAdminActionRateLimit: async () => null },
    './originProtection': origin, './uploadRequestGuard': uploadGuard, './knowledgeBase': shared, './db/transactionOutcome': transactionOutcome,
  });
  const repo = Object.fromEntries(['previewKnowledgeBaseDeletion', 'deleteKnowledgeBaseNode'].map(name => [name, async (...args: unknown[]) => {
    calls.push([name, ...args]); assert.equal(args[0], session);
    if (failure === 'unknown') throw new transactionOutcome.TransactionCommitUnknownError();
    if (failure === 'private') throw new Error('private storage path and credential');
    return { deleted: true, nodeId: 10, cleanupPending: true };
  }]));
  const route = load<typeof import('../src/app/api/admin/knowledge-base/[id]/delete/route')>('../src/app/api/admin/knowledge-base/[id]/delete/route.ts', {
    '@/shared/lib/knowledgeBaseApi': api, '@/shared/lib/db/knowledgeBaseRepo': repo, '@/shared/lib/knowledgeBase': shared,
  });
  const run = (body: unknown = commit, extraHeaders: HeadersInit = {}) => route.POST(new Request('https://example.test/api/admin/knowledge-base/10/delete', {
    method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: '10' }) });
  return { run, calls };
}

test('KB deletion endpoint authenticates all three management roles and denies every other role before repository', async () => {
  for (const role of ['admin', 'admintop', 'top', 'wholesale_admin', 'manager', 'support_manager', 'purchaser', null] as const) {
    const h = harness(role), permitted = role && ['admin', 'admintop', 'top'].includes(role);
    for (const body of [commit, { action: 'preview', expectedRevision: '2' }]) {
      const response = await h.run(body);
      assert.equal(response.status, permitted ? 200 : role ? 403 : 401);
      assert.match(response.headers.get('cache-control')!, /private.*no-store/); assert.equal(response.headers.get('vary'), 'Cookie');
    }
    assert.equal(h.calls.length, permitted ? 2 : 0);
  }
});

test('KB deletion protects origin and bounded JSON, rejects ambiguous payloads, never returns private errors', async () => {
  for (const body of [{}, { ...commit, action: 'delete' }, { ...commit, all: true }, { ...commit, operationId: 'invalid' },
    { ...commit, expectedRevision: 2 }, { action: 'preview', expectedRevision: '2', confirmationTitle: 'Archive' },
    { ...commit, confirmationTitle: null }, { ...commit, previewToken: null }]) {
    const h = harness(); assert.equal((await h.run(body)).status, 400); assert.equal(h.calls.length, 0);
  }
  const foreign = harness(); assert.equal((await foreign.run(commit, { origin: 'https://foreign.test' })).status, 403); assert.equal(foreign.calls.length, 0);
  const large = harness(); assert.equal((await large.run({ ...commit, confirmationTitle: 'a'.repeat(70_000) })).status, 413); assert.equal(large.calls.length, 0);
  const unknown = await harness('admin', 'unknown').run(); assert.equal(unknown.status, 503); assert.equal((await unknown.json()).code, 'COMMIT_OUTCOME_UNKNOWN');
  const privateError = await harness('admin', 'private').run(); assert.equal(privateError.status, 503); assert.doesNotMatch(await privateError.text(), /storage|credential/);
  const confirmed = await harness().run(); assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).cleanupPending, true);
});

test('KB physical deletion validates immutable private bytes, rejects symlinks/traversal, retries missing exact file safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kts-kb-delete-unit-'));
  const previous = process.env.UPLOAD_DIR; process.env.UPLOAD_DIR = root;
  try {
    const create = (body: string) => saveKnowledgeBaseUpload(new Request('https://example.test/upload', { method: 'POST', body }), 'document.txt');
    const stored = await create('first'), untouched = await create('keep');
    await rename(join(root, 'knowledge-base'), join(root, 'temporarily-unavailable'));
    await assert.rejects(removeDeletedKnowledgeBaseFile(stored.storagePath, stored.size, stored.sha256), { code: 'ENOENT' });
    await rename(join(root, 'temporarily-unavailable'), join(root, 'knowledge-base'));
    await assert.rejects(removeDeletedKnowledgeBaseFile(stored.storagePath, stored.size, '0'.repeat(64)));
    assert.equal(await readFile(join(root, stored.storagePath), 'utf8'), 'first');
    await assert.rejects(removeDeletedKnowledgeBaseFile('../document.txt', stored.size, stored.sha256));
    await removeDeletedKnowledgeBaseFile(stored.storagePath, stored.size, stored.sha256);
    await removeDeletedKnowledgeBaseFile(stored.storagePath, stored.size, stored.sha256);
    assert.equal(await readFile(join(root, untouched.storagePath), 'utf8'), 'keep');
    const linked = await create('target');
    const external = join(root, 'external.txt'); await writeFile(external, 'target');
    await rm(join(root, linked.storagePath)); await symlink(external, join(root, linked.storagePath));
    await assert.rejects(removeDeletedKnowledgeBaseFile(linked.storagePath, linked.size, linked.sha256));
    assert.equal(await readFile(external, 'utf8'), 'target');
  } finally {
    if (previous === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = previous;
    assert.match(root, /kts-kb-delete-unit-/); await rm(root, { recursive: true, force: true });
  }
});
