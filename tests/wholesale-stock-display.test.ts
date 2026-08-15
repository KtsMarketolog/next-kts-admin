import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatWholesaleStockLabel,
  hasVisibleWholesaleStock,
  resolveWholesaleStockDisplayMode,
} from '../src/shared/lib/wholesaleStockDisplay';

test('group stock settings override global settings', () => {
  assert.equal(
    resolveWholesaleStockDisplayMode({
      globalShowNumbers: true,
      globalShowText: false,
      groupShowText: true,
    }),
    'text',
  );
  assert.equal(resolveWholesaleStockDisplayMode({ globalShowNumbers: false, globalShowText: false }), 'hidden');
});

test('stock labels preserve exact location totals', () => {
  assert.equal(
    formatWholesaleStockLabel({
      stock: 7,
      unit: 'шт.',
      isExpected: false,
      mode: 'number',
      stockByLocation: { volzhsk: 5, moscow: 2 },
    }),
    'В наличии: 5 шт. в Волжске, 2 шт. в Москве',
  );
  assert.equal(
    formatWholesaleStockLabel({ stock: 0, isExpected: true, mode: 'text' }),
    'Ожидается поступление',
  );
  assert.equal(hasVisibleWholesaleStock('hidden'), false);
});
