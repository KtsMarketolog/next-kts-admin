import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { buildCustomRoute } from 'next/dist/server/lib/router-utils/filesystem';
import { config, proxy } from '../src/proxy';
import nextConfig from '../next.config';

(globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage ??= AsyncLocalStorage;
const { unstable_doesMiddlewareMatch: matches } = createRequire(import.meta.url)('next/experimental/testing/server') as {
  unstable_doesMiddlewareMatch: (input: { config: typeof config; nextConfig: typeof nextConfig; url: string; headers?: Record<string, string> }) => boolean;
};
const uploadPaths = ['/api/admin/uploads', '/api/admin/catalog/import', '/api/admin/clients/17/documents'];

test('bounded multipart routes bypass Next body cloning but retain Server Action denial', () => {
  for (const pathname of uploadPaths) {
    for (const trailing of ['', '/']) {
      const url = `https://example.test${pathname}${trailing}`;
      assert.equal(matches({ config, nextConfig, url }), false, pathname);
      assert.equal(matches({ config, nextConfig, url, headers: { 'next-action': 'synthetic' } }), true);
      assert.equal(proxy(new NextRequest(url, { method: 'POST', headers: { 'next-action': 'synthetic' } })).status, 404);
    }
  }
  for (const pathname of ['/api/admin/clients', '/api/admin/catalog', '/api/admin/clients/17/documents/3', '/api/admin/uploads/extra', '/uploads/client-documents/17/a.pdf']) {
    assert.equal(matches({ config, nextConfig, url: `https://example.test${pathname}` }), true, pathname);
  }
});

test('bypassed upload routes retain private cache and common security headers in Next configuration', async () => {
  const rules = await nextConfig.headers!();
  for (const pathname of uploadPaths) {
    const headers = new Map<string, string>();
    for (const rule of rules) {
      if (buildCustomRoute('header', rule).match(pathname) === false) continue;
      for (const { key, value } of rule.headers) headers.set(key.toLowerCase(), value);
    }
    assert.equal(headers.get('cache-control'), 'private, no-store');
    assert.equal(headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.ok(headers.get('content-security-policy'));
  }
});
