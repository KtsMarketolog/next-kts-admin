import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getWholesalePriceSaveError,
  normalizePositiveIntegerId,
} from '../src/shared/lib/wholesaleSecurity';
import {
  getWholesalePriceListAccessScope,
  resolveWholesalePriceListManagerAssignment,
} from '../src/shared/lib/wholesalePriceListAccess';

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

test('development manager price-list assignment uses manager_id', () => {
  assert.deepEqual(
    resolveWholesalePriceListManagerAssignment(
      { managerId: 31, supportManagerId: 42 },
      { role: 'manager', managerId: 7 },
    ),
    { managerId: 7, supportManagerId: 42 },
  );
});

test('support manager price-list assignment uses support_manager_id', () => {
  assert.deepEqual(
    resolveWholesalePriceListManagerAssignment(
      { managerId: 31, supportManagerId: 42 },
      { role: 'support_manager', managerId: 9 },
    ),
    { managerId: 31, supportManagerId: 9 },
  );
});

test('admin price-list assignment keeps both selected managers', () => {
  assert.deepEqual(
    resolveWholesalePriceListManagerAssignment(
      { managerId: 31, supportManagerId: 42 },
      { role: 'admin', managerId: null },
    ),
    { managerId: 31, supportManagerId: 42 },
  );
});

test('price-list access scope keeps manager roles separate', () => {
  assert.deepEqual(getWholesalePriceListAccessScope({ role: 'manager', managerId: 7 }), {
    managerId: 7,
    role: 'manager',
  });
  assert.deepEqual(getWholesalePriceListAccessScope({ role: 'support_manager', managerId: 9 }), {
    managerId: 9,
    role: 'support_manager',
  });
  assert.deepEqual(getWholesalePriceListAccessScope({ role: 'admin', managerId: null }), {
    managerId: null,
    role: null,
  });
  assert.deepEqual(getWholesalePriceListAccessScope({ role: 'manager', managerId: null }), {
    managerId: -1,
    role: 'manager',
  });
});
