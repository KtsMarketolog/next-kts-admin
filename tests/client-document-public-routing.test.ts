import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { config, proxy } from '../src/proxy';
import nextConfig from '../next.config';
import { isClientDocumentStoragePath, isPrivateClientDocumentImageSource } from '../src/shared/lib/clientDocumentPaths';

const runtimeGlobal = globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage };
runtimeGlobal.AsyncLocalStorage ??= AsyncLocalStorage;
const { unstable_doesMiddlewareMatch: matches } = createRequire(import.meta.url)('next/experimental/testing/server') as {
  unstable_doesMiddlewareMatch: (input: { config: typeof config; nextConfig: typeof nextConfig; url: string; headers?: Record<string, string> }) => boolean;
};
const privatePaths = [
  '/uploads/client-documents', '/uploads/client-documents/', '/uploads/client-documents/13/example.pdf',
  '/uploads/client-documents/13/example.jpg', '/uploads/client-documents/13/%FF%ZZ',
  '/uploads//client-documents/13/example.png', '//uploads/client-documents/13/example.png',
  '/uploads/CLIENT-DOCUMENTS/13/example.png', '/uploads/%63lient-documents/13/example.png',
  '/uploads%2fclient-documents%2f13%2fexample.png', '/uploads%5cclient-documents%5c13%5cexample.png',
  '/uploads%252fclient-documents%252f13%252fexample.png',
  '/uploads/a/../client-documents/13/example.png', '/uploads/a/%252e%252e/client-documents/13/example.png',
  '/other/%252e%252e/uploads/client-documents/13/example.png',
];

const absolutePrivateSource = 'https://api.kts-impex.ru/uploads/client-documents/13/example.png';
const canonicalizedSources = [
  ...Array.from({ length: 33 }, (_, code) => `${String.fromCharCode(code)}${absolutePrivateSource}${String.fromCharCode(code)}`),
  ...['\t', '\r', '\n'].map((control) => absolutePrivateSource.replace('https:', `ht${control}tps:`)),
];

test('private image source matching follows WHATWG whitespace and scheme canonicalization', () => {
  for (const source of canonicalizedSources) {
    assert.equal(new URL(source).href, absolutePrivateSource);
    assert.equal(isPrivateClientDocumentImageSource(source), true);
  }
});

test('all raw document paths deny GET, HEAD, ranges and mutations before public static lookup', async () => {
  for (const pathname of privatePaths) {
    assert.equal(isClientDocumentStoragePath(pathname), true, pathname);
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
      assert.equal(matches({ config, nextConfig, url: `https://example.test${pathname}` }), true, pathname);
      const response = proxy(new NextRequest(`https://example.test${pathname}`, { method,
        headers: { Range: 'bytes=0-10', Cookie: 'synthetic=1', 'x-kts-top-data-upload': '1' } }));
      assert.equal(response.status, 403, `${method} ${pathname}`);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-middleware-next'), null);
      assert.equal(await response.text(), '');
    }
  }
});

test('image optimizer rejects private local, remote and authenticated sources before consulting its cache', () => {
  for (const source of [...privatePaths, ...canonicalizedSources, ...privatePaths.map((value) => `https://api.kts-impex.ru${value}`),
    '/api/client/documents/2/download', '/api/admin/clients/13/documents/2/download',
    '/api/admin/clients/13/%64ocuments/2/download', 'https://api.kts-impex.ru/api/client/documents/2/download']) {
    for (const optimizer of ['/_next/image', '/_next/image/']) {
      const url = `https://example.test${optimizer}?url=${encodeURIComponent(source)}&w=64&q=75`;
      assert.equal(matches({ config, nextConfig, url, headers: { 'x-kts-top-data-upload': '1' } }), true);
      const response = proxy(new NextRequest(url, { headers: { Cookie: 'synthetic=1' } }));
      assert.equal(response.status, 403, source);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
  }
  const repeated = new NextRequest('https://example.test/_next/image?url=/logo.png&url=/uploads/client-documents/1/a.png&w=64&q=75');
  assert.equal(proxy(repeated).status, 403);
});

test('legitimate protected download APIs and public catalogue images are not blocked by the path guard', () => {
  for (const pathname of ['/api/client/documents/2/download', '/api/admin/clients/13/documents/2/download',
    '/uploads/hero/banner.jpg', '/uploads/catalog/photo.png', '/uploads/client-documents-public/photo.png',
    '/_next/image?url=%2Fuploads%2Fhero%2Fbanner.jpg&w=64&q=75',
    '/_next/image?url=https%3A%2F%2Fapi.kts-impex.ru%2Fuploads%2Fcatalog%2Fphoto.png&w=64&q=75']) {
    assert.equal(proxy(new NextRequest(`https://example.test${pathname}`)).headers.get('x-middleware-next'), '1', pathname);
  }
});
