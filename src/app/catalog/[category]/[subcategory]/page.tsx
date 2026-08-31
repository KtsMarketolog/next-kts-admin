import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';

import {
  fetchProductsByCategorySubcategoryPage,
} from '@/entities/catalog/api/catalogApi';
import {
  CATALOG_PAGE_SIZE,
  catalogPagePath,
  catalogRedirectPath,
  getCatalogTotalPages,
  getPublicSubcategorySeoData,
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

export const revalidate = 60;

type Params = { category: string; subcategory: string };
type SearchParams = { [key: string]: string | string[] | undefined };
type Props = {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ category: categoryRaw, subcategory: subcategoryRaw }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const category = normalizeCatalogRouteParam(categoryRaw);
  const subcategory = normalizeCatalogRouteParam(subcategoryRaw);
  if (!category || !subcategory) notFound();

  const entity = await getPublicSubcategorySeoData(category, subcategory);
  if (!entity) notFound();

  const page = readCatalogPage(query.page);
  const totalPages = getCatalogTotalPages(entity.productCount);
  if (page > totalPages) notFound();

  const basePath = `/catalog/${entity.categorySlug}/${entity.subcategorySlug}`;
  const pageSuffix = page > 1 ? ` — страница ${page}` : '';
  return createPageMetadata({
    title: `${entity.subcategoryTitle}${pageSuffix}`,
    description: `${entity.subcategoryTitle} в категории «${entity.categoryTitle}»: оборудование и комплектующие в каталоге КТС${pageSuffix}.`,
    path: catalogPagePath(basePath, page),
    image: mediaUrl(entity.categoryImage) || undefined,
    index: entity.productCount > 0 && !hasUnsupportedCatalogQuery(query),
  });
}

export default async function SubcategoryPage({
  params,
  searchParams,
}: Props) {
  const [{ category: categoryRaw, subcategory: subcategoryRaw }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const requestedCategory = normalizeCatalogRouteParam(categoryRaw);
  const requestedSubcategory = normalizeCatalogRouteParam(subcategoryRaw);
  if (!requestedCategory || !requestedSubcategory) notFound();

  const entity = await getPublicSubcategorySeoData(requestedCategory, requestedSubcategory);
  if (!entity) notFound();

  const page = readCatalogPage(query.page);
  const basePath = `/catalog/${entity.categorySlug}/${entity.subcategorySlug}`;
  if (
    requestedCategory !== entity.categorySlug ||
    requestedSubcategory !== entity.subcategorySlug
  ) {
    permanentRedirect(catalogRedirectPath(basePath, query));
  }
  const expectedTotalPages = getCatalogTotalPages(entity.productCount);
  if (page > expectedTotalPages) notFound();

  const productPage = await fetchProductsByCategorySubcategoryPage(
    entity.categorySlug,
    entity.subcategorySlug,
    page,
    CATALOG_PAGE_SIZE,
  );
  const totalPages = getCatalogTotalPages(productPage.total);

  const items = productPage.items.map((product) => ({
    ...product,
    subcategory: product.subcategory ?? entity.subcategoryTitle,
    category: product.category ?? entity.categoryTitle,
  }));
  const title = entity.subcategoryTitle;
  const description = `${entity.subcategoryTitle} в категории «${entity.categoryTitle}»: оборудование и комплектующие в каталоге КТС.`;
  const path = catalogPagePath(basePath, page);
  const jsonLd = buildCatalogCollectionJsonLd({
    name: page > 1 ? `${title} — страница ${page}` : title,
    description,
    path,
    breadcrumbs: [
      { name: 'Главная', path: '/' },
      { name: 'Каталог', path: '/catalog' },
      { name: entity.categoryTitle, path: `/catalog/${entity.categorySlug}` },
      { name: entity.subcategoryTitle, path: basePath },
    ],
    items: items.map((product) => ({ name: product.title })),
    positionOffset: (page - 1) * CATALOG_PAGE_SIZE,
  });

  return (
    <>
      <CatalogSeo heading={title} jsonLd={jsonLd} />
      <ProductGrid items={items} />
      <CatalogPagination basePath={basePath} currentPage={page} totalPages={totalPages} />
    </>
  );
}
