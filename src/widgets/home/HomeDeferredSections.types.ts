import type { GroupCompany } from '@/entities/site/model/defaultGroupCompanies';
import type { NewsItem } from '@/entities/site/model/defaultNews';

export type HomeBrandCategory = {
  id: number;
  key: string;
  title: string;
  sortOrder?: number;
  isActive?: boolean;
};

export type HomeBrandItem = {
  id: number;
  categoryId: number;
  name: string;
  imageUrl?: string | null;
  iconKey?: string;
  sortOrder?: number;
  isActive?: boolean;
};

export type HomeDeferredSectionsProps = {
  groupCompanies: GroupCompany[];
  news: NewsItem[];
  brandCategories: HomeBrandCategory[];
  brandBrands: HomeBrandItem[];
};
