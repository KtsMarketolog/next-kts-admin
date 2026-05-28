import type { WholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';

export type Manager = {
  id: number;
  name: string;
  login: string;
  email: string;
  phone: string;
  role: 'manager' | 'support_manager';
  supportManagerId: number | null;
  supportManagerName: string;
  isActive: boolean;
  priceListCount: number;
  password?: string;
  displayPassword: string;
};

export type ManagerRole = Manager['role'];

export type ClientCompanyOption = {
  id: number;
  title: string;
  isActive: boolean;
};

export type ManagerDraft = {
  name: string;
  login: string;
  email: string;
  phone: string;
  supportManagerId: number | null;
  password: string;
  isActive: boolean;
};

export type PriceList = {
  id: number;
  title: string;
  clientCompanyId: number | null;
  clientName: string;
  token: string;
  validUntil: string | null;
  workflowStatus: WholesalePriceWorkflowStatus;
  workflowStatusLabel: string;
  showRetailPrices: boolean;
  showStock: boolean;
  showStockText: boolean;
  isActive: boolean;
  managerId: number | null;
  managerName: string | null;
  itemCount: number;
  priceGroupCount: number;
  createdAt: string;
  updatedAt: string;
  lastChangedAt: string | null;
  lastChangedTitle: string | null;
  lastChangedByName: string | null;
};

export type CatalogVariant = {
  id: number | null;
  title: string;
  retailPrice: string | null;
  wholesalePrice: string | null;
};

export type CatalogProduct = {
  id: number;
  title: string;
  sku: string;
  description: string;
  imageUrl: string | null;
  priceGroup: string;
  priceGroupImageUrl: string | null;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
  generalDiscount: string | null;
  manualDiscount: string | null;
  manualDiscountRop: string | null;
  stock: number;
  unit: string | null;
  isExpected: boolean;
  stockUpdatedAt: string | null;
  variants: CatalogVariant[];
};

export type CatalogCategory = {
  id: number;
  title: string;
  products: CatalogProduct[];
};

export type PriceItem = {
  productId: number;
  variantId: number | null;
  customWholesalePrice: string | null;
  visible: boolean;
  sortOrder: number;
};

export type PriceGroupStockSetting = {
  priceGroup: string;
  showStock: boolean;
  showStockText: boolean;
};

export type PriceEditor = {
  id?: number;
  title: string;
  clientCompanyId: number | null;
  clientName: string;
  token: string;
  validUntil: string;
  comment: string;
  workflowStatus: WholesalePriceWorkflowStatus;
  showRetailPrices: boolean;
  showStock: boolean;
  showStockText: boolean;
  isActive: boolean;
  managerId: number | null;
  supportManagerId: number | null;
  items: PriceItem[];
  priceGroupStockSettings: Record<string, PriceGroupStockSetting>;
};

export type AdminWholesaleGatewayProps = {
  canManageWholesale?: boolean;
  onBack: () => void;
};

export type CurrentManager = {
  id: number;
  name: string;
  login: string;
  email: string;
  phone: string;
};
