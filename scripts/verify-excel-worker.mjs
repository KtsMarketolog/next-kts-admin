import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import * as XLSX from 'xlsx';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = '.runtime-build/excel-processing-worker.cjs';
const packaged = path.join(root, '.next', 'standalone', name);
assert.deepEqual(await readFile(packaged), await readFile(path.join(root, name)), 'Standalone Excel worker differs from the current bundle');
for (const kind of ['catalog', 'stock']) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(kind === 'catalog'
    ? [['Артикул', 'Наименование'], ['BUILD-CHECK', 'Synthetic']]
    : [['Артикул', 'Сейчас'], ['BUILD-CHECK', 1]]), 'Synthetic');
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  const worker = new Worker(packaged, { execArgv: [], workerData: { kind, bytes } });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Standalone Excel worker timed out')), 10_000);
      worker.once('message', (message) => { clearTimeout(timer); resolve(message); });
      worker.once('error', (error) => { clearTimeout(timer); reject(error); });
      worker.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Standalone Excel worker exited before result: ${code}`)); });
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.rows.length, 1);
    if (kind === 'catalog') {
      assert.equal(result.rows[0].article, 'BUILD-CHECK');
      assert.deepEqual(result.sourceRows, [2]);
    } else assert.equal(result.rows[0].row['Артикул'], 'BUILD-CHECK');
  } finally { await worker.terminate(); }
}
console.log('Standalone private Excel processing worker verified');
