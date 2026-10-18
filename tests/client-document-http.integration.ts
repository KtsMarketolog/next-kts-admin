/** Run after build: node --import tsx --test tests/client-document-http.integration.ts */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { ImageOptimizerCache } from 'next/dist/server/image-optimizer';
import type { CachedImageValue } from 'next/dist/server/response-cache';

test('standalone HTTP blocks client-document static URLs and cached image derivatives before file delivery', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kts-client-document-http-'));
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  try {
    // Only build artifacts are copied. No environment, credentials, real uploads
    // or user content enter this isolated server, and no production URL is used.
    await cp(path.resolve('.next/standalone'), root, {
      recursive: true,
      filter: (entry) => !path.basename(entry).startsWith('.env') && path.basename(entry) !== 'public',
    });
    const uploads = path.join(root, 'public/uploads');
    const privateDirectory = path.join(uploads, 'client-documents/13');
    await mkdir(privateDirectory, { recursive: true });
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).png().toBuffer();
    const derivative = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#f0a511' } }).png().toBuffer();
    const privateText = Buffer.from('synthetic-private-document-do-not-serve');
    await writeFile(path.join(privateDirectory, 'document.png'), png);
    await writeFile(path.join(privateDirectory, 'document.txt'), privateText);
    await writeFile(path.join(uploads, 'public-control.png'), png);
    await writeFile(path.join(uploads, 'public-cached-control.png'), png);
    await writeFile(path.join(uploads, 'public-control.txt'), 'synthetic-public-control');

    const portProbe = createServer();
    await new Promise<void>((resolve, reject) => {
      portProbe.once('error', reject);
      portProbe.listen(0, '127.0.0.1', resolve);
    });
    const address = portProbe.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
    const base = `http://127.0.0.1:${port}`;
    const privatePath = '/uploads/client-documents/13/document.png';
    const cachedAbsolutePrivate = `https://api.kts-impex.ru${privatePath}`;
    const canonicalizedSources = [
      ...Array.from({ length: 33 }, (_, code) => `${String.fromCharCode(code)}${cachedAbsolutePrivate}${String.fromCharCode(code)}`),
      ...['\t', '\r', '\n'].map((control) => cachedAbsolutePrivate.replace('https:', `ht${control}tps:`)),
    ];

    // Use Next's installed cache writer/reader rather than guessing its internal
    // filename encoding. A public HIT below proves these synthetic cache entries
    // are usable, so private 403 responses cannot be explained by a cache miss.
    const requiredFiles = JSON.parse(await readFile(path.join(root, '.next/required-server-files.json'), 'utf8'));
    const imageCache = new ImageOptimizerCache({ distDir: path.join(root, '.next'), nextConfig: requiredFiles.config });
    const cacheKey = (href: string) => ImageOptimizerCache.getCacheKey({ href, width: 64, quality: 75, mimeType: '' });
    const cachedPaths = [privatePath, cachedAbsolutePrivate, '/api/client/documents/2/download', '/uploads/public-cached-control.png'];
    for (const href of cachedPaths) {
      await imageCache.set(cacheKey(href), {
        kind: 'IMAGE' as CachedImageValue['kind'], buffer: derivative, extension: 'png', etag: 'synthetic-derivative', upstreamEtag: 'synthetic-source',
      }, { cacheControl: { revalidate: 3600, expire: undefined } });
      assert.deepEqual((await imageCache.get(cacheKey(href)))?.value?.kind, 'IMAGE');
    }

    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port),
        DATABASE_URL: '', APP_RELEASE_ID: '', NEXT_TELEMETRY_DISABLED: '1' },
    });
    child.stdout!.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    child.stderr!.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) assert.fail(`Synthetic server exited: ${output}`);
      try {
        const response = await fetch(`${base}/uploads/public-control.txt`);
        if (response.ok) {
          assert.equal(await response.text(), 'synthetic-public-control');
          started = true;
          break;
        }
        await response.arrayBuffer();
      } catch { /* Await only this local synthetic server. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(started, `Synthetic server did not become ready: ${output}`);

    const cookies = 'kts_admin_session=synthetic-admin-cookie; kts_client_session=synthetic-client-cookie';
    async function expectBlocked(url: string, options: RequestInit = {}) {
      const response = await fetch(url, options);
      assert.equal(response.status, 403, `${options.method ?? 'GET'} ${url}`);
      assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/);
      assert.equal((await response.arrayBuffer()).byteLength, 0, 'The denial must not include file content or an HTML fallback');
    }
    for (const suffix of [
      '/uploads/client-documents', '/uploads/client-documents/', privatePath,
      '/uploads/client-documents/13/document.txt',
      '/%75ploads/client-documents/13/document.png', '/uploads/%63lient-documents/13/document.png',
      '/uploads/client%2ddocuments/13/document.png', '/uploads%2fclient-documents%2f13%2fdocument.png',
      '/uploads/%2563lient-documents/13/document.png', '/uploads%5cclient-documents%5c13%5cdocument.png',
    ]) {
      await expectBlocked(`${base}${suffix}`);
    }
    const requestModes: RequestInit[] = [
      { method: 'HEAD' }, { headers: { Range: 'bytes=0-7' } }, { headers: { Cookie: cookies } },
      { method: 'HEAD', headers: { Range: 'bytes=0-7', Cookie: cookies } },
    ];
    for (const options of requestModes) await expectBlocked(`${base}${privatePath}`, options);

    const imageUrl = (url: string) => `${base}/_next/image?${new URLSearchParams({ url, w: '64', q: '75' })}`;
    for (const source of [
      ...canonicalizedSources, privatePath, `${base}${privatePath}`, 'https://api.example.invalid/uploads/client-documents/13/document.png',
      '/uploads/%63lient-documents/13/document.png', '/%75ploads/client-documents/13/document.png',
      '/api/client/documents/2/download', '/api/admin/clients/13/documents/2/download',
      `${base}/api/client/documents/2/download`, 'https://api.example.invalid/api/admin/clients/13/documents/2/download',
    ]) {
      // Synthetic cookies cannot turn a private asset into a public cached image.
      await expectBlocked(imageUrl(source), { headers: { Accept: 'image/png', Cookie: cookies } });
    }
    await expectBlocked(imageUrl(privatePath), { method: 'HEAD', headers: { Accept: 'image/png' } });
    await expectBlocked(imageUrl(privatePath), { headers: { Accept: 'image/png', Range: 'bytes=0-7' } });
    for (const pair of [[privatePath, '/uploads/public-control.png'], ['/uploads/public-control.png', privatePath]]) {
      const query = new URLSearchParams({ w: '64', q: '75' });
      pair.forEach((url) => query.append('url', url));
      await expectBlocked(`${base}/_next/image?${query}`, { headers: { Accept: 'image/png' } });
    }

    const publicFile = await fetch(`${base}/uploads/public-control.png`);
    assert.equal(publicFile.status, 200);
    assert.deepEqual(Buffer.from(await publicFile.arrayBuffer()), png);
    const publicImage = await fetch(imageUrl('/uploads/public-control.png'), { headers: { Accept: 'image/png' } });
    assert.equal(publicImage.status, 200);
    assert.match(publicImage.headers.get('content-type') ?? '', /^image\//);
    assert.ok((await publicImage.arrayBuffer()).byteLength > 0, 'Public product/news images still optimize');
    const publicCached = await fetch(imageUrl('/uploads/public-cached-control.png'), { headers: { Accept: 'image/png' } });
    assert.equal(publicCached.status, 200);
    assert.equal(publicCached.headers.get('x-nextjs-cache'), 'HIT');
    assert.deepEqual(Buffer.from(await publicCached.arrayBuffer()), derivative, 'Control confirms pre-existing derivative cache is served normally');
    assert.deepEqual(await readFile(path.join(privateDirectory, 'document.png')), png, 'Denying HTTP access never deletes original documents');
    assert.deepEqual(await readFile(path.join(privateDirectory, 'document.txt')), privateText);
    assert.doesNotMatch(output, /runtime_ready|Database is ready/);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child!.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    // Exact mktemp directory owned by this test, never existing uploads or caches.
    await rm(root, { recursive: true, force: true });
  }
});
