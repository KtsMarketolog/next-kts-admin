import CategoryGrid from '@/widgets/catalog/CategoryGrid';
import { fetchCategories } from '@/entities/catalog/api/catalogApi';
import { PUBLIC_CATALOG_CACHE_TAG } from '@/entities/catalog/api/catalogRevalidation';
import { unstable_cache } from 'next/cache';

export const revalidate = 60;
export const dynamic = 'force-dynamic';

const getCatalogRootCategories = unstable_cache(fetchCategories, ['catalog-root-categories'], {
  revalidate: 60,
  tags: [PUBLIC_CATALOG_CACHE_TAG],
});

export default async function CatalogRootPage() {
  const categories = await getCatalogRootCategories();
  return <CategoryGrid items={categories} />;
}
