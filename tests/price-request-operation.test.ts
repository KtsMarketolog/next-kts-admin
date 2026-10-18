import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmPriceRequestOperation, nextPriceRequestOperation, preparePriceRequestOperation, type PriceRequestBody } from '../src/app/price/[token]/PriceRequestOperation';

test('uncertain submission reuses operation and original rate snapshot until deliberate contents change or success', () => {
  let generated = 0;
  const uuid = () => `operation-${++generated}`;
  const body: PriceRequestBody = { items: [{ id: 3, quantity: 2 }], comment: 'Customer note',
    rubConversion: { date: '2026-10-19', rates: { EUR: 100, CNY: 12 }, itemIds: [3] } };
  const first = nextPriceRequestOperation(null, body, uuid);
  const retry = nextPriceRequestOperation(first, { ...body, rubConversion: { ...body.rubConversion!, rates: { EUR: 101, CNY: 13 } } }, uuid);
  assert.equal(retry, first);
  assert.equal(retry.body.rubConversion?.rates.EUR, 100);
  assert.notEqual(nextPriceRequestOperation(first, { ...body, comment: 'Edited' }, uuid).body.operationId, first.body.operationId);
  assert.notEqual(nextPriceRequestOperation(first, { ...body, items: [{ id: 3, quantity: 4 }] }, uuid).body.operationId, first.body.operationId);
  assert.notEqual(nextPriceRequestOperation(first, { ...body, rubConversion: null }, uuid).body.operationId, first.body.operationId);
  assert.notEqual(nextPriceRequestOperation(null, body, uuid).body.operationId, first.body.operationId);
});

test('opaque id and digest survive reload; content stays out of storage and confirmed or changed operations get fresh ids', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const body = { items: [{ id: 11, quantity: 3 }], comment: 'Private synthetic customer note', rubConversion: null };
  const first = await preparePriceRequestOperation(null, body, 'token', storage);
  const stored = [...values.values()][0];
  assert.doesNotMatch(stored, /Private|synthetic|items|quantity|comment/);
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ['digest', 'operationId']);
  assert.equal((await preparePriceRequestOperation(null, body, 'token', storage)).body.operationId, first.body.operationId);
  assert.notEqual((await preparePriceRequestOperation(null, body, 'other-token', storage)).body.operationId, first.body.operationId);
  confirmPriceRequestOperation('token', storage);
  assert.notEqual((await preparePriceRequestOperation(null, body, 'token', storage)).body.operationId, first.body.operationId);
  assert.notEqual((await preparePriceRequestOperation(null, { ...body, comment: 'Deliberately edited' }, 'token', storage)).body.operationId, first.body.operationId);
});

test('new automatic conversion date/rates after reload reuse the same semantic intent id', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const body = { items: [{ id: 11, quantity: 3 }], comment: '',
    rubConversion: { date: '2026-10-19', rates: { EUR: 100, CNY: 12 }, itemIds: [11] } };
  const first = await preparePriceRequestOperation(null, body, 'token', storage);
  const reloaded = await preparePriceRequestOperation(null, { ...body,
    rubConversion: { date: '2026-10-20', rates: { EUR: 101, CNY: 13 }, itemIds: [11] } }, 'token', storage);
  assert.equal(reloaded.body.operationId, first.body.operationId);
});
