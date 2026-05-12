'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';

type CatalogProduct = {
  id: number;
  title: string;
  article: string;
  brand: string;
  category: string;
  subcategory: string;
  priceGroup: string;
  priceEur: string;
  priceRub: string;
  priceCny: string;
  stock: number;
  isExpected: boolean;
  stockUpdatedAt?: string | null;
  isActive: boolean;
};

type CatalogStats = {
  products: number;
  activeProducts: number;
  categories: number;
  subcategories: number;
  brands: number;
};

type CatalogDraft = Omit<CatalogProduct, 'id'>;

type CatalogFilterOptions = {
  categories: string[];
  subcategories: string[];
  brands: string[];
};

type StockImportLog = {
  logId: number | null;
  createdAt: string;
  fileName: string;
  emailFrom: string;
  emailSubject: string;
  status: 'success' | 'partial_success' | 'failed';
  totalRows: number;
  updatedRows: number;
  notFoundRows: number;
  failedRows: number;
  errors: { row: number; name: string; error: string }[];
};

type CatalogFilters = {
  active: 'all' | 'active' | 'inactive';
  category: string;
  subcategory: string;
  brand: string;
};

type AdminCatalogSectionProps = {
  showStatus: (message: string) => void;
};

const EMPTY_DRAFT: CatalogDraft = {
  title: '',
  article: '',
  brand: '',
  category: '',
  subcategory: '',
  priceGroup: '',
  priceEur: '',
  priceRub: '',
  priceCny: '',
  stock: 0,
  isExpected: false,
  isActive: true,
};

const EMPTY_FILTERS: CatalogFilters = {
  active: 'all',
  category: '',
  subcategory: '',
  brand: '',
};

const CATALOG_PRODUCT_PAGE_LIMIT = 100;

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

function optionValues(items: string[], selected = '') {
  const uniqueItems = Array.from(new Set(items.filter(Boolean)));
  return selected && !uniqueItems.includes(selected) ? [selected, ...uniqueItems] : uniqueItems;
}

function productPayload(product: CatalogDraft | CatalogProduct) {
  return {
    title: product.title,
    article: product.article,
    brand: product.brand,
    category: product.category,
    subcategory: product.subcategory,
    priceGroup: product.priceGroup,
    priceEur: product.priceEur,
    priceRub: product.priceRub,
    priceCny: product.priceCny,
    stock: product.stock,
    isExpected: product.isExpected,
    isActive: product.isActive,
  };
}

function stockLogStatusText(status: StockImportLog['status']) {
  if (status === 'success') return 'Успешно';
  if (status === 'partial_success') return 'Частично';
  return 'Ошибка';
}

function stockLogStatusClass(status: StockImportLog['status']) {
  if (status === 'success') return styles.stockLogStatusSuccess;
  if (status === 'partial_success') return styles.stockLogStatusPartial;
  return styles.stockLogStatusFailed;
}

function formatStockLogDate(value: string) {
  return new Date(value).toLocaleString('ru-RU');
}

function renderCatalogSkeleton() {
  return (
    <div className={styles.catalogSkeletonList} aria-busy="true" aria-label="Загрузка каталога">
      {Array.from({ length: 4 }, (_, cardIndex) => (
        <article className={styles.catalogProductCard} key={cardIndex}>
          <div className={styles.catalogProductFields}>
            {Array.from({ length: 10 }, (_, fieldIndex) => (
              <div className={styles.skeletonField} key={fieldIndex}>
                <span className={styles.skeletonLabelLine} />
                <span className={styles.skeletonInputLine} />
              </div>
            ))}
          </div>
          <div className={styles.catalogProductMeta}>
            <span className={styles.skeletonInputLine} />
            <span className={styles.skeletonInputLine} />
            <span className={styles.skeletonInputLine} />
          </div>
        </article>
      ))}
    </div>
  );
}

