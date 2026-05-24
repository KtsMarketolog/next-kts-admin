import ProductGrid from '@/widgets/catalog/ProductGrid';
import { fetchProductsByCategorySubcategory, fetchSubcategoryMeta } from '@/entities/catalog/api/catalogApi';

export const revalidate = 60;

type Params = { category: string; subcategory: string };

export default async function SubcategoryPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { category: categoryRaw, subcategory: raw } = await params;
  const category = decodeURIComponent(categoryRaw).trim();
  const subcategory = decodeURIComponent(raw).trim();

  // 1) товары
  const products = await fetchProductsByCategorySubcategory(category, subcategory);

  // 2) мета для дефолтных названий (если Strapi не вернул в товарах)
  const meta = await fetchSubcategoryMeta(subcategory, category);

  // 3) подставляем дефолты
  const items = products.map((p) => ({
    ...p,
    subcategory: p.subcategory ?? meta.subTitle ?? null,
    category: p.category ?? meta.catTitle ?? null,
  }));

  return <ProductGrid items={items} />;
}
