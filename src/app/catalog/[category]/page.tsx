import ProductGrid from '@/widgets/catalog/ProductGrid';
import SubcategoryGrid from '@/widgets/catalog/SubcategoryGrid';
import { fetchPromoProducts, fetchSubcategories } from '@/entities/catalog/api/catalogApi';

export const revalidate = 60;

type Params = { category: string };

export default async function CategoryPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { category: raw } = await params;
  const category = decodeURIComponent(raw ?? '').trim();

  if (category.toLowerCase() === 'promo') {
    const products = await fetchPromoProducts();
    return <ProductGrid items={products} />;
  }

  const subs = await fetchSubcategories(category);
  return <SubcategoryGrid items={subs} categorySlug={category} />;
}
