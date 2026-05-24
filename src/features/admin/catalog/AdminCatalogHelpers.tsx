import styles from '@/app/admin/admin.module.scss';

import type { CatalogDraft, CatalogProduct, StockImportLog } from './AdminCatalogTypes';

export function optionValues(items: string[], selected = '') {
  const uniqueItems = Array.from(new Set(items.filter(Boolean)));
  return selected && !uniqueItems.includes(selected) ? [selected, ...uniqueItems] : uniqueItems;
}

export function productPayload(product: CatalogDraft | CatalogProduct) {
  return {
    title: product.title,
    article: product.article,
    brand: product.brand,
    category: product.category,
    subcategory: product.subcategory,
    priceGroup: product.priceGroup,
    unit: product.unit,
    priceEur: product.priceEur,
    priceRub: product.priceRub,
    priceCny: product.priceCny,
    priceUsd: product.priceUsd,
    generalDiscount: product.generalDiscount,
    manualDiscount: product.manualDiscount,
    manualDiscountRop: product.manualDiscountRop,
    stock: product.stock,
    isExpected: product.isExpected,
    isActive: product.isActive,
  };
}

export function stockLogStatusText(status: StockImportLog['status']) {
  if (status === 'success') return 'Успешно';
  if (status === 'partial_success') return 'Частично';
  return 'Ошибка';
}

export function stockLogStatusClass(status: StockImportLog['status']) {
  if (status === 'success') return styles.stockLogStatusSuccess;
  if (status === 'partial_success') return styles.stockLogStatusPartial;
  return styles.stockLogStatusFailed;
}

export function formatStockLogDate(value: string) {
  return new Date(value).toLocaleString('ru-RU');
}

export function CatalogSkeleton() {
  return (
    <div className={styles.catalogSkeletonList} aria-busy="true" aria-label="Загрузка каталога">
      {Array.from({ length: 4 }).map((_, index) => (
        <article className={styles.catalogProductCard} key={index}>
          <div className={styles.catalogProductFields}>
            {Array.from({ length: 11 }).map((__, fieldIndex) => (
              <label key={fieldIndex}>
                <span className={styles.skeletonLabelLine} />
                <span className={styles.skeletonInputLine} />
              </label>
            ))}
          </div>
          <div className={styles.catalogProductMeta}>
            <span className={styles.skeletonShortLine} />
            <span className={styles.skeletonWideLine} />
            <div className={styles.userAccessActions}>
              <span className={styles.skeletonInputLine} />
              <span className={styles.skeletonInputLine} />
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
