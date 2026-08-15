import assert from 'node:assert/strict';
import test from 'node:test';

import { phoneHref } from '../src/shared/lib/phone';
import {
  getWholesalePriceWorkflowStatusLabel,
  normalizeWholesalePriceWorkflowStatus,
} from '../src/shared/lib/wholesalePriceWorkflowStatus';

test('phoneHref keeps only phone digits', () => {
  assert.equal(phoneHref('+7 (964) 860-90-10'), 'tel:+79648609010');
  assert.equal(phoneHref('нет номера'), '#');
});

test('wholesale workflow status falls back safely', () => {
  assert.equal(normalizeWholesalePriceWorkflowStatus(' confirmed '), 'confirmed');
  assert.equal(normalizeWholesalePriceWorkflowStatus('unknown'), 'not_sent');
  assert.equal(getWholesalePriceWorkflowStatusLabel('needs_correction'), 'Требует корректировки');
});
