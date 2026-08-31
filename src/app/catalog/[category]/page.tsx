import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';

import {
  fetchPromoProductsPage,
  fetchSubcategories,
} from '@/entities/catalog/api/catalogApi';
import {
  CATALOG_PAGE_SIZE,
  catalogPagePath,
  catalogRedirectPath,
  getCatalogTotalPages,
  getPromoProductCount,
  getPublicCategorySeoData,
  hasUnsupportedCatalogQuery,
  normalizeCatalogRouteParam,
  readCatalogPage,
} from '@/entities/catalog/api/catalogSeo';
import { buildCatalogCollectionJsonLd } from '@/entities/catalog/lib/catalogStructuredData';
import { createPageMetadata } from '@/shared/lib/seo/metadata';
import { mediaUrl } from '@/shared/lib/mediaUrl';
import { CatalogPagination } from '@/widgets/catalog/CatalogPagination';
import { CatalogSeo } from '@/widgets/catalog/CatalogSeo';
import ProductGrid from '@/widgets/catalog/ProductGrid';
import SubcategoryGrid from '@/widgets/catalog/SubcategoryGrid';

export const revalidate = 60;

type Params = { category: string };
type SearchParams = { [key: string]: string | string[] | undefined };
type Props = {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
};

const PROMO_PATH = '/catalog/promo';

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ category: raw }, query] = await Promise.all([params, searchParams]);
  const requestedCategory = normalizeCatalogRouteParam(raw);
  if (!requestedCategory) notFound();

  if (requestedCategory.toLowerCase() === 'promo') {
    const page = readCatalogPage(query.page);
    const productCount = await getPromoProductCount();
    const totalPages = getCatalogTotalPages(productCount);
    if (page > totalPages) notFound();

    const pageSuffix = page > 1 ? ` — страница ${page}` : '';
    return createPageMetadata({
      title: `Акционные товары${pageSuffix}`,
      description: `Акционные предложения на холодильное оборудование и комплектующие в каталоге КТС${pageSuffix}.`,
      path: catalogPagePath(PROMO_PATH, page),
      index: productCount > 0 && !hasUnsupportedCatalogQuery(query),
    });
  }

  const category = await getPublicCategorySeoData(requestedCategory);
  if (!category) notFound();

  return createPageMetadata({
    title: category.title,
    description:
      category.subtitle?.trim() ||
      `${category.title}: оборудование и комплектующие в каталоге КТС.`,
    path: `/catalog/${category.slug}`,
    image: mediaUrl(category.image) || undefined,
    index: category.productCount > 0 && !hasUnsupportedCatalogQuery(query, false),
  });
}

export default async function CategoryPage({
  params,
  searchParams,
}: Props) {
  const [{ category: raw }, query] = await Promise.all([params, searchParams]);
  const requestedCategory = normalizeCatalogRouteParam(raw);
  if (!requestedCategory) notFound();

  if (requestedCategory.toLowerCase() === 'promo') {
    const page = readCatalogPage(query.page);
    if (requestedCategory !== 'promo') permanentRedirect(catalogRedirectPath(PROMO_PATH, query));
    const productCount = await getPromoProductCount();
    const expectedTotalPages = getCatalogTotalPages(productCount);
    if (page > expectedTotalPages) notFound();

    const { items, total } = await fetchPromoProductsPage(page, CATALOG_PAGE_SIZE);
    const totalPages = getCatalogTotalPages(total);

    const title = 'Акционные товары';
    const description = 'Акционные предложения на холодильное оборудование и комплектующие в каталоге КТС.';
    const path = catalogPagePath(PROMO_PATH, page);
    const jsonLd = buildCatalogCollectionJsonLd({
      name: page > 1 ? `${title} — страница ${page}` : title,
      description,
      path,
      breadcrumbs: [
        { name: 'Главная', path: '/' },
        { name: 'Каталог', path: '/catalog' },
        { name: 'Акции', path: PROMO_PATH },
      ],
      items: items.map((product) => ({ name: product.title })),
      positionOffset: (page - 1) * CATALOG_PAGE_SIZE,
    });

    return (
      <>
        <CatalogSeo heading={title} jsonLd={jsonLd} />
        <ProductGrid items={items} />
        <CatalogPagination basePath={PROMO_PATH} currentPage={page} totalPages={totalPages} />
      </>
    );
  }

  const category = await getPublicCategorySeoData(requestedCategory);
  if (!category) notFound();
  if (requestedCategory !== category.slug) {
    permanentRedirect(catalogRedirectPath(`/catalog/${category.slug}`, query));
  }

  const subcategories = await fetchSubcategories(category.slug);
  const path = `/catalog/${category.slug}`;
  const description =
    category.subtitle?.trim() || `${category.title}: оборудование и комплектующие в каталоге КТС.`;
  const jsonLd = buildCatalogCollectionJsonLd({
    name: category.title,
    description,
    path,
    breadcrumbs: [
      { name: 'Главная', path: '/' },
      { name: 'Каталог', path: '/catalog' },
      { name: category.title, path },
    ],
    items: subcategories.map((subcategory) => ({
      name: subcategory.title,
      path: `${path}/${subcategory.slug}`,
    })),
  });

  return (
    <>
      <CatalogSeo heading={category.title} jsonLd={jsonLd} />
      <SubcategoryGrid items={subcategories} categorySlug={category.slug} />
    </>
  );
}
