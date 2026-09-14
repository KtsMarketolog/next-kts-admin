import assert from 'node:assert/strict';
import test from 'node:test';

import {
  replaceWholesalePriceListGroupStockSettings,
  replaceWholesalePriceListItems,
  WHOLESALE_PRICE_WRITE_BATCH_SIZE,
  type PriceListWriteQuery,
} from '../src/shared/lib/db/wholesaleAdminRepo/priceListWrite';
import type { WholesalePriceListItemInput } from '../src/shared/lib/db/wholesaleAdminRepo/types';

function items(count: number): WholesalePriceListItemInput[] {
  return Array.from({ length: count }, (_, index) => ({
    productId: index + 1, variantId: null, customWholesalePrice: '100', discountPercent: null,
    priceManuallyChanged: false, visible: false, sortOrder: index + 1,
  }));
}

function recordingQuery(shortBatch?: number) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let batch = 0;
  const execute: PriceListWriteQuery = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('delete ') || sql.startsWith('select ')) return { rowCount: 0 };
    const rows = JSON.parse(String(params[1])) as unknown[];
    batch += 1;
    return { rowCount: rows.length - (batch === shortBatch ? 1 : 0) };
  };
  return { calls, execute };
}

for (const count of [7475, 20001]) {
  test(`bulk writer retains all ${count} items with bounded parameter count`, async () => {
    const input = items(count);
    input[count - 1] = { ...input[count - 1], visible: true, discountPercent: '10', customWholesalePrice: '90' };
    const { calls, execute } = recordingQuery();
    await replaceWholesalePriceListItems(execute, 45, input);
    assert.equal(calls.length, 2 + Math.ceil(count / WHOLESALE_PRICE_WRITE_BATCH_SIZE));
    assert.match(calls.at(-1)!.sql, /^delete from wholesale_price_list_items existing/);
    assert.match(calls.at(-1)!.sql, /not exists/);
    const written = calls.slice(1, -1).flatMap(({ sql, params }) => {
      assert.equal(params.length, 2);
      assert.equal(params[0], 45);
      assert.match(sql, /order by item\.input_order/);
      assert.match(sql, /update wholesale_price_list_items existing/);
      assert.match(sql, /wholesale_variant_id is not distinct from item.variant_id/);
      const batch = JSON.parse(String(params[1]));
      assert.ok(batch.length <= WHOLESALE_PRICE_WRITE_BATCH_SIZE);
      assert.deepEqual(batch.map((row: { input_order: number }) => row.input_order), batch.map((_: unknown, index: number) => index));
      return batch;
    });
    assert.equal(written.length, count);
    assert.deepEqual(written.map((row) => row.product_id), input.map((row) => row.productId));
    assert.equal(written[0].visible, false);
    assert.equal(written[0].custom_wholesale_price, null);
    assert.equal(written[count - 1].visible, true);
    assert.equal(written[count - 1].discount_percent, '10');
    assert.equal(written[count - 1].custom_wholesale_price, '90');
  });
}

test('bulk writer preserves variant, manual-price, zero-discount and sort-order semantics', async () => {
  const input = items(4);
  input[0] = { ...input[0], variantId: 12, customWholesalePrice: '42.50', priceManuallyChanged: true, visible: true, sortOrder: 3 };
  input[1] = { ...input[1], discountPercent: '0', sortOrder: 3 };
  input[2] = { ...input[2], customWholesalePrice: '', priceManuallyChanged: true };
  const { calls, execute } = recordingQuery();
  await replaceWholesalePriceListItems(execute, 1, input);
  const written = JSON.parse(String(calls[1].params[1]));
  assert.equal(written[0].variant_id, 12);
  assert.equal(written[0].custom_wholesale_price, '42.50');
  assert.equal(written[0].price_manually_changed, true);
  assert.equal(written[1].variant_id, null);
  assert.equal(written[1].discount_percent, '0');
  assert.equal(written[1].custom_wholesale_price, '100');
  assert.equal(written[2].custom_wholesale_price, '');
  assert.equal(written[3].custom_wholesale_price, null);
  assert.deepEqual(written.map((row: { sort_order: number }) => row.sort_order), input.map((row) => row.sortOrder));
});

test('short insert row count fails immediately rather than silently skipping stale catalog IDs', async () => {
  const { calls, execute } = recordingQuery(2);
  await assert.rejects(replaceWholesalePriceListItems(execute, 1, items(3001)), /позиции каталога изменились/);
  assert.equal(calls.length, 3, 'duplicate check and two batches only; no pruning before all batches succeed');
});

test('duplicate keys across batches reject before deleting any existing items', async () => {
  const input = items(2001);
  input[2000] = { ...input[0], visible: true };
  const { calls, execute } = recordingQuery();
  await assert.rejects(replaceWholesalePriceListItems(execute, 1, input), /повторяющиеся позиции/);
  assert.equal(calls.length, 0);
});

test('legacy duplicate rows fail closed before writes and cannot mask invalid input references', async () => {
  let queries = 0;
  const execute: PriceListWriteQuery = async (sql) => {
    queries += 1;
    assert.match(sql, /having count\(\*\) > 1/);
    return { rowCount: 1 };
  };
  await assert.rejects(replaceWholesalePriceListItems(execute, 45, items(2)), /требуется проверка администратором/);
  assert.equal(queries, 1);
});

test('empty item replacement prunes only this price list without deleting any price-list header', async () => {
  const { calls, execute } = recordingQuery();
  await replaceWholesalePriceListItems(execute, 1, []);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /existing.price_list_id = \$1 and not exists/);
  assert.deepEqual(calls[1].params, [1, '[]']);
});

test('group settings preserve trimming, empty-entry skipping and last-enabled duplicate upsert semantics', async () => {
  const { calls, execute } = recordingQuery();
  await replaceWholesalePriceListGroupStockSettings(execute, 1, [
    { priceGroup: ' Group ', showStock: true, showStockText: false },
    { priceGroup: 'Group', showStock: false, showStockText: true },
    { priceGroup: 'Group', showStock: false, showStockText: false },
    { priceGroup: ' ', showStock: true, showStockText: true },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(String(calls[1].params[1])), [{ price_group: 'Group', show_stock_numbers: false, show_stock_text: true }]);
  assert.match(calls[1].sql, /where true\s+on conflict/);
});

test('group stock rows are also batched and short writes fail for the enclosing transaction', async () => {
  const settings = Array.from({ length: 2001 }, (_, index) => ({ priceGroup: `Group ${index}`, showStock: true, showStockText: false }));
  const normal = recordingQuery();
  await replaceWholesalePriceListGroupStockSettings(normal.execute, 1, settings);
  assert.equal(normal.calls.length, 4);
  const short = recordingQuery(2);
  await assert.rejects(replaceWholesalePriceListGroupStockSettings(short.execute, 1, settings), /настройки ценовых групп/);
  assert.equal(short.calls.length, 3);
});
