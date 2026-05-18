// src/app/catalog/brands/[brand]/page.tsx
import ProductGrid from '@/widgets/catalog/ProductGrid';
import {
  fetchProductsByBrand,
  fetchBrandSubcategories,
  fetchCategories,
  fetchSubcategoryMeta,
} from '@/entities/catalog/api/catalogApi';
import { notFound } from 'next/navigation';

export const revalidate = 60;

type Params = { brand: string };

export default async function BrandPage({
  params,
}: {
  params: Promise<Params>;
}) {
  // Next.js app router — params нужно дождаться
  const { brand: raw } = await params;
  const brand = decodeURIComponent(raw ?? '').trim();
  if (!brand) notFound();

  // 1) Товары бренда + подкатегории бренда + все категории
  const [products, subsMeta, cats] = await Promise.all([
    fetchProductsByBrand(brand),
    fetchBrandSubcategories(brand), // [{ slug, title, category?: <catSlug> }]
    fetchCategories(),              // [{ slug, title }]
  ]);

  // 2) Карта: slug категории -> её название
  const catTitleBySlug = new Map<string, string>();
  for (const c of cats) {
    if (c.slug && c.title) catTitleBySlug.set(c.slug, c.title);
  }

  // 3) Карта: название подкатегории -> название категории
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

  // 4) Фолбэк для «одиночного» бренда: если у бренда одна подкатегория
  const singleSubTitle =
    subsMeta.length === 1 ? subsMeta[0].title ?? null : null;
  const singleCatTitle =
    subsMeta.length === 1
      ? catTitleBySubTitle.get(singleSubTitle ?? '') ?? null
      : null;

  // 5) Подставляем недостающие sub/category у товаров
  const items = products.map((p) => {
    const sub = (p.subcategory ?? singleSubTitle ?? '').trim() || null;
    const cat =
      p.category ??
      (sub ? catTitleBySubTitle.get(sub) ?? null : null) ??
      singleCatTitle ??
      null;

    return { ...p, subcategory: sub, category: cat };
  });

  return <ProductGrid items={items} />;
}
