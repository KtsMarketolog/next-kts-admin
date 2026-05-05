export type Slide = {
  id: number;
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
  date: string;
  title: string;
  imageUrl: string;
  linkUrl: string;
  sortOrder: number;
  isActive: boolean;
};

export type GroupCompany = {
  id: number;
  imageUrl: string;
  sortOrder: number;
  isActive: boolean;
};

export type BrandCategory = {
  id: number;
  key: string;
  title: string;
  sortOrder: number;
  isActive: boolean;
};

export type Brand = {
  id: number;
  categoryId: number;
  name: string;
  imageUrl: string;
  iconKey: string;
  sortOrder: number;
  isActive: boolean;
};

export type AdminSection = 'info' | 'slider' | 'news' | 'groupCompanies' | 'brands' | 'users';

export type SettingKey = 'phone' | 'email' | 'address';
