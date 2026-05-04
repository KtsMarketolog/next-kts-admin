import { NextResponse } from 'next/server';
import { fetchAllBrands, fetchCategories, fetchSubcategories } from '@/entities/catalog/api/catalogApi';

export async function GET() {
  const [categories, brands] = await Promise.all([fetchCategories(), fetchAllBrands()]);
  const categoriesWithSubs = await Promise.all(
    categories.map(async (category) => ({
      slug: category.slug,
      title: category.title,
      icon: category.icon,
      subs: (await fetchSubcategories(category.slug)).map((subcategory) => ({
        slug: subcategory.slug,
        title: subcategory.title,
      })),
    })),
  );

  return NextResponse.json({
    categories: categoriesWithSubs,
    brands,
  });
}
