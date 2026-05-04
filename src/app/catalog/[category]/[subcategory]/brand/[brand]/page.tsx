import ProductGrid from '@/widgets/catalog/ProductGrid';
import {
  fetchProductsBySubcategoryBrand,
  fetchSubcategoryMeta,
} from '@/entities/catalog/api/catalogApi';

export const revalidate = 60;
export const dynamic = 'force-dynamic';

type Params = { category: string; subcategory: string; brand: string };

export default async function SubcatBrandPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { subcategory: subRaw, brand: brandRaw } = await params;

  const subcategory = decodeURIComponent(subRaw ?? '').trim();
  const brand = decodeURIComponent(brandRaw ?? '').trim();

  // 1) товары для подкатегории и бренда
  const products = await fetchProductsBySubcategoryBrand(subcategory, brand);

  // 2) мета — на случай, если в товарах не пришли названия
  const meta = await fetchSubcategoryMeta(subcategory);

  // 3) подставляем дефолты
  const items = products.map((p) => ({
    ...p,
    subcategory: p.subcategory ?? meta.subTitle ?? null,
    category: p.category ?? meta.catTitle ?? null,
  }));

  return <ProductGrid items={items} />;
}
