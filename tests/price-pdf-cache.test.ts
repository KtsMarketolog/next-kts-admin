import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import type { PriceExportCacheKey } from '../src/shared/lib/priceExportCache';

function harness() {
  const files = new Map<string, Buffer>();
  const mtimes = new Map<string, number>();
  let clock = 1000;
  const messages: unknown[][] = [];
  let pauseWrite: Promise<void> | undefined;
  let failRename = false;
  const cachePath = path.join('.cache', 'price-pdf');
  const assertCachePath = (file: string) => assert.equal(path.dirname(file), cachePath);
  const modules: Record<string, unknown> = {
    crypto, path,
    'fs/promises': {
      mkdir: async (directory: string) => { assert.equal(directory, cachePath); },
      writeFile: async (file: string, data: Buffer) => {
        assertCachePath(file);
        files.set(file, data);
        mtimes.set(file, ++clock);
        if (pauseWrite) await pauseWrite;
      },
      readFile: async (file: string) => {
        assertCachePath(file);
        if (!files.has(file)) throw new Error('ENOENT');
        return files.get(file);
      },
      rename: async (from: string, to: string) => {
        assertCachePath(from); assertCachePath(to);
        if (failRename) throw new Error('synthetic rename failure with private information');
        assert.ok(files.has(from));
        files.set(to, files.get(from)!);
        mtimes.set(to, mtimes.get(from)!);
        files.delete(from);
        mtimes.delete(from);
      },
      readdir: async (directory: string) => {
        assert.equal(directory, cachePath);
        return [...files.keys()].map((file) => path.basename(file));
      },
      stat: async (file: string) => {
        assertCachePath(file);
        if (!files.has(file)) throw new Error('ENOENT');
        return { mtimeMs: mtimes.get(file)! };
      },
      unlink: async (file: string) => { assertCachePath(file); files.delete(file); mtimes.delete(file); },
    },
  };
  const exports = {};
  const code = ts.transpileModule(readFileSync('src/shared/lib/pricePdfCache.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  runInNewContext(code, {
    exports, console: { error: (...args: unknown[]) => messages.push(args) },
    require(name: string) { assert.ok(name in modules, name); return modules[name]; },
  });
  return {
    files, messages,
    ...(exports as {
      readPricePdfCache(key: PriceExportCacheKey): Promise<Buffer | null>;
      writePricePdfCache(key: PriceExportCacheKey, bytes: Buffer): Promise<void>;
    }),
    pauseWrite(value?: Promise<void>) { pauseWrite = value; },
    failRename() { failRename = true; },
  };
}

test('PDF cache: version key needs no full price, and unpublished temporary bytes cannot be read', async () => {
  const h = harness();
  const key = { priceListId: 1, revision: 'catalogue-price-manager-version' };
  let resume!: () => void;
  h.pauseWrite(new Promise<void>((resolve) => { resume = resolve; }));
  const writing = h.writePricePdfCache(key, Buffer.from('complete synthetic PDF'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.files.size, 1);
  assert.ok([...h.files.keys()].every((file) => file.endsWith('.tmp')));
  assert.equal(await h.readPricePdfCache(key), null);
  resume();
  await writing;
  assert.deepEqual(await h.readPricePdfCache(key), Buffer.from('complete synthetic PDF'));
  assert.ok([...h.files.keys()].every((file) => file.endsWith('.pdf')));
});

test('PDF cache: failed replacement preserves previous cached version and never touches source prices', async () => {
  const h = harness();
  const previous = { priceListId: 1, revision: 'a' };
  const next = { priceListId: 1, revision: 'b' };
  const anotherPrice = { priceListId: 2, revision: 'a' };
  await h.writePricePdfCache(previous, Buffer.from('previous'));
  await h.writePricePdfCache(anotherPrice, Buffer.from('another'));
  h.failRename();
  await h.writePricePdfCache(next, Buffer.from('next'));
  assert.deepEqual(await h.readPricePdfCache(previous), Buffer.from('previous'));
  assert.deepEqual(await h.readPricePdfCache(anotherPrice), Buffer.from('another'));
  assert.equal(await h.readPricePdfCache(next), null);
  assert.ok([...h.files.keys()].every((file) => file.endsWith('.pdf')));
  assert.deepEqual(h.messages, [['Failed to write price PDF cache']]);
});

test('PDF cache: refresh retains two recent versions and evicts only older derived downloads of that price', async () => {
  const h = harness();
  await h.writePricePdfCache({ priceListId: 1, revision: 'a' }, Buffer.from('previous'));
  await h.writePricePdfCache({ priceListId: 2, revision: 'a' }, Buffer.from('another'));
  await h.writePricePdfCache({ priceListId: 1, revision: 'b' }, Buffer.from('next'));
  assert.deepEqual(await h.readPricePdfCache({ priceListId: 1, revision: 'a' }), Buffer.from('previous'));
  await h.writePricePdfCache({ priceListId: 1, revision: 'c' }, Buffer.from('latest'));
  assert.equal(await h.readPricePdfCache({ priceListId: 1, revision: 'a' }), null);
  assert.deepEqual(await h.readPricePdfCache({ priceListId: 1, revision: 'b' }), Buffer.from('next'));
  assert.deepEqual(await h.readPricePdfCache({ priceListId: 1, revision: 'c' }), Buffer.from('latest'));
  assert.deepEqual(await h.readPricePdfCache({ priceListId: 2, revision: 'a' }), Buffer.from('another'));
  assert.equal(h.files.size, 3);
});

test('PDF cache: opposite completion order of concurrent revisions does not delete either new download', async () => {
  const h = harness();
  await h.writePricePdfCache({ priceListId: 1, revision: 'previous' }, Buffer.from('previous'));
  let resume!: () => void;
  h.pauseWrite(new Promise<void>((resolve) => { resume = resolve; }));
  const slower = h.writePricePdfCache({ priceListId: 1, revision: 'older-revision' }, Buffer.from('older complete PDF'));
  await new Promise((resolve) => setImmediate(resolve));
  h.pauseWrite();
  await h.writePricePdfCache({ priceListId: 1, revision: 'newer-revision' }, Buffer.from('newer complete PDF'));
  resume();
  await slower;
  assert.deepEqual(await h.readPricePdfCache({ priceListId: 1, revision: 'older-revision' }), Buffer.from('older complete PDF'));
  assert.deepEqual(await h.readPricePdfCache({ priceListId: 1, revision: 'newer-revision' }), Buffer.from('newer complete PDF'));
  assert.equal(await h.readPricePdfCache({ priceListId: 1, revision: 'previous' }), null);
  assert.equal(h.files.size, 2);
});
