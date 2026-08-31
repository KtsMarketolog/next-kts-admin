import CategoryGrid from '@/widgets/catalog/CategoryGrid';
import { CatalogSeo } from '@/widgets/catalog/CatalogSeo';
import { fetchCategories } from '@/entities/catalog/api/catalogApi';
import { hasUnsupportedCatalogQuery } from '@/entities/catalog/api/catalogSeo';
import { buildCatalogCollectionJsonLd } from '@/entities/catalog/lib/catalogStructuredData';
import { PUBLIC_CATALOG_CACHE_TAG } from '@/entities/catalog/api/catalogRevalidation';
import { createPageMetadata } from '@/shared/lib/seo/metadata';
import { unstable_cache } from 'next/cache';

export const revalidate = 60;
export const dynamic = 'force-dynamic';

const getCatalogRootCategories = unstable_cache(fetchCategories, ['catalog-root-categories'], {
  revalidate: 60,
  tags: [PUBLIC_CATALOG_CACHE_TAG],
});

const title = 'Каталог холодильного оборудования и комплектующих';
const description =
  'Каталог КТС: холодильное оборудование, автоматика и комплектующие для коммерческого и промышленного холода.';

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
    path: '/catalog',
    index: !hasUnsupportedCatalogQuery(query, false),
  });
}

export default async function CatalogRootPage() {
  const categories = await getCatalogRootCategories();
  const jsonLd = buildCatalogCollectionJsonLd({
    name: title,
    description,
    path: '/catalog',
    breadcrumbs: [
      { name: 'Главная', path: '/' },
      { name: 'Каталог', path: '/catalog' },
    ],
    items: categories.map((category) => ({
      name: category.title,
      path: `/catalog/${category.slug}`,
    })),
  });

  return (
    <>
      <CatalogSeo heading={title} jsonLd={jsonLd} />
      <CategoryGrid items={categories} />
    </>
  );
}
