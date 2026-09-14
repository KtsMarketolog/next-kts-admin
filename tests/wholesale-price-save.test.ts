import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_WHOLESALE_PRICE_BODY_BYTES,
  WholesalePriceSaveValidationError,
  parseWholesalePriceItems,
  readWholesalePriceSaveBody,
} from '../src/shared/lib/wholesalePriceSave';

const item = (index: number) => ({
  productId: index + 1, variantId: null, customWholesalePrice: null as string | null,
  discountPercent: null as string | null, priceManuallyChanged: false,
  visible: index % 3 !== 0, sortOrder: index + 1,
});
const validation = (status: 400 | 413 = 400) => (error: unknown) => {
  assert.ok(error instanceof WholesalePriceSaveValidationError);
  assert.equal(error.status, status);
  return true;
};
const jsonRequest = (body: string | Uint8Array, headers?: HeadersInit) => new Request('http://localhost/api/test-price', {
  method: 'POST', headers, body: body as BodyInit,
});

for (const count of [7475, 20001]) {
  test(`price save preserves all ${count} catalogue rows and late visibility/discount/manual-price values`, async () => {
    const rows = Array.from({ length: count }, (_, index) => item(index));
    const late = rows[count - 1];
    Object.assign(late, { customWholesalePrice: '1234,56', discountPercent: '12,50', priceManuallyChanged: true, visible: true });
    Object.assign(rows[5000], { customWholesalePrice: '99.00', discountPercent: '7.25', visible: false });
    const original = structuredClone(rows);
    const body = await readWholesalePriceSaveBody(jsonRequest(JSON.stringify({ title: 'Synthetic full catalogue', items: rows })));
    const parsed = parseWholesalePriceItems(body.items);
    assert.equal(parsed.length, count);
    assert.deepEqual(parsed.map((row) => row.productId), rows.map((row) => row.productId));
    assert.deepEqual(parsed.map((row) => row.visible), rows.map((row) => row.visible));
    assert.deepEqual(parsed[count - 1], { ...late, customWholesalePrice: '1234.56', discountPercent: '12.50' });
    assert.deepEqual(parsed[5000], rows[5000]);
    assert.deepEqual(rows, original, 'normalization must not mutate caller-owned rows');
  });
}

test('price save allows base and different variants, preserves zero values and applies only explicit defaults', () => {
  const parsed = parseWholesalePriceItems([
    { productId: '1', visible: false, customWholesalePrice: 0, discountPercent: 0 },
    { productId: 1, variantId: '7', visible: true, customWholesalePrice: '  ', discountPercent: null, sortOrder: 0 },
    { productId: 1, variantId: 8, visible: true, priceManuallyChanged: true, customWholesalePrice: '123,45', discountPercent: '100.00' },
  ]);
  assert.deepEqual(parsed, [
    { productId: 1, variantId: null, visible: false, customWholesalePrice: '0', discountPercent: '0', priceManuallyChanged: false, sortOrder: 1 },
    { productId: 1, variantId: 7, visible: true, customWholesalePrice: null, discountPercent: null, priceManuallyChanged: false, sortOrder: 0 },
    { productId: 1, variantId: 8, visible: true, customWholesalePrice: '123.45', discountPercent: '100.00', priceManuallyChanged: true, sortOrder: 3 },
  ]);
  assert.deepEqual(parseWholesalePriceItems([]), []);
});

