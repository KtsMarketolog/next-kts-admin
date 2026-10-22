'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AdminRequestError, ADMIN_UPLOAD_TIMEOUT_MS } from '../shared/adminRequest';
import { useAdminRequestScope } from '../shared/useAdminRequestScope';

import { productPayload } from './AdminCatalogHelpers';
import { AdminCatalogView } from './AdminCatalogView';
import type { CatalogImportError } from './AdminCatalogImportPanel';
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
  const { request, isActive } = useAdminRequestScope();
  const busyRef = useRef(false);
  const catalogReadRef = useRef<AbortController | null>(null);
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
  const [importError, setImportError] = useState<CatalogImportError | null>(null);
  const [stockLogs, setStockLogs] = useState<StockImportLog[]>([]);
  const [stockHistoryExpanded, setStockHistoryExpanded] = useState(false);

  const loadCatalog = useCallback(async (nextSearch = '', nextFilters: CatalogFilters = EMPTY_FILTERS, propagateError = false) => {
    catalogReadRef.current?.abort();
    const controller = new AbortController();
    catalogReadRef.current = controller;
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
      const response = await request(`/api/admin/catalog/products?${params.toString()}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        throw new Error(await readError(response, 'Не удалось загрузить каталог'));
      }
      const data = await response.json();
      if (!Array.isArray(data.products)) throw new Error('Каталог получен не полностью. Повторите загрузку.');
      if (controller.signal.aborted) return;
      setProducts(data.products);
      setStats(data.stats ?? null);
      setFilterOptions({
        categories: Array.isArray(data.filterOptions?.categories) ? data.filterOptions.categories : [],
        subcategories: Array.isArray(data.filterOptions?.subcategories) ? data.filterOptions.subcategories : [],
        brands: Array.isArray(data.filterOptions?.brands) ? data.filterOptions.brands : [],
      });
    } catch (error) {
      if (propagateError) throw error;
      if (!controller.signal.aborted && isActive()) {
        showStatus(error instanceof Error ? error.message : 'Не удалось загрузить каталог');
      }
    } finally {
      if (catalogReadRef.current === controller) setLoading(false);
    }
  }, [isActive, request, showStatus]);

  useEffect(() => {
    void loadCatalog('');
  }, [loadCatalog]);

  const loadStockLogs = useCallback(async () => {
    const response = await request('/api/admin/stock-import/logs?limit=10', { cache: 'no-store' });
    if (!response.ok) throw new Error('Не удалось обновить отображение журнала импорта');
    const data = await response.json();
    setStockLogs(Array.isArray(data.logs) ? data.logs : []);
  }, [request]);

  const runMutation = async (id: string, action: () => Promise<void>) => {
    // State alone does not stop two clicks before React renders the disabled button.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(id);
    try {
      await action();
    } catch (error) {
      if (!isActive()) return;
      showStatus(error instanceof AdminRequestError ? error.message : 'Не удалось получить подтверждение операции. Изменения могли сохраниться. Обновите данные перед повторной попыткой.');
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  };

  const refreshAfterSave = async (success: string, nextSearch = search) => {
    try {
      await loadCatalog(nextSearch, filters, true);
      showStatus(success);
    } catch {
      if (!isActive()) return;
      showStatus(`${success}, но список не обновился. Обновите каталог; повторно сохранять не нужно.`);
    }
  };

  useEffect(() => {
    void loadStockLogs().catch(() => {});
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
    await runMutation('import', async () => {
      setImportResult(''); setImportError(null);
      try {
        const response = await request('/api/admin/catalog/import', { method: 'POST', body: formData }, { timeoutMs: ADMIN_UPLOAD_TIMEOUT_MS });
        if (!isActive()) return;

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          const message = typeof data.error === 'string' ? data.error : 'Не удалось загрузить Excel';
          const isExcelDuplicate = response.status === 400 && data.code === 'CATALOG_DUPLICATE_ARTICLES';
          const isExistingDuplicate = response.status === 409 && data.code === 'CATALOG_EXISTING_DUPLICATE_ARTICLES';
          const duplicates = isExcelDuplicate && Array.isArray(data.duplicates)
            ? data.duplicates.slice(0, 100).filter((item: unknown): item is { article: string; rows: number[]; totalRows: number } => {
              if (!item || typeof item !== 'object') return false;
              const group = item as Record<string, unknown>;
              return typeof group.article === 'string' && Array.isArray(group.rows) && group.rows.every((row) => Number.isSafeInteger(row) && row > 0)
                && Number.isSafeInteger(group.totalRows) && Number(group.totalRows) >= group.rows.length;
            }).map((group: { article: string; rows: number[]; totalRows: number }) => ({ ...group, rows: group.rows.slice(0, 100) })) : undefined;
          setImportError({ message, unchanged: isExcelDuplicate || isExistingDuplicate,
            duplicates, duplicateCount: Number.isSafeInteger(data.duplicateCount) ? data.duplicateCount : duplicates?.length,
            truncated: data.truncated === true });
          showStatus(message);
          return;
        }

        const data = await response.json();
        const result = data.result;
        if (!result || !Number.isSafeInteger(result.importedProducts) || result.importedProducts < 0) throw new Error('Missing import result');
        const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : 'недоступно';
        const warnings = Array.isArray(data.warnings)
          ? data.warnings.map((warning: { message?: string } | null) => warning?.message).filter((message: unknown): message is string => typeof message === 'string')
          : [];
        const summary = `Загружено: ${result.importedProducts}; категорий: ${count(result.categories)}; подкатегорий: ${count(result.subcategories)}; брендов: ${count(result.brands)}`;
        setImportResult([summary, ...warnings].join(' ')); setImportError(null);
        setFileName('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        await refreshAfterSave(['Каталог загружен из Excel', ...warnings].join('. '), '');
      } catch (error) {
        if (isActive()) setImportError({ message: error instanceof AdminRequestError ? error.message
          : 'Не удалось получить подтверждение операции. Изменения могли сохраниться. Обновите данные перед повторной попыткой.' });
        throw error;
      }
    });
  };

  const checkStockEmail = async () => {
    await runMutation('stock-email', async () => {
      const response = await request('/api/admin/stock-import/check-email', { method: 'POST' }, { timeoutMs: ADMIN_UPLOAD_TIMEOUT_MS });

      if (!response.ok) {
        showStatus(await readError(response, 'Не удалось проверить почту с остатками'));
        return;
      }

      const data = await response.json();
      if (data.status === 'busy') {
        showStatus('Импорт остатков уже выполняется. Повторная проверка пропущена; письма не изменены.');
        return;
      }
      const warnings = Array.isArray(data.warnings)
        ? data.warnings.map((warning: { message?: string }) => warning.message).filter((message: unknown): message is string => typeof message === 'string')
        : [];
      await loadStockLogs().catch(() => {
        warnings.push('Результат проверки получен, но список журнала не обновился. Обновите страницу; повторно импортировать файл не нужно.');
      });
      if (!isActive()) return;
      const statusWithWarnings = (message: string) => showStatus([message, ...warnings].join(' '));
      if (!data.processed) {
        const skipped = data.skipped ?? {};
        const firstSample = Array.isArray(skipped.samples) ? skipped.samples[0] : null;
        const checkedMessages = Number(data.checkedMessages ?? 0);
        const settings = data.settings ?? {};
        if (checkedMessages > 0 && firstSample?.reason === 'sender') {
          statusWithWarnings(
            `Найдено писем: ${checkedMessages}, но отправитель не разрешён: ${firstSample?.from || 'не указан'}. Добавьте его в STOCK_MAIL_ALLOWED_FROM.`,
          );
          return;
        }
        if (checkedMessages > 0 && firstSample?.reason === 'subject') {
          statusWithWarnings(`Найдено писем: ${checkedMessages}, но тема не содержит "${settings.subjectPart}".`);
          return;
        }
        if (checkedMessages > 0 && firstSample?.reason === 'attachment') {
          const files = Array.isArray(firstSample?.attachments) ? firstSample.attachments.filter(Boolean).join(', ') : '';
          statusWithWarnings(
            `Найдено писем: ${checkedMessages}, но нет подходящего .xlsx с префиксом "${settings.filePrefix || 'Остатки'}"${files ? `; вложения: ${files}` : ''}.`,
          );
          return;
        }
        statusWithWarnings('Новых писем с остатками нет');
        return;
      }

      const result = data.result;
      statusWithWarnings(result?.alreadyApplied
        ? 'Это письмо уже обработано. Остатки повторно не изменялись.'
        : result?.status === 'failed'
          ? `Остатки не изменены. Результат проверки записан в журнал; ошибок: ${result?.failedRows ?? 0}, не найдено: ${result?.notFoundRows ?? 0}.`
          : `Остатки сохранены: ${result?.updatedRows ?? 0}, ошибок: ${result?.failedRows ?? 0}.`);
    });
  };

  const createProduct = async () => {
    await runMutation('new', async () => {
      const response = await request('/api/admin/catalog/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productPayload(draft)),
      });

      if (!response.ok) {
        showStatus(await readError(response, 'Не удалось добавить товар'));
        return;
      }

      const data = await response.json();
      if (!data.product) throw new Error('Missing saved product');
      setProducts((current) => [data.product, ...current].slice(0, CATALOG_PRODUCT_PAGE_LIMIT));
      setDraft(EMPTY_DRAFT);
      markSaved('new');
      await refreshAfterSave('Товар добавлен');
    });
  };

  const saveProduct = async (product: CatalogProduct) => {
    await runMutation(String(product.id), async () => {
      const response = await request(`/api/admin/catalog/products/${product.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productPayload(product)),
      });

      if (!response.ok) {
        showStatus(await readError(response, 'Не удалось сохранить товар'));
        return;
      }

      const data = await response.json();
      if (!data.product) throw new Error('Missing saved product');
      setProducts((current) => current.map((item) => (item.id === product.id ? data.product : item)));
      markSaved(String(product.id));
      await refreshAfterSave('Товар сохранён');
    });
  };

  const deleteProduct = async (product: CatalogProduct) => {
    if (!window.confirm(`Удалить товар "${product.title}"?`)) return;
    await runMutation(String(product.id), async () => {
      const response = await request(`/api/admin/catalog/products/${product.id}`, { method: 'DELETE' });

      if (!response.ok) {
        showStatus(await readError(response, 'Не удалось удалить товар'));
        return;
      }

      setProducts((current) => current.filter((item) => item.id !== product.id));
      await refreshAfterSave('Товар удалён');
    });
  };

  const visibleStockLogs = stockHistoryExpanded ? stockLogs : stockLogs.slice(0, 1);
  const hiddenStockLogCount = Math.max(stockLogs.length - 1, 0);

  return (
    <AdminCatalogView
      stats={stats}
      fileInputRef={fileInputRef}
      importExcel={importExcel}
      importResult={importResult}
      importError={importError}
      fileName={fileName}
      setFileName={(value) => { setFileName(value); setImportError(null); setImportResult(''); }}
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
