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
  isActive: true,
};

const EMPTY_FILTERS: CatalogFilters = {
  active: 'all',
  category: '',
  subcategory: '',
  brand: '',
};

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
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
    isActive: product.isActive,
  };
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

  const loadCatalog = useCallback(async (nextSearch = '', nextFilters: CatalogFilters = EMPTY_FILTERS) => {
    setLoading(true);
    const params = new URLSearchParams({
      limit: '200',
      search: nextSearch,
      active: nextFilters.active,
      category: nextFilters.category,
      subcategory: nextFilters.subcategory,
      brand: nextFilters.brand,
    });
    const response = await fetch(`/api/admin/catalog/products?${params.toString()}`, { cache: 'no-store' });
    setLoading(false);
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
  }, [showStatus]);

  useEffect(() => {
    void loadCatalog('');
  }, [loadCatalog]);

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
      setProducts((current) => [data.product, ...current].slice(0, 200));
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

      <div className={styles.catalogProductForm}>
        <label>
          <span>Наименование</span>
          <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
        </label>
        <label>
          <span>Категория</span>
          <input value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} />
        </label>
        <label>
          <span>Подкатегория</span>
          <input value={draft.subcategory} onChange={(event) => setDraft((current) => ({ ...current, subcategory: event.target.value }))} />
        </label>
        <label>
          <span>Бренд</span>
          <input value={draft.brand} onChange={(event) => setDraft((current) => ({ ...current, brand: event.target.value }))} />
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
          <select value={filters.category} onChange={(event) => applyFilters({ category: event.target.value, subcategory: '' })}>
            <option value="">Все категории</option>
            {filterOptions.categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <select value={filters.subcategory} onChange={(event) => applyFilters({ subcategory: event.target.value })}>
            <option value="">Все подкатегории</option>
            {filterOptions.subcategories.map((subcategory) => (
              <option key={subcategory} value={subcategory}>
                {subcategory}
              </option>
            ))}
          </select>
          <select value={filters.brand} onChange={(event) => applyFilters({ brand: event.target.value })}>
            <option value="">Все бренды</option>
            {filterOptions.brands.map((brand) => (
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
        <p className={styles.mutedText}>Загрузка каталога...</p>
      ) : products.length === 0 ? (
        <p className={styles.mutedText}>Товары не найдены</p>
      ) : (
        <>
          <p className={styles.mutedText}>Показаны первые 200 товаров. Для точного поиска используйте строку поиска.</p>
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
                  <div className={styles.userAccessBadges}>
                    <span>{product.brand || 'Без бренда'}</span>
                    <span>{product.category || 'Без категории'}</span>
                    <span>{product.subcategory || 'Без подкатегории'}</span>
                    <span>Арт.: {product.article || '-'}</span>
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
