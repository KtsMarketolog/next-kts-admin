import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import test from 'node:test';
import { NextRequest } from 'next/server';

import nextConfig from '../next.config';
import { config, proxy } from '../src/proxy';

const root = '/klimatika/prog/firmware/update';
const downloads = [
  [`${root}/hse/gen_1/hse_gen_1.c23`, '/api/firmware/download/c23'],
  [`${root}/hse/gen_1/hse_gen_1.ver`, '/api/firmware/download/ver'],
] as const;
const runtimeGlobal = globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage };
runtimeGlobal.AsyncLocalStorage ??= AsyncLocalStorage;
const testing = createRequire(import.meta.url)('next/experimental/testing/server') as {
  unstable_doesMiddlewareMatch(input: { config: typeof config; nextConfig: typeof nextConfig; url: string; headers?: Record<string, string> }): boolean;
  unstable_getResponseFromNextConfig(input: { url: string; nextConfig: typeof nextConfig }): Promise<Response>;
};

test('firmware uses only two exact beforeFiles rewrites, overriding preserved legacy public files', async () => {
  const rewrites = await nextConfig.rewrites!();
  assert.ok(!Array.isArray(rewrites));
  assert.deepEqual(rewrites, {
    beforeFiles: [
      { source: `${root}/hse/gen_1/hse_gen_1\\.c23`, destination: '/api/firmware/download/c23' },
      { source: `${root}/hse/gen_1/hse_gen_1\\.ver`, destination: '/api/firmware/download/ver' },
    ],
    afterFiles: [], fallback: [],
  });
  for (const [pathname, destination] of downloads) {
    const response = await testing.unstable_getResponseFromNextConfig({ url: `http://kts-impex.ru${pathname}?check=1`, nextConfig });
    assert.equal(response.headers.get('x-middleware-rewrite'), `http://kts-impex.ru${destination}?check=1`);
    assert.equal(response.headers.get('location'), null, 'device-visible URL must not redirect');
  }
  for (const pathname of [
    `${root}/hse/gen_1/hse_gen_1xc23`, `${root}/hse/gen_1/hse_gen_1xver`,
    `${root}/hse/gen_1/hse_gen_1.c23.bak`, `${root}/.firmware-store/state.json`,
  ]) {
    const response = await testing.unstable_getResponseFromNextConfig({ url: `https://kts-impex.ru${pathname}`, nextConfig });
    assert.equal(response.headers.get('x-middleware-rewrite'), null, pathname);
  }
});

test('canonical firmware GET and HEAD paths pass proxy to the descriptor-backed handlers', () => {
  for (const [pathname] of downloads) {
    for (const method of ['GET', 'HEAD']) {
      const response = proxy(new NextRequest(`http://kts-impex.ru${pathname}?download=1`, { method }));
      assert.equal(response.headers.get('x-middleware-next'), '1');
      assert.equal(response.status, 200);
    }
  }
});

const escapedRoot = root.replace(/[a-z]/g, (letter) => `%${letter.charCodeAt(0).toString(16)}`);
let deeplyEscapedRoot = escapedRoot;
for (let depth = 0; depth < 8; depth += 1) deeplyEscapedRoot = deeplyEscapedRoot.replaceAll('%', '%25');
const protectedPaths = [
  root, `${root}/`, `${root}/hse/gen_1`,
  `${root}/.firmware-store/state.json`,
  `${root}/.firmware-store/releases/00000000-0000-4000-8000-000000000000/hse_gen_1.c23`,
  `${root}/.firmware-store/.incoming/draft/hse_gen_1.c23`,
  `${root}/hse/gen_1/.firmware-store/state.json`,
  `${root}/hse/gen_1/hse_gen_1.c23.bak`,
  `${root}/hse/gen_1/hse_gen_1.ver/extra`,
  `${root}/hse/gen_1/HSE_GEN_1.C23`,
  `${root}/hse/gen_1/hse_gen_1%2Ec23`,
  `${root}/%2Efirmware-store/state.json`,
  `${root}/%252efirmware-store/state.json`,
  `${root}/%2e%2e/update/.firmware-store/state.json`,
  `${root}/%252e%252e/update/.firmware-store/state.json`,
  `${root}//.firmware-store/state.json`,
  `${root}%2F.firmware-store%2Fstate.json`,
  `${root}%5C.firmware-store%5Cstate.json`,
  `${root}/.firmware-store/%FF%ZZ`,
  `${escapedRoot}/.firmware-store/state.json`,
  `${escapedRoot.replaceAll('%', '%25')}/.firmware-store/state.json`,
  `${deeplyEscapedRoot}/.firmware-store/state.json`,
  '/klimatika%2fprog%2ffirmware%2fupdate%2f.firmware-store%2fstate.json',
  '/klimatika%255cprog%255cfirmware%255cupdate%255c.firmware-store%255cstate.json',
  '/other/%252e%252e/klimatika/prog/firmware/update/.firmware-store/state.json',
];

test('firmware internal, unknown and encoded paths fail closed before public filesystem lookup', () => {
  for (const pathname of protectedPaths) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = proxy(new NextRequest(`https://kts-impex.ru${pathname}`, { method }));
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
      assert.equal(response.headers.get('x-middleware-next'), null);
      assert.equal(response.headers.get('x-middleware-rewrite'), null);
    }
  }
});

test('the actual Next proxy matcher covers encoded firmware paths and cannot be bypassed with upload headers', () => {
  const headerVariants: Array<Record<string, string> | undefined> = [
    undefined, { 'x-kts-top-data-upload': '1' }, { purpose: 'prefetch' },
  ];
  for (const pathname of [...downloads.map(([url]) => url), ...protectedPaths]) {
    for (const headers of headerVariants) {
      assert.equal(testing.unstable_doesMiddlewareMatch({ config, nextConfig, url: pathname, headers }), true, pathname);
    }
  }
});

test('firmware guard leaves other public routes and admin origin checks unchanged', () => {
  for (const pathname of ['/catalog', '/catalog/100%25', '/contacts', '/klimatika/prog/firmware/update-not-firmware']) {
    assert.equal(proxy(new NextRequest(`https://kts-impex.ru${pathname}`)).headers.get('x-middleware-next'), '1', pathname);
  }
  const denied = proxy(new NextRequest('https://kts-impex.ru/api/admin/firmware', {
    method: 'POST', headers: { origin: 'https://untrusted.example' },
  }));
  assert.equal(denied.status, 403);
  const action = proxy(new NextRequest(`https://kts-impex.ru${downloads[0][0]}`, { headers: { 'next-action': 'forged' } }));
  assert.equal(action.status, 404);
});
