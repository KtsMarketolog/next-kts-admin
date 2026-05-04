import type { Brand, BrandCategory, GroupCompany, News, Slide } from '@/features/admin/types';

export const emptySlide: Omit<Slide, 'id'> = {
  title: '',
  imageUrl: '',
  tabletImageUrl: '',
  mobileImageUrl: '',
  popupImageUrl: '',
  popupTabletImageUrl: '',
  popupMobileImageUrl: '',
  popupTitle: '',
  popupText: '',
  linkUrl: '',
  sortOrder: 100,
  isActive: true,
};

export const emptyNews: Omit<News, 'id'> = {
  date: '',
  title: '',
  imageUrl: '',
  linkUrl: '',
  sortOrder: 1,
  isActive: true,
};

export const emptyGroupCompany: Omit<GroupCompany, 'id'> = {
  imageUrl: '',
  sortOrder: 1,
  isActive: true,
};

export const emptyBrandCategory: Omit<BrandCategory, 'id'> = {
  key: '',
  title: '',
  sortOrder: 1,
  isActive: true,
};

export const emptyBrand: Omit<Brand, 'id'> = {
  categoryId: 0,
  name: '',
  imageUrl: '',
  iconKey: '',
  sortOrder: 100,
  isActive: true,
};
