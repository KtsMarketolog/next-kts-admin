import type { Dispatch, FormEvent, RefObject, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';

import { AdminCatalogImportPanel } from './AdminCatalogImportPanel';
import { AdminCatalogProductsPanel } from './AdminCatalogProductsPanel';
import {
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

      <AdminCatalogImportPanel
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
      />

      <AdminCatalogProductsPanel
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
        busyId={busyId}
      />
    </section>
  );
}
