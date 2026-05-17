'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { productPayload } from './AdminCatalogHelpers';
import { AdminCatalogView } from './AdminCatalogView';
import {
  CATALOG_PRODUCT_PAGE_LIMIT,
  EMPTY_DRAFT,
  EMPTY_FILTERS,
  type CatalogDraft,
  type CatalogFilterOptions,
  type CatalogFilters,
  type CatalogProduct,
  type CatalogStats,
  type StockImportLog,
} from './AdminCatalogTypes';

type AdminCatalogSectionProps = {
  showStatus: (message: string) => void;
};

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
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
    <AdminCatalogView
      stats={stats}
      fileInputRef={fileInputRef}
      importExcel={importExcel}
      importResult={importResult}
      fileName={fileName}
      setFileName={setFileName}
      busyId={busyId}
      stockLogs={stockLogs}
      visibleStockLogs={visibleStockLogs}
      hiddenStockLogCount={hiddenStockLogCount}
      stockHistoryExpanded={stockHistoryExpanded}
      setStockHistoryExpanded={setStockHistoryExpanded}
      checkStockEmail={checkStockEmail}
      draft={draft}
      setDraft={setDraft}
      filterOptions={filterOptions}
      savedId={savedId}
      createProduct={createProduct}
      filters={filters}
      applyFilters={applyFilters}
      search={search}
      setSearch={setSearch}
      loadCatalog={loadCatalog}
      loading={loading}
      products={products}
      updateProduct={updateProduct}
      saveProduct={saveProduct}
      deleteProduct={deleteProduct}
    />
  );
}
