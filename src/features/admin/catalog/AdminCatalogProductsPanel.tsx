import type { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';

import { CatalogSkeleton, optionValues } from './AdminCatalogHelpers';
import {
  CATALOG_PRODUCT_PAGE_LIMIT,
  type CatalogDraft,
  type CatalogFilterOptions,
  type CatalogFilters,
  type CatalogProduct,
} from './AdminCatalogTypes';

type AdminCatalogProductsPanelProps = {
  draft: CatalogDraft;
  setDraft: Dispatch<SetStateAction<CatalogDraft>>;
  filterOptions: CatalogFilterOptions;
  savedId: string | null;
  createProduct: () => Promise<void>;
  filters: CatalogFilters;
  applyFilters: (patch: Partial<CatalogFilters>) => void;
  search: string;
  setSearch: (value: string) => void;
  loadCatalog: (nextSearch?: string, nextFilters?: CatalogFilters) => Promise<void>;
  loading: boolean;
  products: CatalogProduct[];
  updateProduct: (id: number, patch: Partial<CatalogProduct>) => void;
  saveProduct: (product: CatalogProduct) => Promise<void>;
  deleteProduct: (product: CatalogProduct) => Promise<void>;
  busyId: string | null;
};

export function AdminCatalogProductsPanel({
  draft,
  setDraft,
  filterOptions,
  savedId,
  createProduct,
  filters,
  applyFilters,
  search,
  setSearch,
  loadCatalog,
  loading,
  products,
  updateProduct,
  saveProduct,
  deleteProduct,
  busyId,
}: AdminCatalogProductsPanelProps) {
  return (
    <>
      <div className={styles.catalogProductForm}>
        <label>
          <span>Наименование</span>
          <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
        </label>
        <label>
          <span>Категория</span>
          <select value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}>
            <option value="">Выберите категорию</option>
            {optionValues(filterOptions.categories, draft.category).map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Подкатегория</span>
          <select value={draft.subcategory} onChange={(event) => setDraft((current) => ({ ...current, subcategory: event.target.value }))}>
            <option value="">Выберите подкатегорию</option>
            {optionValues(filterOptions.subcategories, draft.subcategory).map((subcategory) => (
              <option key={subcategory} value={subcategory}>
                {subcategory}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Бренд</span>
          <select value={draft.brand} onChange={(event) => setDraft((current) => ({ ...current, brand: event.target.value }))}>
            <option value="">Выберите бренд</option>
            {optionValues(filterOptions.brands, draft.brand).map((brand) => (
              <option key={brand} value={brand}>
                {brand}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Артикул</span>
          <input value={draft.article} onChange={(event) => setDraft((current) => ({ ...current, article: event.target.value }))} />
        </label>
        <label>
          <span>Модель</span>
          <input value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} />
        </label>
        <label>
          <span>Ценовая группа</span>
          <input value={draft.priceGroup} onChange={(event) => setDraft((current) => ({ ...current, priceGroup: event.target.value }))} />
        </label>
        <label>
          <span>Цена EUR</span>
          <input value={draft.priceEur} onChange={(event) => setDraft((current) => ({ ...current, priceEur: event.target.value }))} />
        </label>
        <label>
          <span>Цена RUB</span>
          <input value={draft.priceRub} onChange={(event) => setDraft((current) => ({ ...current, priceRub: event.target.value }))} />
        </label>
        <label>
          <span>Цена CNY</span>
          <input value={draft.priceCny} onChange={(event) => setDraft((current) => ({ ...current, priceCny: event.target.value }))} />
        </label>
        <label>
          <span>Общая скидка</span>
          <input value={draft.generalDiscount} onChange={(event) => setDraft((current) => ({ ...current, generalDiscount: event.target.value }))} />
        </label>
        <label>
          <span>Ручная скидка</span>
          <input value={draft.manualDiscount} onChange={(event) => setDraft((current) => ({ ...current, manualDiscount: event.target.value }))} />
        </label>
        <label>
          <span>Ручная скидка РОП</span>
          <input value={draft.manualDiscountRop} onChange={(event) => setDraft((current) => ({ ...current, manualDiscountRop: event.target.value }))} />
        </label>
        <label>
          <span>Остаток</span>
          <input
            type="number"
            min="0"
            step="1"
            value={draft.stock}
            onChange={(event) => setDraft((current) => ({ ...current, stock: Math.max(0, Number(event.target.value) || 0) }))}
          />
        </label>
        <label className={styles.userActiveToggle}>
          <input
            type="checkbox"
            checked={draft.isExpected}
            onChange={(event) => setDraft((current) => ({ ...current, isExpected: event.target.checked }))}
          />
          Ожидается
        </label>
        <label className={styles.userActiveToggle}>
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))}
          />
          Активен
        </label>
        <button className={savedId === 'new' ? styles.savedButton : undefined} disabled={busyId === 'new'} onClick={createProduct}>
          {savedId === 'new' ? 'Товар добавлен' : 'Добавить товар'}
        </button>
      </div>

      <div className={styles.catalogToolbar}>
        <div className={styles.catalogFilters}>
          <select value={filters.active} onChange={(event) => applyFilters({ active: event.target.value as CatalogFilters['active'] })}>
            <option value="all">Все товары</option>
            <option value="active">Только активные</option>
            <option value="inactive">Только скрытые</option>
          </select>
          <select value={filters.category} onChange={(event) => applyFilters({ category: event.target.value, subcategory: '', brand: '' })}>
            <option value="">Все категории</option>
            {optionValues(filterOptions.categories, filters.category).map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <select value={filters.subcategory} onChange={(event) => applyFilters({ subcategory: event.target.value, brand: '' })}>
            <option value="">Все подкатегории</option>
            {optionValues(filterOptions.subcategories, filters.subcategory).map((subcategory) => (
              <option key={subcategory} value={subcategory}>
                {subcategory}
              </option>
            ))}
          </select>
          <select value={filters.brand} onChange={(event) => applyFilters({ brand: event.target.value })}>
            <option value="">Все бренды</option>
            {optionValues(filterOptions.brands, filters.brand).map((brand) => (
              <option key={brand} value={brand}>
                {brand}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.catalogSearch}>
          <input
            placeholder="Поиск по названию, модели, бренду, категории или артикулу"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void loadCatalog(search, filters);
            }}
          />
          <button onClick={() => void loadCatalog(search, filters)}>Найти</button>
        </div>
      </div>

      {loading ? (
        <CatalogSkeleton />
      ) : products.length === 0 ? (
        <p className={styles.mutedText}>Товары не найдены</p>
      ) : (
        <>
          <p className={styles.mutedText}>
            Показаны первые {CATALOG_PRODUCT_PAGE_LIMIT} товаров. Для точного поиска используйте строку поиска.
          </p>
          <div className={styles.catalogProductList}>
            {products.map((product) => (
              <article className={styles.catalogProductCard} key={product.id}>
                <div className={styles.catalogProductFields}>
                  <label>
                    <span>Наименование</span>
                    <input value={product.title} onChange={(event) => updateProduct(product.id, { title: event.target.value })} />
                  </label>
                  <label>
                    <span>Категория</span>
                    <input value={product.category} onChange={(event) => updateProduct(product.id, { category: event.target.value })} />
                  </label>
                  <label>
                    <span>Подкатегория</span>
                    <input value={product.subcategory} onChange={(event) => updateProduct(product.id, { subcategory: event.target.value })} />
                  </label>
                  <label>
                    <span>Бренд</span>
                    <input value={product.brand} onChange={(event) => updateProduct(product.id, { brand: event.target.value })} />
                  </label>
                  <label>
                    <span>Артикул</span>
                    <input value={product.article} onChange={(event) => updateProduct(product.id, { article: event.target.value })} />
                  </label>
                  <label>
                    <span>Модель</span>
                    <input value={product.model} onChange={(event) => updateProduct(product.id, { model: event.target.value })} />
                  </label>
                  <label>
                    <span>Ценовая группа</span>
                    <input value={product.priceGroup} onChange={(event) => updateProduct(product.id, { priceGroup: event.target.value })} />
                  </label>
                  <label>
                    <span>EUR</span>
                    <input value={product.priceEur} onChange={(event) => updateProduct(product.id, { priceEur: event.target.value })} />
                  </label>
                  <label>
                    <span>RUB</span>
                    <input value={product.priceRub} onChange={(event) => updateProduct(product.id, { priceRub: event.target.value })} />
                  </label>
                  <label>
                    <span>CNY</span>
                    <input value={product.priceCny} onChange={(event) => updateProduct(product.id, { priceCny: event.target.value })} />
                  </label>
                  <label>
                    <span>Общая скидка</span>
                    <input value={product.generalDiscount} onChange={(event) => updateProduct(product.id, { generalDiscount: event.target.value })} />
                  </label>
                  <label>
                    <span>Ручная скидка</span>
                    <input value={product.manualDiscount} onChange={(event) => updateProduct(product.id, { manualDiscount: event.target.value })} />
                  </label>
                  <label>
                    <span>Ручная скидка РОП</span>
                    <input value={product.manualDiscountRop} onChange={(event) => updateProduct(product.id, { manualDiscountRop: event.target.value })} />
                  </label>
                  <label>
                    <span>Остаток</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={product.stock}
                      onChange={(event) => updateProduct(product.id, { stock: Math.max(0, Number(event.target.value) || 0) })}
                    />
                  </label>
                </div>
                <div className={styles.catalogProductMeta}>
                  <label className={styles.userActiveToggle}>
                    <input
                      type="checkbox"
                      checked={product.isActive}
                      onChange={(event) => updateProduct(product.id, { isActive: event.target.checked })}
                    />
                    Активен
                  </label>
                  <label className={styles.userActiveToggle}>
                    <input
                      type="checkbox"
                      checked={product.isExpected}
                      onChange={(event) => updateProduct(product.id, { isExpected: event.target.checked })}
                    />
                    Ожидается
                  </label>
                  <div className={styles.userAccessBadges}>
                    <span>{product.brand || 'Без бренда'}</span>
                    <span>{product.category || 'Без категории'}</span>
                    <span>{product.subcategory || 'Без подкатегории'}</span>
                    {product.model ? <span>Модель: {product.model}</span> : null}
                    <span>Арт.: {product.article || '-'}</span>
                    <span>
                      {product.stock > 0
                        ? `В наличии: ${product.stock} ${product.unit?.trim() || 'шт.'}`
                        : product.isExpected
                          ? 'Ожидается поступление'
                          : 'Под заказ'}
                    </span>
                  </div>
                  <div className={styles.userAccessActions}>
                    <button
                      className={savedId === String(product.id) ? styles.savedButton : undefined}
                      disabled={busyId === String(product.id)}
                      onClick={() => saveProduct(product)}
                    >
                      {savedId === String(product.id) ? 'Сохранено' : 'Сохранить'}
                    </button>
                    <button className={styles.danger} disabled={busyId === String(product.id)} onClick={() => deleteProduct(product)}>
                      Удалить
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
