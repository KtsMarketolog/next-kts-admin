export type CatalogProductInput = {
  title: string;
  article?: string | null;
  model?: string | null;
  brand?: string | null;
  category?: string | null;
  subcategory?: string | null;
  priceGroup?: string | null;
  unit?: string | null;
  priceEur?: string | number | null;
  priceRub?: string | number | null;
  priceCny?: string | number | null;
  generalDiscount?: string | number | null;
  manualDiscount?: string | number | null;
  manualDiscountRop?: string | number | null;
  stock?: string | number | null;
  isExpected?: boolean | null;
  isActive?: boolean;
};

export type CatalogAdminProduct = {
  id: number;
  title: string;
  article: string;
  model: string;
  brand: string;
  category: string;
  subcategory: string;
  priceGroup: string;
  unit: string | null;
  priceEur: string;
  priceRub: string;
  priceCny: string;
  generalDiscount: string;
  manualDiscount: string;
  manualDiscountRop: string;
  stock: number;
  isExpected: boolean;
  stockUpdatedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CatalogAdminStats = {
  products: number;
  activeProducts: number;
  categories: number;
  subcategories: number;
  brands: number;
};

export type CatalogAdminCategory = {
  id: number;
  title: string;
  slug: string;
  iconUrl: string;
  productCount: number;
  isActive: boolean;
  showOnSite: boolean;
};

export type CatalogAdminProductFilters = {
  search?: string | null;
  category?: string | null;
  subcategory?: string | null;
  brand?: string | null;
  active?: 'all' | 'active' | 'inactive' | null;
  limit?: number | null;
};

export type CatalogAdminFilterOptionFilters = Pick<CatalogAdminProductFilters, 'category' | 'subcategory' | 'brand'>;

export type CatalogAdminFilterOptions = {
  categories: string[];
  subcategories: string[];
  brands: string[];
};

export type CatalogImportResult = CatalogAdminStats & {
  importedProducts: number;
  syncedWholesaleProducts: number;
};
