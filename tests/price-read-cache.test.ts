import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

type CacheModule = typeof import('../src/shared/lib/priceReadCache');

function harness() {
  let now = 1000;
  const output = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../src/shared/lib/priceReadCache.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module: output, exports: output.exports, Buffer, Date: { now: () => now },
    require: (name: string) => assert.fail(`Unexpected dependency ${name}: read-cache cannot access database or files`),
  });
  return { ...(output.exports as CacheModule), advance: (ms: number) => { now += ms; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('derived price reads reuse the matching version only and report hits/misses', async () => {
  const h = harness();
  const cache = h.createPriceReadCache<{ title: string }>({ maxEntries: 3, maxBytes: 1000, ttlMs: 100 });
  const states: string[] = [];
  const original = { title: 'Price unchanged' };
  let loads = 0;
  const load = async () => { loads++; return original; };
  assert.equal(await cache.read('price:7:v1', load, (state) => states.push(state)), original);
  assert.equal(await cache.read('price:7:v1', load, (state) => states.push(state)), original);
  assert.equal(loads, 1);
  await cache.read('price:7:v2', load, (state) => states.push(state));
  await cache.read('price:8:v2', load, (state) => states.push(state));
  assert.equal(loads, 3, 'a changed version or another price must not reuse stale results');
  assert.deepEqual(states, ['miss', 'hit', 'miss', 'miss']);
});

test('simultaneous reads coalesce into one load and unrelated versions progress independently', async () => {
  const h = harness();
  const cache = h.createPriceReadCache<string>({ maxEntries: 3, maxBytes: 1000, ttlMs: 100 });
  const pending = deferred<string>();
  const states: string[] = [];
  let loads = 0;
  const read = () => cache.read('same-version', async () => { loads++; return pending.promise; }, (state) => states.push(state));
  const reads = Array.from({ length: 100 }, read);
  assert.equal(await cache.read('other-version', async () => 'other'), 'other');
  assert.equal(loads, 1);
  pending.resolve('original result');
  assert.deepEqual(await Promise.all(reads), Array.from({ length: 100 }, () => 'original result'));
  assert.equal(states.filter((state) => state === 'miss').length, 1);
  assert.equal(states.filter((state) => state === 'coalesced').length, 99);
  assert.equal(await read(), 'original result');
  assert.equal(loads, 1);
  assert.equal(states.at(-1), 'hit');
});

test('failed loads are not cached, pending failures reach all callers, and subsequent reads retry', async () => {
  const h = harness();
  const cache = h.createPriceReadCache<string>({ maxEntries: 3, maxBytes: 1000, ttlMs: 100 });
  const pending = deferred<string>();
  let loads = 0;
  const first = cache.read('version', async () => { loads++; return pending.promise; });
  const second = cache.read('version', async () => { loads++; return 'must not run'; });
  const error = new Error('Synthetic read failure');
  pending.reject(error);
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason === error).length, 2);
  assert.equal(loads, 1);
  assert.equal(await cache.read('version', async () => { loads++; return 'recovered'; }), 'recovered');
  assert.equal(loads, 2);
  await assert.rejects(cache.read('sync-failure', () => { throw error; }), { message: 'Synthetic read failure' });
  assert.equal(await cache.read('sync-failure', async () => 'recovered again'), 'recovered again');
});

test('missing records are never negative-cached and a later restored price can load', async () => {
  const h = harness();
  const cache = h.createPriceReadCache<string | null | undefined>({ maxEntries: 3, maxBytes: 1000, ttlMs: 100 });
  let loads = 0;
  assert.equal(await cache.read('price', async () => { loads++; return null; }), null);
  assert.equal(await cache.read('price', async () => { loads++; return undefined; }), undefined);
  assert.equal(await cache.read('price', async () => { loads++; return 'restored'; }), 'restored');
  assert.equal(loads, 3);
  assert.equal(await cache.read('price', async () => assert.fail('restored value should be cached')), 'restored');
});

test('TTL expires at its exact boundary and does not slide on read', async () => {
  const h = harness();
  const cache = h.createPriceReadCache<string>({ maxEntries: 3, maxBytes: 1000, ttlMs: 100 });
  assert.equal(await cache.read('price', async () => 'old'), 'old');
  h.advance(99);
  assert.equal(await cache.read('price', async () => assert.fail('still fresh')), 'old');
  h.advance(1);
  assert.equal(await cache.read('price', async () => 'fresh'), 'fresh');
  h.advance(100);
  await assert.rejects(cache.read('price', async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await cache.read('price', async () => 'latest'), 'latest', 'expired content must not suppress retries');
});

test('entry limit evicts least recently read result without modifying any source objects', async () => {
  const h = harness();
  const cache = h.createPriceReadCache<Readonly<{ id: number }>>({ maxEntries: 2, maxBytes: 1000, ttlMs: 100 });
  const a = Object.freeze({ id: 1 });
  const b = Object.freeze({ id: 2 });
  const c = Object.freeze({ id: 3 });
  await cache.read('a', async () => a);
  await cache.read('b', async () => b);
  await cache.read('a', async () => assert.fail('a should be cached'));
  await cache.read('c', async () => c);
  assert.equal(await cache.read('a', async () => assert.fail('recently read a should survive')), a);
  let bReloads = 0;
  assert.equal(await cache.read('b', async () => { bReloads++; return b; }), b);
  assert.equal(bReloads, 1);
  assert.deepEqual([a, b, c], [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('byte budget counts UTF-8 JSON bytes and applies LRU eviction independently of entry limit', async () => {
  const h = harness();
  const value = 'é'.repeat(5); // 12 JSON bytes, not seven UTF-16 code units.
  assert.equal(Buffer.byteLength(JSON.stringify(value), 'utf8'), 12);
  const cache = h.createPriceReadCache<string>({ maxEntries: 10, maxBytes: 24, ttlMs: 100 });
  await cache.read('a', async () => value);
  await cache.read('b', async () => value);
  await cache.read('a', async () => assert.fail('a should be cached'));
  await cache.read('c', async () => value);
  await cache.read('a', async () => assert.fail('a must survive the byte-budget eviction'));
  let loads = 0;
  await cache.read('b', async () => { loads++; return value; });
  assert.equal(loads, 1, 'the byte budget should evict b despite a free entry slot');
});

test('oversized derived results are returned intact but not retained or used to evict smaller results', async () => {
  const h = harness();
  const cache = h.createPriceReadCache<string>({ maxEntries: 2, maxBytes: 20, ttlMs: 100 });
  await cache.read('small', async () => 'small');
  const oversized = 'original price contents'.repeat(10);
  let loads = 0;
  for (let i = 0; i < 2; i++) {
    assert.equal(await cache.read('large', async () => { loads++; return oversized; }), oversized);
  }
  assert.equal(loads, 2);
  assert.equal(await cache.read('small', async () => assert.fail('oversized bypass must not evict smaller entries')), 'small');
});

test('expired entries release their byte allowance on new writes', async () => {
  const h = harness();
  const cache = h.createPriceReadCache<string>({ maxEntries: 10, maxBytes: 12, ttlMs: 100 });
  await cache.read('old', async () => '1234');
  h.advance(100);
  await cache.read('new-a', async () => '5678');
  await cache.read('new-b', async () => 'abcd');
  assert.equal(await cache.read('new-a', async () => assert.fail('expired bytes must be released')), '5678');
  assert.equal(await cache.read('new-b', async () => assert.fail('both live entries fit')), 'abcd');
});
