import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as analogs from '../../src/shared/lib/analogs';
import * as stockDisplay from '../../src/shared/lib/wholesaleStockDisplay';
import knowledge from '../../src/shared/data/analogs.generated.json';
import type { PriceBuildInput, PriceItemRow, PublicWholesalePriceList } from '../../src/shared/lib/priceBuild/types';

const modelNames = [...new Set([
  ...knowledge.directGroups.flatMap(group => group.items.map(item => item.model)),
  ...knowledge.compressorSeries.flatMap(series => series.products.map(product => product.model)),
])];

/** All business values are synthetic; model names come from the bundled analog reference. */
export function priceBuildWorkload(productCount: number, includeAnalogs = true): PriceBuildInput {
  const rows: PriceItemRow[] = [];
  for (let index = 0; index < productCount; index += 1) {
    const model = modelNames[index] ?? `SYNTHETIC-MODEL-${index}`;
    const base: PriceItemRow = {
      item_id: String(index * 2 + 1), product_id: String(index + 1), product_title: `Synthetic product ${index}: ${model}`,
      category_id: index % 13 === 0 ? null : String(index % 13), category_title: index % 13 === 0 ? null : `Synthetic category ${index % 13}`,
      sku: `SYNTHETIC-SKU-${index}`, model: index % 17 === 0 ? null : model,
      series_description: index % 3 ? `Synthetic description ${index}` : '', price_group: index % 11 ? `Group ${index % 11}` : null,
      price_group_image_url: index % 5 ? `/synthetic/group-${index % 11}.webp` : null,
      image_url: index % 7 ? `/synthetic/product-${index}.webp` : null,
      stock: index % 19 === 0 ? null : String(index % 101), stock_volzhsk: index % 19 === 0 ? null : String(index % 101),
      stock_moscow: index % 19 === 0 ? null : '0', unit: index % 5 === 0 ? null : 'шт.',
      is_expected: index % 3 === 0 ? null : index % 3 === 1,
      group_show_stock_numbers: [null, true, false][index % 3], group_show_stock_text: [false, null, true][index % 3],
      stock_updated_at: index % 7 === 0 ? null : '2026-10-22T12:00:00Z',
      variant_id: index % 4 ? null : String(index + 100_000), variant_title: index % 4 ? '' : `Synthetic variant ${index}`,
      retail_price: index % 4 === 0 ? '123.45' : null, retail_price_eur: index % 4 === 1 ? '67.89' : null,
      retail_price_rub: index % 4 === 2 ? '789.01' : null, retail_price_cny: index % 4 === 3 ? '234.56' : null,
      wholesale_price: index % 4 === 0 ? '100.00' : null, price_eur: index % 4 === 1 ? '50.00' : null,
      price_rub: index % 4 === 2 ? '600.00' : null, price_cny: index % 4 === 3 ? '200.00' : null,
    };
    rows.push(base);
    if (index % 7 === 0) rows.push({ ...base, item_id: String(index * 2 + 2), variant_id: String(index + 200_000),
      variant_title: 'Synthetic additional variant', wholesale_price: '99.99', price_eur: null, price_rub: null, price_cny: null });
  }
  return {
    metadata: { id: 100, clientCompanyId: 123, title: 'Synthetic reference price', token: 'synthetic-reference-token',
      clientName: 'Synthetic client', managerId: 2, managerName: 'Synthetic manager', managerEmail: 'synthetic@example.test',
      managerPhone: '000', supportManagerId: 3, supportManagerName: 'Synthetic support', supportManagerEmail: 'support@example.test',
      supportManagerPhone: '111', validUntil: '2027-12-31', updatedAt: '2026-10-22T12:00:00Z',
      showRetailPrices: true, showStock: true, showStockText: false },
    rows, includeAnalogs, revision: 'synthetic-reference-revision',
  };
}

/** Exact historical implementation, loaded with an explicit pure dependency allowlist. */
export function loadLegacyPriceAssembly() {
  const source = readFileSync(new URL('../fixtures/priceBuildLegacyAssembly.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps: Record<string, unknown> = {
    '../../src/shared/lib/analogs': analogs,
    '../../src/shared/lib/wholesaleStockDisplay': stockDisplay,
  };
  const output = { exports: {} as { assemblePublicWholesalePriceList: (
    metadata: PriceBuildInput['metadata'], rows: PriceItemRow[], includeAnalogs: boolean,
    trace: { measureSync: <T>(name: string, work: () => T) => T },
  ) => PublicWholesalePriceList } };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in deps, `Unexpected legacy assembly dependency: ${name}`);
    return deps[name];
  }, output, output.exports);
  return (input: PriceBuildInput): PublicWholesalePriceList => ({
    ...output.exports.assemblePublicWholesalePriceList(input.metadata, input.rows, input.includeAnalogs, { measureSync: (_name, work) => work() }),
    cacheRevision: input.revision,
  });
}