export function AdminCatalogSection({ showStatus }: AdminCatalogSectionProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [filterOptions, setFilterOptions] = useState<CatalogFilterOptions>({ categories: [], subcategories: [], brands: [] });
  const [filters, setFilters] = useState<CatalogFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<CatalogDraft>(EMPTY_DRAFT);
  const [search, setSearch] = useState('');
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string>('');
  const [stockLogs, setStockLogs] = useState<StockImportLog[]>([]);
  const [stockHistoryExpanded, setStockHistoryExpanded] = useState(false);

  const loadCatalog = useCallback(async (nextSearch = '', nextFilters: CatalogFilters = EMPTY_FILTERS) => {
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(CATALOG_PRODUCT_PAGE_LIMIT),
      search: nextSearch,
      active: nextFilters.active,
      category: nextFilters.category,
      subcategory: nextFilters.subcategory,
      brand: nextFilters.brand,
    });
    try {
      const response = await fetch(`/api/admin/catalog/products?${params.toString()}`, { cache: 'no-store' });
      if (!response.ok) {
        showStatus(await readError(response, 'Не удалось загрузить каталог'));
        return;
      }
      const data = await response.json();
      setProducts(Array.isArray(data.products) ? data.products : []);
      setStats(data.stats ?? null);
      setFilterOptions({
        categories: Array.isArray(data.filterOptions?.categories) ? data.filterOptions.categories : [],
        subcategories: Array.isArray(data.filterOptions?.subcategories) ? data.filterOptions.subcategories : [],
        brands: Array.isArray(data.filterOptions?.brands) ? data.filterOptions.brands : [],
      });
    } catch {
      showStatus('Не удалось загрузить каталог');
    } finally {
      setLoading(false);
    }
  }, [showStatus]);

  useEffect(() => {
    void loadCatalog('');
  }, [loadCatalog]);

  const loadStockLogs = useCallback(async () => {
    const response = await fetch('/api/admin/stock-import/logs?limit=10', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    setStockLogs(Array.isArray(data.logs) ? data.logs : []);
  }, []);

  useEffect(() => {
    void loadStockLogs();
  }, [loadStockLogs]);

  const markSaved = (id: string) => {
    setSavedId(id);
    window.setTimeout(() => {
      setSavedId((current) => (current === id ? null : current));
    }, 1800);
  };

  const updateProduct = (id: number, patch: Partial<CatalogProduct>) => {
    setProducts((current) => current.map((product) => (product.id === id ? { ...product, ...patch } : product)));
  };

  const applyFilters = (patch: Partial<CatalogFilters>) => {
    const nextFilters = { ...filters, ...patch };
    setFilters(nextFilters);
    void loadCatalog(search, nextFilters);
  };

  const importExcel = async (event: FormEvent) => {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      showStatus('Выберите Excel-файл');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);
    setBusyId('import');
    const response = await fetch('/api/admin/catalog/import', { method: 'POST', body: formData });
    setBusyId(null);

    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось загрузить Excel'));
      return;
    }

    const data = await response.json();
    const result = data.result;
    const summary = `Загружено: ${result?.importedProducts ?? 0}; категорий: ${result?.categories ?? 0}; подкатегорий: ${result?.subcategories ?? 0}; брендов: ${result?.brands ?? 0}`;
    setImportResult(summary);
    setFileName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    await loadCatalog('', filters);
    showStatus('Каталог загружен из Excel');
  };

  const checkStockEmail = async () => {
    setBusyId('stock-email');
    const response = await fetch('/api/admin/stock-import/check-email', { method: 'POST' });
    setBusyId(null);

    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось проверить почту с остатками'));
      return;
    }

    const data = await response.json();
    await loadStockLogs();
    if (!data.processed) {
      const skipped = data.skipped ?? {};
      const firstSample = Array.isArray(skipped.samples) ? skipped.samples[0] : null;
      const checkedMessages = Number(data.checkedMessages ?? 0);
      const settings = data.settings ?? {};
      if (checkedMessages > 0 && firstSample?.reason === 'sender') {
        showStatus(
          `Найдено писем: ${checkedMessages}, но отправитель не разрешён: ${firstSample?.from || 'не указан'}. Добавьте его в STOCK_MAIL_ALLOWED_FROM.`,
        );
        return;
      }
      if (checkedMessages > 0 && firstSample?.reason === 'subject') {
        showStatus(`Найдено писем: ${checkedMessages}, но тема не содержит "${settings.subjectPart}".`);
        return;
      }
      if (checkedMessages > 0 && firstSample?.reason === 'attachment') {
        const files = Array.isArray(firstSample?.attachments) ? firstSample.attachments.filter(Boolean).join(', ') : '';
        showStatus(
          `Найдено писем: ${checkedMessages}, но нет подходящего .xlsx с префиксом "${settings.filePrefix || 'Остатки'}"${files ? `; вложения: ${files}` : ''}.`,
        );
        return;
      }
      showStatus('Новых писем с остатками нет');
      return;
    }

    const result = data.result;
    showStatus(`Остатки обновлены: ${result?.updatedRows ?? 0}, ошибок: ${result?.failedRows ?? 0}`);
  };

  const createProduct = async () => {
    setBusyId('new');
    const response = await fetch('/api/admin/catalog/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(productPayload(draft)),
    });
    setBusyId(null);

    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось добавить товар'));
      return;
    }

    const data = await response.json();
    if (data.product) {
      setProducts((current) => [data.product, ...current].slice(0, CATALOG_PRODUCT_PAGE_LIMIT));
      setDraft(EMPTY_DRAFT);
      markSaved('new');
      void loadCatalog(search, filters);
      showStatus('Товар добавлен');
    }
  };

  const saveProduct = async (product: CatalogProduct) => {
    setBusyId(String(product.id));
    const response = await fetch(`/api/admin/catalog/products/${product.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(productPayload(product)),
    });
    setBusyId(null);

    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось сохранить товар'));
      return;
    }

    const data = await response.json();
    if (data.product) {
      setProducts((current) => current.map((item) => (item.id === product.id ? data.product : item)));
      markSaved(String(product.id));
      void loadCatalog(search, filters);
      showStatus('Товар сохранён');
    }
  };

  const deleteProduct = async (product: CatalogProduct) => {
    if (!window.confirm(`Удалить товар "${product.title}"?`)) return;
    setBusyId(String(product.id));
    const response = await fetch(`/api/admin/catalog/products/${product.id}`, { method: 'DELETE' });
    setBusyId(null);

    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось удалить товар'));
      return;
    }

    setProducts((current) => current.filter((item) => item.id !== product.id));
    void loadCatalog(search, filters);
    showStatus('Товар удалён');
  };

  const visibleStockLogs = stockHistoryExpanded ? stockLogs : stockLogs.slice(0, 1);
  const hiddenStockLogCount = Math.max(stockLogs.length - 1, 0);

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
          <p>Импорт полностью заменяет публичный каталог. Категории, подкатегории и бренды из файла добавятся автоматически.</p>
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
          <p>Проверяет последние письма, включая прочитанные, и обновляет только остаток, ожидание поступления и дату обновления. Товары не создаются.</p>
          {stockLogs[0] && (
            <span>
              Последний импорт: {stockLogs[0].status}, обновлено {stockLogs[0].updatedRows} из {stockLogs[0].totalRows}
            </span>
          )}
        </div>
        <div>
          <p>Файл .xlsx: Остатки*.xlsx, колонки Наименование, Остаток/Остатки. Ожидается можно не указывать, тогда будет “нет”.</p>
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
                          Строка {error.row}: {error.name || 'без названия'} — {error.error}
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
        renderCatalogSkeleton()
      ) : products.length === 0 ? (
        <p className={styles.mutedText}>Товары не найдены</p>
      ) : (
        <>
          <p className={styles.mutedText}>Показаны первые {CATALOG_PRODUCT_PAGE_LIMIT} товаров. Для точного поиска используйте строку поиска.</p>
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
                    <span>{product.stock > 0 ? `В наличии: ${product.stock} шт.` : product.isExpected ? 'Скоро поступление' : 'Под заказ'}</span>
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
