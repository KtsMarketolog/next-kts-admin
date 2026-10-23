import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function harness(options: { failAcquire?: boolean; failRelease?: boolean } = {}) {
  const databaseSlots = new Set<string>();
  const disconnectors = new Map<string, () => void>();
  let acquisitions = 0;
  let releases = 0;
  function processInstance() {
    const compiled = ts.transpileModule(readFileSync(new URL('../src/shared/lib/resourceUploadConcurrency.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const loaded = { exports: {} as typeof import('../src/shared/lib/resourceUploadConcurrency') };
    new Function('require', 'module', 'exports', 'globalThis', compiled)((name: string) => {
      assert.equal(name, './db/client');
      return { async tryAcquireSessionAdvisoryLock(key: string, policy?: { onDisconnect?: () => void }) {
        acquisitions += 1;
        if (options.failAcquire) throw new Error('Synthetic unavailable database');
        if (databaseSlots.has(key)) return null;
        databaseSlots.add(key);
        if (policy?.onDisconnect) disconnectors.set(key, policy.onDisconnect);
        return async () => {
          releases += 1;
          databaseSlots.delete(key); // db/client discards a connection on uncertain unlock.
          disconnectors.delete(key);
          if (options.failRelease) throw new Error('Synthetic unlock failure');
        };
      } };
    }, loaded, loaded.exports, {});
    return loaded.exports.acquireResourceUploadSlot;
  }
  return { processInstance, options, databaseSlots, disconnect() {
    for (const disconnect of disconnectors.values()) disconnect();
    databaseSlots.clear();
  }, counts: () => ({ acquisitions, releases }) };
}

test('catalog and stock share one heavy slot across process instances', async () => {
  const h = harness(); const first = h.processInstance(); const second = h.processInstance();
  const release = await first('catalog'); assert.ok(release);
  assert.equal(await first('stock'), null);
  assert.equal(await second('stock'), null);
  await release(); await release();
  const next = await second('stock'); assert.ok(next); await next();
  assert.equal(h.counts().releases, 2);
  assert.equal(h.databaseSlots.size, 0);
});

test('image and document share two slots independently of heavy Excel', async () => {
  const h = harness(); const first = h.processInstance(); const second = h.processInstance();
  const image = await first('image'); const document = await second('document'); const excel = await second('catalog');
  assert.ok(image); assert.ok(document); assert.ok(excel);
  assert.equal(await first('document'), null);
  assert.equal(await second('image'), null);
  await Promise.all([image(), document(), excel()]);
  assert.equal(h.databaseSlots.size, 0);
});

test('concurrent attempts within a process cannot re-enter a session lock', async () => {
  const h = harness(); const acquire = h.processInstance();
  const results = await Promise.all(Array.from({ length: 20 }, () => acquire('catalog')));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(h.counts().acquisitions, 1);
  await results.find(Boolean)!();
});

test('acquisition and release errors do not permanently occupy local slots', async () => {
  const h = harness({ failAcquire: true }); const acquire = h.processInstance();
  await assert.rejects(acquire('catalog'), /unavailable/);
  h.options.failAcquire = false;
  h.options.failRelease = true;
  const release = await acquire('catalog'); assert.ok(release);
  await assert.rejects(release(), /unlock/); await release();
  h.options.failRelease = false;
  const next = await acquire('catalog'); assert.ok(next); await next();
  assert.equal(h.databaseSlots.size, 0);
  assert.equal(h.counts().releases, 2);
});

test('loss of the admission connection aborts its work before callers free the local slot', async () => {
  const h = harness(); const acquire = h.processInstance();
  const release = await acquire('catalog'); assert.ok(release);
  assert.equal(release.signal.aborted, false);
  h.disconnect();
  assert.equal(release.signal.aborted, true);
  assert.equal(await acquire('catalog'), null, 'local slot held until the old worker terminates');
  await release();
  const next = await acquire('stock'); assert.ok(next); await next();
});
