import type { PriceListAnalogLink } from '../analogs';
import type { WholesaleStockDisplayMode } from '../wholesaleStockDisplay';

export type PublicWholesaleVariant = {
  priceItemId: number;
  id: number | null;
  title: string;
  retailPrice: string | null;
  retailPriceEur: string | null;
  retailPriceRub: string | null;
  retailPriceCny: string | null;
  wholesalePrice: string | null;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
};

export type PublicWholesaleProduct = {
  id: number;
  title: string;
  sku: string;
  model: string;
  description: string;
  priceGroup: string;
  priceGroupImageUrl: string | null;
  imageUrl: string | null;
  stock: number;
  stockVolzhsk: number;
  stockMoscow: number;
  unit: string | null;
  isExpected: boolean;
  stockDisplayMode: WholesaleStockDisplayMode;
  stockUpdatedAt: string | null;
  analogs: PriceListAnalogLink[];
  variants: PublicWholesaleVariant[];
};

export type PublicWholesaleCategory = {
  id: number;
  title: string;
  products: PublicWholesaleProduct[];
};

export type PublicWholesalePriceList = {
  /** Exact source snapshot version, for derived export caches; never a write revision. */
  cacheRevision?: string;
  id: number;
  clientCompanyId: number | null;
  title: string;
  token: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  managerEmail: string;
  managerPhone: string;
  supportManagerId: number | null;
  supportManagerName: string;
  supportManagerEmail: string;
  supportManagerPhone: string;
  validUntil: string | null;
  updatedAt: string;
  showRetailPrices: boolean;
  showStock: boolean;
  showStockText: boolean;
  categories: PublicWholesaleCategory[];
};

export type PublicWholesalePriceMetadata = Omit<PublicWholesalePriceList, 'categories' | 'cacheRevision'>;

/** Raw rows from one read-only repeatable-read database snapshot. */
export type PriceItemRow = {
  item_id: string;
  category_id: string | null;
  category_title: string | null;
  product_id: string;
  product_title: string;
  sku: string;
  model: string | null;
  series_description: string;
  price_group: string | null;
  price_group_image_url: string | null;
  image_url: string | null;
  stock: string | null;
  stock_volzhsk: string | null;
  stock_moscow: string | null;
  unit: string | null;
  is_expected: boolean | null;
  group_show_stock_numbers: boolean | null;
  group_show_stock_text: boolean | null;
  stock_updated_at: string | null;
  variant_id: string | null;
  variant_title: string | null;
  retail_price: string | null;
  retail_price_eur: string | null;
  retail_price_rub: string | null;
  retail_price_cny: string | null;
  wholesale_price: string | null;
  price_eur: string | null;
  price_rub: string | null;
  price_cny: string | null;
};

export type PriceBuildInput = {
  metadata: PublicWholesalePriceMetadata;
  rows: PriceItemRow[];
  includeAnalogs: boolean;
  revision: string;
};

export type PriceBuildTimings = {
  assemblyMs: number;
  analogsMs: number;
  serializationMs: number;
  totalMs: number;
};

export type PriceBuildResult = {
  price: PublicWholesalePriceList;
  /** Binary v8 serialization for a private, derived cache; never a public asset. */
  serialized: Uint8Array;
  /** Exact serialized size, computed off the request/event-loop thread. */
  cacheBytes: number;
  timings: PriceBuildTimings;
  /** These two measurements run on the caller, not inside the worker. */
  mainThreadTimings?: { inputTransferMs: number; deserializationMs: number };
};

export type PriceBuildWorkerMessage =
  | { ok: true; result: Omit<PriceBuildResult, 'price'> }
  | { ok: false };