test('price save rejects a malformed late row instead of silently dropping it or clipping the catalogue', () => {
  const fixtures: unknown[] = [
    null, [], 'row', 42,
    { ...item(0), productId: 0 }, { ...item(0), productId: -1 },
    { ...item(0), productId: 1.5 }, { ...item(0), productId: Number.MAX_SAFE_INTEGER + 1 },
    { ...item(0), productId: true }, { ...item(0), variantId: 'broken' },
    { ...item(0), variantId: 0 }, { ...item(0), variantId: {} },
    { ...item(0), visible: 'false' }, { ...item(0), visible: undefined },
    { ...item(0), priceManuallyChanged: 'false' },
    { ...item(0), customWholesalePrice: 'invalid' }, { ...item(0), customWholesalePrice: -1 },
    { ...item(0), customWholesalePrice: '1.234' }, { ...item(0), customWholesalePrice: true },
    { ...item(0), discountPercent: 100.01 }, { ...item(0), discountPercent: -1 },
    { ...item(0), discountPercent: {} }, { ...item(0), customWholesalePrice: Infinity },
    { ...item(0), sortOrder: -1 }, { ...item(0), sortOrder: 1.5 },
    { ...item(0), sortOrder: 2147483648 }, { ...item(0), sortOrder: true },
  ];
  for (const badRow of fixtures) {
    const rows: unknown[] = Array.from({ length: 7474 }, (_, index) => item(index));
    rows.push(badRow);
    assert.throws(() => parseWholesalePriceItems(rows), validation());
  }
  for (const badList of [undefined, null, {}, 'items']) assert.throws(() => parseWholesalePriceItems(badList), validation());
});

test('price save rejects duplicate logical IDs even beyond row 20000 and across string/number representations', () => {
  const rows = Array.from({ length: 20001 }, (_, index) => item(index));
  assert.throws(() => parseWholesalePriceItems([...rows, { ...item(1), productId: '2' }]), validation());
  assert.throws(() => parseWholesalePriceItems([
    { ...item(0), variantId: 6 }, { ...item(0), variantId: '6' },
  ]), validation());
});

test('price save body rejects malformed JSON and non-object roots', async () => {
  for (const source of ['', '{"items":', 'null', '[]', 'true', '42', '"text"']) {
    await assert.rejects(readWholesalePriceSaveBody(jsonRequest(source)), validation());
  }
  await assert.rejects(readWholesalePriceSaveBody(new Request('http://localhost/api/test-price', { method: 'POST' })), validation());
});

test('price save accepts the exact byte boundary and explicitly rejects an oversized declared body', async () => {
  assert.equal(MAX_WHOLESALE_PRICE_BODY_BYTES, 16 * 1024 * 1024);
  const overhead = Buffer.byteLength('{"padding":""}');
  const body = JSON.stringify({ padding: 'x'.repeat(MAX_WHOLESALE_PRICE_BODY_BYTES - overhead) });
  assert.equal(Buffer.byteLength(body), MAX_WHOLESALE_PRICE_BODY_BYTES);
  assert.equal((await readWholesalePriceSaveBody(jsonRequest(body))).padding, JSON.parse(body).padding);
  await assert.rejects(readWholesalePriceSaveBody(jsonRequest('{}', {
    'content-length': String(MAX_WHOLESALE_PRICE_BODY_BYTES + 1),
  })), validation(413));
});

test('price save enforces streamed bytes without trusting a missing or smaller Content-Length and cancels overflow', async () => {
  for (const length of [undefined, '2']) {
    let cancelled = false;
    let emitted = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { emitted += 1; controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const request = new Request('http://localhost/api/test-price', {
      method: 'POST', body: stream, duplex: 'half',
      ...(length ? { headers: { 'content-length': length } } : {}),
    } as RequestInit & { duplex: 'half' });
    await assert.rejects(readWholesalePriceSaveBody(request), validation(413));
    assert.equal(cancelled, true);
    assert.equal(emitted, 17, 'stop reading immediately after the first overflow chunk');
  }
});

test('price save measures UTF-8 bytes rather than JavaScript string length', async () => {
  const body = JSON.stringify({ padding: 'я'.repeat(MAX_WHOLESALE_PRICE_BODY_BYTES / 2) });
  assert.ok(body.length < MAX_WHOLESALE_PRICE_BODY_BYTES);
  assert.ok(Buffer.byteLength(body) > MAX_WHOLESALE_PRICE_BODY_BYTES);
  await assert.rejects(readWholesalePriceSaveBody(jsonRequest(body)), validation(413));
});

test('price save rejects malformed UTF-8 rather than replacing bytes in accepted data', async () => {
  const broken = Buffer.concat([Buffer.from('{"title":"'), Buffer.from([0xc3]), Buffer.from('","items":[]}')]);
  await assert.rejects(readWholesalePriceSaveBody(jsonRequest(broken)), validation());
});
