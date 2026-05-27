import type { Dispatch, FormEvent, RefObject, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';

import {
  CatalogSkeleton,
  formatStockLogDate,
  optionValues,
  stockLogStatusClass,
  stockLogStatusText,
} from './AdminCatalogHelpers';
import {
  CATALOG_PRODUCT_PAGE_LIMIT,
  type CatalogDraft,
  type CatalogFilterOptions,
  type CatalogFilters,
  type CatalogProduct,
  type CatalogStats,
  type StockImportLog,
} from './AdminCatalogTypes';

type AdminCatalogViewProps = {
  stats: CatalogStats | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  importExcel: (event: FormEvent) => Promise<void>;
  importResult: string;
  fileName: string;
  setFileName: (value: string) => void;
  busyId: string | null;
  stockLogs: StockImportLog[];
  visibleStockLogs: StockImportLog[];
  hiddenStockLogCount: number;
  stockHistoryExpanded: boolean;
  setStockHistoryExpanded: Dispatch<SetStateAction<boolean>>;
  checkStockEmail: () => Promise<void>;
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
};

export function AdminCatalogView({
  stats,
  fileInputRef,
  importExcel,
  importResult,
  fileName,
  setFileName,
  busyId,
  stockLogs,
  visibleStockLogs,
  hiddenStockLogCount,
  stockHistoryExpanded,
  setStockHistoryExpanded,
  checkStockEmail,
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
}: AdminCatalogViewProps) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Каталог</p>
          <h2>Товары каталога</h2>
        </div>
        <span className={styles.headingMeta}>{stats?.products ?? 0} товаров</span>
      </div>

      <div className={styles.catalogStatsGrid}>
        <div>
          <span>Активных</span>
          <strong>{stats?.activeProducts ?? 0}</strong>
        </div>
        <div>
          <span>Категорий</span>
          <strong>{stats?.categories ?? 0}</strong>
        </div>
        <div>
          <span>Подкатегорий</span>
          <strong>{stats?.subcategories ?? 0}</strong>
        </div>
        <div>
          <span>Брендов</span>
          <strong>{stats?.brands ?? 0}</strong>
        </div>
      </div>

      <form className={styles.catalogImportCard} onSubmit={importExcel}>
        <div>
          <h3>Загрузка Excel</h3>
          <p>
            Импорт полностью заменяет публичный каталог. Обязательное поле: Артикул. Дополнительно принимаются EUR, RUB, CNY,
            Общая скидка, Ручная скидка и Ручная скидка роп.
          </p>
          {importResult && <span>{importResult}</span>}
        </div>
        <label className={styles.fileInput}>
          {fileName || 'Выбрать Excel'}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            onChange={(event) => setFileName(event.target.files?.[0]?.name ?? '')}
          />
        </label>
        <button disabled={busyId === 'import'}>{busyId === 'import' ? 'Загрузка...' : 'Загрузить Excel'}</button>
      </form>

      <div className={styles.catalogImportCard}>
        <div>
          <h3>Импорт остатков</h3>
          <p>
            Проверяет последние письма, включая прочитанные, и обновляет только остаток, ожидание поступления и дату
            обновления. Товары не создаются.
          </p>
          {stockLogs[0] && (
            <span>
              Последний импорт: {stockLogs[0].status}, обновлено {stockLogs[0].updatedRows} из {stockLogs[0].totalRows}
            </span>
          )}
        </div>
        <div>
          <p>
            Файл .xlsx: Остатки*.xlsx, колонки Номенклатура.Код, Сейчас, Ожидается и Ед. изм. Артикул в каталоге должен
            совпадать с Номенклатура.Код.
          </p>
        </div>
        <button type="button" disabled={busyId === 'stock-email'} onClick={checkStockEmail}>
          {busyId === 'stock-email' ? 'Проверка...' : 'Проверить почту сейчас'}
        </button>
      </div>

      {stockLogs.length > 0 && (
        <div className={styles.stockLogCard}>
          <div className={styles.stockLogHeader}>
            <div>
              <h3>История импорта остатков</h3>
              <p>Последние проверки почты и результаты обновления остатков.</p>
            </div>
            <div className={styles.stockLogHeaderActions}>
              <span className={styles.stockLogCount}>{stockLogs.length}</span>
              {hiddenStockLogCount > 0 && (
                <button type="button" className={styles.stockLogToggle} onClick={() => setStockHistoryExpanded((current) => !current)}>
                  {stockHistoryExpanded ? 'Скрыть историю' : `Показать ещё ${hiddenStockLogCount}`}
                </button>
              )}
            </div>
          </div>

          <div className={styles.stockLogList}>
            {visibleStockLogs.map((log) => (
              <article className={styles.stockLogItem} key={log.logId ?? `${log.createdAt}-${log.fileName}`}>
                <div className={styles.stockLogMain}>
                  <div>
                    <strong className={styles.stockLogFile}>{log.fileName || 'Файл без названия'}</strong>
                    <span className={styles.stockLogMeta}>{formatStockLogDate(log.createdAt)}</span>
                  </div>
                  <span className={`${styles.stockLogStatus} ${stockLogStatusClass(log.status)}`}>
                    {stockLogStatusText(log.status)}
                  </span>
                </div>

                <div className={styles.stockLogMetrics}>
                  <div className={styles.stockLogMetric}>
                    <span>Строк</span>
                    <strong>{log.totalRows}</strong>
                  </div>
                  <div className={styles.stockLogMetric}>
                    <span>Обновлено</span>
                    <strong>{log.updatedRows}</strong>
                  </div>
                  <div className={styles.stockLogMetric}>
                    <span>Не найдено</span>
                    <strong>{log.notFoundRows}</strong>
                  </div>
                  <div className={styles.stockLogMetric}>
                    <span>Ошибок</span>
                    <strong>{log.failedRows}</strong>
                  </div>
                </div>

                {log.errors.length > 0 && (
                  <details className={styles.stockLogErrors}>
                    <summary>Показать ошибки</summary>
                    <ul>
                      {log.errors.slice(0, 5).map((error, index) => (
                        <li key={`${log.logId ?? log.createdAt}-${index}`}>
                          Строка {error.row}: {error.name || 'без названия'} - {error.error}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            ))}
          </div>
        </div>
      )}

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
            placeholder="Поиск по названию, бренду, категории или артикулу"
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
    </section>
  );
}
