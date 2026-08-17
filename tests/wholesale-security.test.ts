import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getWholesalePriceSaveError,
  normalizePositiveIntegerId,
} from '../src/shared/lib/wholesaleSecurity';

test('normalizePositiveIntegerId rejects empty and invalid manager ids', () => {
  for (const value of [null, undefined, '', '   ', 0, '0', -1, 1.5, '1.5', Number.NaN]) {
    assert.equal(normalizePositiveIntegerId(value), null);
  }
});

test('normalizePositiveIntegerId accepts positive integer ids', () => {
  assert.equal(normalizePositiveIntegerId(8), 8);
  assert.equal(normalizePositiveIntegerId('8'), 8);
  assert.equal(normalizePositiveIntegerId(' 8 '), 8);
});

test('getWholesalePriceSaveError hides manager foreign key details', () => {
  const error = new Error(
    'insert or update on table "wholesale_price_lists" violates foreign key constraint "wholesale_price_lists_manager_id_fkey"',
  );

  assert.equal(getWholesalePriceSaveError(error), 'Выберите менеджера по развитию');
});
