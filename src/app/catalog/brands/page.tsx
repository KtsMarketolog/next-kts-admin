import BrandGrid from '@/widgets/catalog/BrandGrid';
import { CatalogSeo } from '@/widgets/catalog/CatalogSeo';
import {
  fetchAllBrands,
  fetchBrandSubcategories,
  fetchCategories,
  fetchPopularBrands,
} from '@/entities/catalog/api/catalogApi';
import { hasUnsupportedCatalogQuery } from '@/entities/catalog/api/catalogSeo';
import { buildCatalogCollectionJsonLd } from '@/entities/catalog/lib/catalogStructuredData';
import { PUBLIC_CATALOG_CACHE_TAG } from '@/entities/catalog/api/catalogRevalidation';
import { createPageMetadata } from '@/shared/lib/seo/metadata';
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

const title = 'Бренды холодильного оборудования';
const description =
  'Бренды холодильного оборудования, автоматики и комплектующих, представленные в каталоге КТС.';

type SearchParams = { [key: string]: string | string[] | undefined };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  return createPageMetadata({
    title,
    description,
    path: '/catalog/brands',
    index: !hasUnsupportedCatalogQuery(query, false),
  });
}

export default async function BrandsRootPage() {
  const { catTitleBySlug, enriched } = await getBrandsRootData();
  const jsonLd = buildCatalogCollectionJsonLd({
    name: title,
    description,
    path: '/catalog/brands',
    breadcrumbs: [
      { name: 'Главная', path: '/' },
      { name: 'Каталог', path: '/catalog' },
      { name: 'Бренды', path: '/catalog/brands' },
    ],
    items: enriched.map((brand) => ({
      name: brand.title,
      path: `/catalog/brands/${brand.slug}`,
    })),
  });

  return (
    <>
      <CatalogSeo heading={title} jsonLd={jsonLd} />
      <BrandGrid
        items={enriched}
        baseHref="/catalog/brands"
        includeAll
        heading="Популярные бренды"
        catTitleBySlug={catTitleBySlug}
      />
    </>
  );
}
