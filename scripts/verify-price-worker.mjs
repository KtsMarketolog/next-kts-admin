import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize } from 'node:v8';
import { Worker } from 'node:worker_threads';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = '.runtime-build/price-build-worker.cjs';
const packaged = path.join(root, '.next', 'standalone', name);
assert.deepEqual(await readFile(packaged), await readFile(path.join(root, name)), 'Standalone price worker differs from the current bundle');

const worker = new Worker(packaged, { execArgv: [], workerData: {
  metadata: { id: 1, token: 'build-verification', showStock: false, showStockText: false },
  rows: [], includeAnalogs: true, revision: 'build-verification',
} });
try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Standalone price worker timed out')), 10_000);
    worker.once('message', (message) => { clearTimeout(timer); resolve(message); });
    worker.once('error', (error) => { clearTimeout(timer); reject(error); });
    worker.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Standalone price worker exited before result: ${code}`)); });
  });
  assert.equal(result.ok, true);
  assert.ok(result.result.serialized instanceof Uint8Array);
  assert.equal(result.result.cacheBytes, result.result.serialized.byteLength);
  const price = deserialize(result.result.serialized);
  assert.equal(price.cacheRevision, 'build-verification');
  assert.deepEqual(price.categories, []);
  console.log('Standalone private price worker verified');
} finally {
  await worker.terminate();
}
