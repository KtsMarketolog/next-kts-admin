import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';

import {
  fetchProductsByCategorySubcategoryBrandPage,
} from '@/entities/catalog/api/catalogApi';
import {
  CATALOG_PAGE_SIZE,
  catalogRedirectPath,
  getCatalogTotalPages,
  getPublicSubcategoryBrandSeoData,
  normalizeCatalogRouteParam,
  readCatalogPage,
} from '@/entities/catalog/api/catalogSeo';
import { createPageMetadata } from '@/shared/lib/seo/metadata';
import { mediaUrl } from '@/shared/lib/mediaUrl';
import { CatalogPagination } from '@/widgets/catalog/CatalogPagination';
import { CatalogSeo } from '@/widgets/catalog/CatalogSeo';
import ProductGrid from '@/widgets/catalog/ProductGrid';

export const revalidate = 60;

type Params = { category: string; subcategory: string; brand: string };
type SearchParams = { [key: string]: string | string[] | undefined };
type Props = {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [routeParams, query] = await Promise.all([params, searchParams]);
  const category = normalizeCatalogRouteParam(routeParams.category);
  const subcategory = normalizeCatalogRouteParam(routeParams.subcategory);
  const brand = normalizeCatalogRouteParam(routeParams.brand);
  if (!category || !subcategory || !brand) notFound();

  const entity = await getPublicSubcategoryBrandSeoData(category, subcategory, brand);
  if (!entity) notFound();

  const page = readCatalogPage(query.page);
  const totalPages = getCatalogTotalPages(entity.productCount);
  if (page > totalPages) notFound();

  const canonicalPath = `/catalog/${entity.categorySlug}/${entity.subcategorySlug}`;
  const pageSuffix = page > 1 ? ` — страница ${page}` : '';
  return createPageMetadata({
    title: `${entity.subcategoryTitle} ${entity.brandTitle}${pageSuffix}`,
    description: `${entity.subcategoryTitle} бренда ${entity.brandTitle}: оборудование и комплектующие в каталоге КТС${pageSuffix}.`,
    path: canonicalPath,
    image: mediaUrl(entity.brandLogo || entity.categoryImage) || undefined,
    index: false,
  });
}

export default async function SubcatBrandPage({
  params,
  searchParams,
}: Props) {
  const [routeParams, query] = await Promise.all([params, searchParams]);
  const requestedCategory = normalizeCatalogRouteParam(routeParams.category);
  const requestedSubcategory = normalizeCatalogRouteParam(routeParams.subcategory);
  const requestedBrand = normalizeCatalogRouteParam(routeParams.brand);
  if (!requestedCategory || !requestedSubcategory || !requestedBrand) notFound();

  const entity = await getPublicSubcategoryBrandSeoData(
    requestedCategory,
    requestedSubcategory,
    requestedBrand,
  );
  if (!entity) notFound();

  const page = readCatalogPage(query.page);
  const basePath = `/catalog/${entity.categorySlug}/${entity.subcategorySlug}/brand/${entity.brandSlug}`;
  if (
    requestedCategory !== entity.categorySlug ||
    requestedSubcategory !== entity.subcategorySlug ||
    requestedBrand !== entity.brandSlug
  ) {
    permanentRedirect(catalogRedirectPath(basePath, query));
  }
  const expectedTotalPages = getCatalogTotalPages(entity.productCount);
  if (page > expectedTotalPages) notFound();

  const productPage = await fetchProductsByCategorySubcategoryBrandPage(
    entity.categorySlug,
    entity.subcategorySlug,
    entity.brandSlug,
    page,
    CATALOG_PAGE_SIZE,
  );
  const totalPages = getCatalogTotalPages(productPage.total);

  const items = productPage.items.map((product) => ({
    ...product,
    subcategory: product.subcategory ?? entity.subcategoryTitle,
    category: product.category ?? entity.categoryTitle,
  }));

  const title = `${entity.subcategoryTitle} ${entity.brandTitle}`;

  return (
    <>
      <CatalogSeo heading={title} />
      <ProductGrid items={items} />
      <CatalogPagination basePath={basePath} currentPage={page} totalPages={totalPages} />
    </>
  );
}
