import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';

import {
  fetchBrandSubcategories,
  fetchCategories,
  fetchProductsByBrandPage,
  fetchSubcategoryMeta,
} from '@/entities/catalog/api/catalogApi';
import {
  CATALOG_PAGE_SIZE,
  catalogPagePath,
  catalogRedirectPath,
  getCatalogTotalPages,
  getPublicBrandSeoData,
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

type Params = { brand: string };
type SearchParams = { [key: string]: string | string[] | undefined };
type Props = {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ brand: raw }, query] = await Promise.all([params, searchParams]);
  const requestedBrand = normalizeCatalogRouteParam(raw);
  if (!requestedBrand) notFound();

  const brand = await getPublicBrandSeoData(requestedBrand);
  if (!brand) notFound();

  const page = readCatalogPage(query.page);
  const totalPages = getCatalogTotalPages(brand.productCount);
  if (page > totalPages) notFound();

  const basePath = `/catalog/brands/${brand.slug}`;
  const pageSuffix = page > 1 ? ` — страница ${page}` : '';
  return createPageMetadata({
    title: `Оборудование ${brand.title}${pageSuffix}`,
    description: `Оборудование и комплектующие бренда ${brand.title} в каталоге КТС${pageSuffix}.`,
    path: catalogPagePath(basePath, page),
    image: mediaUrl(brand.logo) || undefined,
    index: brand.productCount > 0 && !hasUnsupportedCatalogQuery(query),
  });
}

export default async function BrandPage({
  params,
  searchParams,
}: Props) {
  const [{ brand: raw }, query] = await Promise.all([params, searchParams]);
  const requestedBrand = normalizeCatalogRouteParam(raw);
  if (!requestedBrand) notFound();

  const brand = await getPublicBrandSeoData(requestedBrand);
  if (!brand) notFound();

  const page = readCatalogPage(query.page);
  const basePath = `/catalog/brands/${brand.slug}`;
  if (requestedBrand !== brand.slug) permanentRedirect(catalogRedirectPath(basePath, query));
  const expectedTotalPages = getCatalogTotalPages(brand.productCount);
  if (page > expectedTotalPages) notFound();

  const [productPage, subsMeta, cats] = await Promise.all([
    fetchProductsByBrandPage(brand.slug, page, CATALOG_PAGE_SIZE),
    fetchBrandSubcategories(brand.slug),
    fetchCategories(),
  ]);
  const totalPages = getCatalogTotalPages(productPage.total);

  const catTitleBySlug = new Map<string, string>();
  for (const c of cats) {
    if (c.slug && c.title) catTitleBySlug.set(c.slug, c.title);
  }

  const catTitleBySubTitle = new Map<string, string | null>();
  await Promise.all(
    subsMeta.map(async (s) => {
      const subTitle = s.title ?? '';
      if (!subTitle) return;

      let catTitle: string | null =
        s.category ? catTitleBySlug.get(s.category) ?? null : null;

      if (!catTitle && s.slug) {
        const meta = await fetchSubcategoryMeta(s.slug);
        catTitle = meta.catTitle;
      }

      if (!catTitleBySubTitle.has(subTitle)) {
        catTitleBySubTitle.set(subTitle, catTitle ?? null);
      }
    })
  );

  const singleSubTitle =
    subsMeta.length === 1 ? subsMeta[0].title ?? null : null;
  const singleCatTitle =
    subsMeta.length === 1
      ? catTitleBySubTitle.get(singleSubTitle ?? '') ?? null
      : null;

  const items = productPage.items.map((product) => {
    const sub = (product.subcategory ?? singleSubTitle ?? '').trim() || null;
    const cat =
      product.category ??
      (sub ? catTitleBySubTitle.get(sub) ?? null : null) ??
      singleCatTitle ??
      null;

    return { ...product, subcategory: sub, category: cat };
  });

  const title = `Оборудование ${brand.title}`;
  const description = `Оборудование и комплектующие бренда ${brand.title} в каталоге КТС.`;
  const path = catalogPagePath(basePath, page);
  const jsonLd = buildCatalogCollectionJsonLd({
    name: page > 1 ? `${title} — страница ${page}` : title,
    description,
    path,
    breadcrumbs: [
      { name: 'Главная', path: '/' },
      { name: 'Каталог', path: '/catalog' },
      { name: 'Бренды', path: '/catalog/brands' },
      { name: brand.title, path: basePath },
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
