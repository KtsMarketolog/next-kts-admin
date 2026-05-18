import BrandGrid from '@/widgets/catalog/BrandGrid';
import {
  fetchAllBrands,
  fetchBrandSubcategories,
  fetchCategories,
  fetchPopularBrands,
} from '@/entities/catalog/api/catalogApi';
import { PUBLIC_CATALOG_CACHE_TAG } from '@/entities/catalog/api/catalogRevalidation';
import { unstable_cache } from 'next/cache';

export const revalidate = 60;
export const dynamic = 'force-dynamic';

const getBrandsRootData = unstable_cache(
  async () => {
    let brands = await fetchPopularBrands();
    if (!brands.length) brands = await fetchAllBrands();

    const categories = await fetchCategories();
    const catTitleBySlug = Object.fromEntries(
      categories.map((category) => [category.slug, category.title]),
    );

    const enriched = await Promise.all(
      brands.map(async (brand) => ({
        ...brand,
        subs: (await fetchBrandSubcategories(brand.slug)).map((subcategory) => ({
          slug: subcategory.slug,
          title: subcategory.title,
          category: subcategory.category,
        })),
        logo: brand.logo ?? null,
      })),
    );

    return { catTitleBySlug, enriched };
  },
  ['catalog-brands-root'],
  {
    revalidate: 60,
    tags: [PUBLIC_CATALOG_CACHE_TAG],
  },
  );

export default async function BrandsRootPage() {
  const { catTitleBySlug, enriched } = await getBrandsRootData();

  return (
    <BrandGrid
      items={enriched}
      baseHref="/catalog/brands"
      includeAll
      heading="Популярные бренды"
      catTitleBySlug={catTitleBySlug}
    />
  );
}
