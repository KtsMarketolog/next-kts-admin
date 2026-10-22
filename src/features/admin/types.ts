export type Slide = {
  id: number;
  revision?: string;
  title: string;
  imageUrl: string;
  tabletImageUrl: string | null;
  mobileImageUrl: string | null;
  popupImageUrl: string | null;
  popupTabletImageUrl: string | null;
  popupMobileImageUrl: string | null;
  popupTitle: string | null;
  popupText: string | null;
  linkUrl: string | null;
  sortOrder: number;
  isActive: boolean;
};

export type News = {
  id: number;
  revision?: string;
  date: string;
  title: string;
  imageUrl: string;
  linkUrl: string;
  sortOrder: number;
  isActive: boolean;
};

export type GroupCompany = {
  id: number;
  revision?: string;
  imageUrl: string;
  linkUrl: string;
  sortOrder: number;
  isActive: boolean;
};

export type PriceGroupImage = {
  title: string;
  imageUrl: string;
  productCount: number;
};

export type BrandCategory = {
  id: number;
  revision?: string;
  key: string;
  title: string;
  sortOrder: number;
  isActive: boolean;
};

export type Brand = {
  id: number;
  revision?: string;
  categoryId: number;
  name: string;
  imageUrl: string;
  iconKey: string;
  sortOrder: number;
  isActive: boolean;
};

export type AdminSection =
  | 'info'
  | 'slider'
  | 'news'
  | 'groupCompanies'
  | 'brands'
  | 'catalog'
  | 'firmware'
  | 'categories'
  | 'priceGroups'
  | 'users';

export type SettingKey = 'phone' | 'email' | 'address';
