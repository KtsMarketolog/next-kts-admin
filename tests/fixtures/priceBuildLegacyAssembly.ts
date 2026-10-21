/** Frozen legacy assembly from wholesaleRepo.ts at d746fd76cb17fd49c5d1df5ed275acd54a382ee9. Test reference only. */
import { buildPriceListAnalogLinks } from '../../src/shared/lib/analogs';
import { resolveWholesaleStockDisplayMode } from '../../src/shared/lib/wholesaleStockDisplay';
import type { PriceItemRow, PublicWholesalePriceMetadata, PublicWholesalePriceList, PublicWholesaleCategory, PublicWholesaleProduct } from '../../src/shared/lib/priceBuild/types';
import type { PricePerformanceTrace } from '../../src/shared/lib/pricePerformance';

export function assemblePublicWholesalePriceList(metadata: PublicWholesalePriceMetadata, rows: PriceItemRow[], includeAnalogs: boolean, trace: PricePerformanceTrace): PublicWholesalePriceList {
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
    const analogLinks = trace.measureSync('analogs', () => buildPriceListAnalogLinks(allProducts));
    for (const product of allProducts) {
      product.analogs = analogLinks.get(product.id) ?? [];
    }
  }

  return {
    ...metadata,
    categories: Array.from(categoriesById.values()),
  };
}
