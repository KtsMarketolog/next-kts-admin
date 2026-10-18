import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeEditorItems } from '../src/features/admin/wholesale/AdminWholesaleEditorModel';
import { buildPriceEditorFromPayload } from '../src/features/admin/wholesale/AdminWholesaleGateway.helpers';
import { assertWholesaleEditorCompanies, parseWholesaleEditorCatalog, parseWholesaleEditorPrice } from '../src/features/admin/wholesale/wholesaleEditorLoad';
import type { CatalogCategory, PriceItem } from '../src/features/admin/wholesale/AdminWholesaleTypes';

const item: PriceItem = { productId: 1, variantId: null, customWholesalePrice: '42.15', discountPercent: '12.5',
  priceManuallyChanged: true, visible: true, sortOrder: 18 };
const inactiveItem: PriceItem = { ...item, productId: 2, variantId: 7, customWholesalePrice: '11.20', visible: false };
const inactiveVariant: PriceItem = { ...item, variantId: 8, customWholesalePrice: '0', discountPercent: '0' };
const catalog: CatalogCategory[] = [{ id: 0, title: 'Без категории', products: [{ id: 1, title: 'Product', sku: '', model: '',
  description: '', imageUrl: null, priceGroup: '', priceGroupImageUrl: null, priceEur: null, priceRub: '100', priceCny: null,
  generalDiscount: null, manualDiscount: null, manualDiscountRop: null, stock: 0, unit: null, isExpected: false,
  stockUpdatedAt: null, variants: [{ id: null, title: 'Цена', wholesalePrice: '100', retailPrice: null }] }] }];
const detail = () => ({ id: 11, revision: '42', title: 'Price', clientCompanyId: 3, clientName: 'Client', token: 'synthetic', validUntil: null,
  comment: '', workflowStatus: 'not_sent', showRetailPrices: false, showStock: true, showStockText: false, isActive: true,
  managerId: 4, supportManagerId: 5, items: [item, inactiveItem, inactiveVariant],
  priceGroupStockSettings: [{ priceGroup: 'Inactive group', showStock: true, showStockText: false }] });

test('active catalogue projection never discards inactive products or variants, including with a truly empty catalogue', () => {
  const stored = [item, inactiveItem, inactiveVariant];
  const before = structuredClone(stored);
  const merged = mergeEditorItems(catalog, stored);
  assert.deepEqual(merged, stored);
  assert.deepEqual(mergeEditorItems([], stored), stored);
  assert.deepEqual(stored, before, 'loading does not mutate stored items');
  assert.equal(merged[1], inactiveItem, 'unavailable configuration stays verbatim');
  assert.equal(merged[2], inactiveVariant);
});

test('reactivating catalogue item uses its saved visibility, manual price and discount', () => {
  const restored = structuredClone(catalog);
  restored[0].products[0].variants.push({ id: 8, title: 'Returned variant', wholesalePrice: '150', retailPrice: null });
  const merged = mergeEditorItems(restored, [item, inactiveItem, inactiveVariant]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.find((row) => row.variantId === 8), inactiveVariant);
  assert.deepEqual(merged.find((row) => row.productId === 2), inactiveItem);
});

test('new catalogue rows remain unselected while saved absent rows remain intact', () => {
  const merged = mergeEditorItems(catalog, [inactiveItem]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].visible, false);
  assert.equal(merged[0].customWholesalePrice, '100');
  assert.deepEqual(merged[1], inactiveItem);
});

test('successful empty catalogue is accepted but missing, partial, duplicate or malformed data fails closed', () => {
  assert.deepEqual(parseWholesaleEditorCatalog({ categories: [] }), []);
  assert.equal(parseWholesaleEditorCatalog({ categories: catalog }), catalog);
  const brokenProducts = structuredClone(catalog) as unknown as Array<Record<string, unknown>>;
  brokenProducts[0].products = null;
  const brokenVariants = structuredClone(catalog);
  brokenVariants[0].products[0].variants = [];
  const duplicateVariant = structuredClone(catalog);
  duplicateVariant[0].products[0].variants.push(duplicateVariant[0].products[0].variants[0]);
  for (const payload of [null, {}, [], { categories: null }, { categories: [null] }, { categories: brokenProducts },
    { categories: brokenVariants }, { categories: duplicateVariant }, { categories: [...catalog, ...catalog] }]) {
    assert.throws(() => parseWholesaleEditorCatalog(payload), /Каталог/);
  }
});

test('detail requires correct identity and complete stored arrays; invalid rows cannot become default items', () => {
  assert.equal(parseWholesaleEditorPrice({ priceList: detail() }, 11).id, 11);
  assert.deepEqual(parseWholesaleEditorPrice({ priceList: { ...detail(), items: [], priceGroupStockSettings: [] } }, 11).items, []);
  for (const price of [null, {}, { ...detail(), id: 12 }, { ...detail(), revision: undefined }, { ...detail(), revision: '0' }, { ...detail(), items: undefined }, { ...detail(), items: {} },
    { ...detail(), items: [null] }, { ...detail(), items: [item, item] }, { ...detail(), items: [{ ...item, visible: undefined }] },
    { ...detail(), workflowStatus: undefined }, { ...detail(), workflowStatus: 'unknown' },
    { ...detail(), priceGroupStockSettings: undefined }, { ...detail(), priceGroupStockSettings: [{}] }]) {
    assert.throws(() => parseWholesaleEditorPrice({ priceList: price }, 11), /Данные прайса/);
  }
});

test('loaded editor retains absent rows and inactive group stock settings independently from active display', () => {
  const editor = buildPriceEditorFromPayload(parseWholesaleEditorPrice({ priceList: detail() }, 11), catalog, []);
  assert.equal(editor.revision, '42');
  assert.deepEqual(editor.items, detail().items);
  assert.deepEqual(editor.priceGroupStockSettings, { 'inactive group': detail().priceGroupStockSettings[0] });
});

test('client list distinguishes successful emptiness from a failed or incomplete response', () => {
  assert.doesNotThrow(() => assertWholesaleEditorCompanies({ companies: [] }));
  assert.doesNotThrow(() => assertWholesaleEditorCompanies({ companies: [{ id: 1, title: 'Client', managerId: null, supportManagerId: 2, isActive: true }] }));
  for (const payload of [null, {}, { companies: null }, { companies: [null] }, { companies: [{ id: 1, title: 'Client' }] }]) {
    assert.throws(() => assertWholesaleEditorCompanies(payload), /Список клиентов/);
  }
});
