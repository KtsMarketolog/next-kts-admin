export type CatalogProduct = {
  id: number;
  title: string;
  article: string;
  model: string;
  brand: string;
  category: string;
  subcategory: string;
  priceGroup: string;
  unit: string;
  priceEur: string;
  priceRub: string;
  priceCny: string;
  generalDiscount: string;
  manualDiscount: string;
  manualDiscountRop: string;
  stock: number;
  isExpected: boolean;
  stockUpdatedAt?: string | null;
  isActive: boolean;
};

export type CatalogStats = {
  products: number;
  activeProducts: number;
  categories: number;
  subcategories: number;
  brands: number;
};

export type CatalogDraft = Omit<CatalogProduct, 'id'>;

export type CatalogFilterOptions = {
  categories: string[];
  subcategories: string[];
  brands: string[];
};

export type StockImportLog = {
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
  errors: Array<{ row: number; name: string; error: string }>;
};

export type CatalogFilters = {
  active: 'all' | 'active' | 'inactive';
  category: string;
  subcategory: string;
  brand: string;
};

export const EMPTY_DRAFT: CatalogDraft = {
  title: '',
  article: '',
  model: '',
  brand: '',
  category: '',
  subcategory: '',
  priceGroup: '',
  unit: '',
  priceEur: '',
  priceRub: '',
  priceCny: '',
  generalDiscount: '',
  manualDiscount: '',
  manualDiscountRop: '',
  stock: 0,
  isExpected: false,
  isActive: true,
};

export const EMPTY_FILTERS: CatalogFilters = {
  active: 'all',
  category: '',
  subcategory: '',
  brand: '',
};

export const CATALOG_PRODUCT_PAGE_LIMIT = 100;
