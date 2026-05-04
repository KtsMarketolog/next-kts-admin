import CategoryGrid from '@/widgets/catalog/CategoryGrid';
import { fetchCategories } from '@/entities/catalog/api/catalogApi';

export const revalidate = 60;
export const dynamic = 'force-dynamic';

export default async function CatalogRootPage() {
  const categories = await fetchCategories();
  return <CategoryGrid items={categories} />;
}
