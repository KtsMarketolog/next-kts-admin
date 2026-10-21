import { performance } from 'node:perf_hooks';
import { serialize } from 'node:v8';
import { buildPriceListAnalogLinks } from '../analogs';
import { resolveWholesaleStockDisplayMode } from '../wholesaleStockDisplay';
import type {
  PriceBuildInput, PriceBuildResult, PriceItemRow, PublicWholesaleCategory,
  PublicWholesalePriceList, PublicWholesalePriceMetadata, PublicWholesaleProduct,
} from './types';

/** Pure assembly only. No database, network, cache or request lifecycle work. */
export function assemblePublicWholesalePriceList(
  metadata: PublicWholesalePriceMetadata,
  rows: PriceItemRow[],
  includeAnalogs: boolean,
  onAnalogsDuration?: (milliseconds: number) => void,
): PublicWholesalePriceList {
  const categoriesById = new Map<number, PublicWholesaleCategory>();
  const productKeyByCategory = new Map<string, PublicWholesaleProduct>();

  for (const row of rows) {
    const categoryId = Number(row.category_id ?? 0);
    const categoryKey = Number.isFinite(categoryId) && categoryId > 0 ? categoryId : 0;
    let category = categoriesById.get(categoryKey);
    if (!category) {
      category = {
        id: categoryKey,
        title: row.category_title || 'Без категории',
        products: [],
      };
      categoriesById.set(categoryKey, category);
    }

    const productId = Number(row.product_id);
    const productKey = `${categoryKey}:${productId}`;
    let product = productKeyByCategory.get(productKey);
    if (!product) {
      product = {
        id: productId,
        title: row.product_title,
        sku: row.sku,
        model: row.model ?? '',
        description: row.series_description,
        priceGroup: row.price_group ?? '',
        priceGroupImageUrl: row.price_group_image_url,
        imageUrl: row.image_url,
        stock: Number(row.stock ?? 0),
        stockVolzhsk: Number(row.stock_volzhsk ?? 0),
        stockMoscow: Number(row.stock_moscow ?? 0),
        unit: row.unit,
        isExpected: Boolean(row.is_expected),
        stockDisplayMode: resolveWholesaleStockDisplayMode({
          globalShowNumbers: metadata.showStock,
          globalShowText: metadata.showStockText,
          groupShowNumbers: row.group_show_stock_numbers,
          groupShowText: row.group_show_stock_text,
        }),
        stockUpdatedAt: row.stock_updated_at,
        analogs: [],
        variants: [],
      };
      category.products.push(product);
      productKeyByCategory.set(productKey, product);
    }

    product.variants.push({
      priceItemId: Number(row.item_id),
      id: row.variant_id ? Number(row.variant_id) : null,
      title: row.variant_title || 'Цена',
      retailPrice: row.retail_price,
      retailPriceEur: row.retail_price_eur,
      retailPriceRub: row.retail_price_rub,
      retailPriceCny: row.retail_price_cny,
      wholesalePrice: row.wholesale_price,
      priceEur: row.price_eur,
      priceRub: row.price_rub,
      priceCny: row.price_cny,
    });
  }

  if (includeAnalogs) {
    const allProducts = Array.from(categoriesById.values()).flatMap((category) => category.products);
    const started = performance.now();
    const analogLinks = buildPriceListAnalogLinks(allProducts);
    onAnalogsDuration?.(performance.now() - started);
    for (const product of allProducts) product.analogs = analogLinks.get(product.id) ?? [];
  }

  return { ...metadata, categories: Array.from(categoriesById.values()) };
}

/** Called only in the build worker in production. */
export function assemblePriceBuild(input: PriceBuildInput): PriceBuildResult {
  const started = performance.now();
  let analogsMs = 0;
  const price = {
    ...assemblePublicWholesalePriceList(input.metadata, input.rows, input.includeAnalogs, (duration) => { analogsMs = duration; }),
    cacheRevision: input.revision,
  };
  const assembled = performance.now();
  // An owned, transferable buffer avoids cloning both the price object and its
  // serialized cache copy across threads (v8's Buffer can use a shared slab).
  const serialized = Uint8Array.from(serialize(price));
  const finished = performance.now();
  return { price, serialized, cacheBytes: serialized.byteLength, timings: {
    assemblyMs: assembled - started - analogsMs,
    analogsMs,
    serializationMs: finished - assembled,
    totalMs: finished - started,
  } };
}
