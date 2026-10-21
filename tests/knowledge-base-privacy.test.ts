import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { config, proxy } from '../src/proxy';
import nextConfig from '../next.config';
import { protectClientDocumentRoots } from '../ops/client-documents/protect-storage.mjs';
import { KNOWLEDGE_BASE_PROBE_PATHS, verifyKnowledgeBasePrivacy } from '../scripts/verify-knowledge-base-privacy.mjs';
import { isKnowledgeBaseStoragePath, isPrivateKnowledgeBaseImageSource } from '../src/shared/lib/knowledgeBasePaths';

const runtimeGlobal = globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage };
runtimeGlobal.AsyncLocalStorage ??= AsyncLocalStorage;
const { unstable_doesMiddlewareMatch: matches } = createRequire(import.meta.url)('next/experimental/testing/server') as {
  unstable_doesMiddlewareMatch: (input: { config: typeof config; nextConfig: typeof nextConfig; url: string; headers?: Record<string, string> }) => boolean;
};
const protectedPaths = ['/uploads/knowledge-base', '/uploads/knowledge-base/', '/uploads/knowledge-base/a.png', '/uploads/KNOWLEDGE-BASE/a.png',
  '/uploads%2fknowledge-base%2fa.png', '/uploads%5cknowledge-base%5ca.png', '/uploads/knowledge%2dbase/a.png',
  '/uploads/knowledge-base/%FF%ZZ', '/uploads/a/../knowledge-base/a.png', '/uploads/a/%252e%252e/knowledge-base/a.png',
  '//uploads//knowledge-base/a.png', '/uploads%252fknowledge-base%252fa.png'];

test('KB public raw/encoded paths are forbidden for all methods before lookup; adjacent public paths stay public', () => {
  for (const pathname of protectedPaths) {
    assert.equal(isKnowledgeBaseStoragePath(pathname), true, pathname);
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
      const response = proxy(new NextRequest(`https://example.test${pathname}`, { method }));
      assert.equal(response.status, 403, `${method} ${pathname}`); assert.match(response.headers.get('cache-control')!, /no-store/);
      assert.equal(matches({ config, nextConfig, url: `https://example.test${pathname}` }), true);
    }
  }
  for (const path of ['/uploads/knowledge-base-public/a.jpg', '/uploads/catalog/a.jpg', '/api/admin/knowledge-base/files/3?mode=preview']) {
    assert.equal(proxy(new NextRequest(`https://example.test${path}`)).headers.get('x-middleware-next'), '1');
  }
});

test('KB optimizer sources are forbidden even with cookies, absolute aliases, whitespace, repeated parameters or auth URLs', () => {
  const absolute = 'https://example.test/uploads/knowledge-base/a.png';
  const sources = [...protectedPaths, '/api/admin/knowledge-base/files/1?mode=preview', '\n' + absolute + ' ', absolute.replace('https:', 'ht\ttps:')];
  for (const source of sources) {
    assert.equal(isPrivateKnowledgeBaseImageSource(source), true);
    const request = new NextRequest(`https://example.test/_next/image?url=/logo.png&url=${encodeURIComponent(source)}&w=64&q=75`, { headers: { Cookie: 'synthetic=1' } });
    assert.equal(proxy(request).status, 403, source);
  }
});

test('KB raw upload bypasses body-cloning proxy, but malicious server-action headers still reach the denial', () => {
  const url = 'https://example.test/api/admin/knowledge-base/upload';
  assert.equal(matches({ config, nextConfig, url }), false);
  assert.equal(matches({ config, nextConfig, url, headers: { 'next-action': 'synthetic' } }), true);
  assert.equal(proxy(new NextRequest(url, { headers: { 'next-action': 'synthetic' } })).status, 404);
});

test('deployment isolation protects both existing private trees without changing public parent or deleting files', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-kb-gate-test-')));
  t.after(async () => { assert.ok(path.basename(root).startsWith('kts-kb-gate-test-')); await rm(root, { recursive: true, force: true }); });
  await chmod(root, 0o775);
  for (const child of ['client-documents', 'knowledge-base']) {
    await mkdir(path.join(root, child), { mode: 0o755 }); await writeFile(path.join(root, child, 'existing.txt'), 'unchanged');
  }
  await writeFile(path.join(root, 'public.jpg'), 'public');
  const before = (await stat(root)).mode;
  const options = { uploadRoots: [root], workerUids: [process.getuid!() === 33 ? 34 : 33], privateSubdirectories: ['client-documents', 'knowledge-base'] };
  assert.equal((await protectClientDocumentRoots(options)).privateRoots, 2);
  for (const child of options.privateSubdirectories) {
    assert.equal((await stat(path.join(root, child))).mode & 0o7777, 0o700);
    assert.equal(await readFile(path.join(root, child, 'existing.txt'), 'utf8'), 'unchanged');
  }
  await protectClientDocumentRoots({ ...options, checkOnly: true });
  assert.equal((await stat(root)).mode, before); assert.equal(await readFile(path.join(root, 'public.jpg'), 'utf8'), 'public');
  await assert.rejects(protectClientDocumentRoots({ ...options, privateSubdirectories: ['../outside'] }), /Unknown/);
  const unsafe = path.join(root, 'unsafe'); await mkdir(unsafe); await symlink(path.join(root, 'knowledge-base'), path.join(unsafe, 'knowledge-base'));
  await assert.rejects(protectClientDocumentRoots({ ...options, uploadRoots: [unsafe] }), /real directory/);
  assert.deepEqual(await readdir(unsafe), ['knowledge-base']);
});

test('KB public probes are mandatory, fail closed and include optimizer only after new application starts', async () => {
  const calls: string[] = [];
  const request = async (_origin: string, pathname: string, method: string) => {
    calls.push(`${method} ${pathname}`); return KNOWLEDGE_BASE_PROBE_PATHS.includes(pathname) || pathname.startsWith('/_next/image?') ? 403 : 404;
  };
  await verifyKnowledgeBasePrivacy({ origins: ['https://example.test'], request });
  assert.equal(calls.some(value => value.includes('_next/image')), false, 'old application need not implement new optimizer guard before canary');
  await verifyKnowledgeBasePrivacy({ origins: ['https://example.test'], request, optimizer: true });
  assert.ok(calls.some(value => value.includes('_next/image')));
  for (const status of [200, 401, 404, 500]) await assert.rejects(verifyKnowledgeBasePrivacy({ request: async () => status }), /expected 403/);
  const deployment = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.ok(deployment.includes('cp scripts/verify-knowledge-base-privacy.mjs'));
  assert.ok(deployment.includes('node "$RELEASE/scripts/verify-knowledge-base-privacy.mjs"\n'));
  assert.ok(deployment.includes('verify-knowledge-base-privacy.mjs" --optimizer "http://127.0.0.1:3001"'));
  assert.ok(deployment.includes('node scripts/verify-knowledge-base-privacy.mjs --optimizer'));
  const gate = await readFile(new URL('../ops/client-documents/protect-storage.mjs', import.meta.url), 'utf8');
  assert.ok(gate.includes("privateSubdirectories: ['client-documents', 'knowledge-base']"));
});
