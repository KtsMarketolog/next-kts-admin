import { NextRequest, NextResponse } from 'next/server';
import { fetchBrandsBySubcategory } from '@/entities/catalog/api/catalogApi';

export async function GET(request: NextRequest) {
  const subcategory = request.nextUrl.searchParams.get('subcategory')?.trim() ?? '';
  if (!subcategory) {
    return NextResponse.json([]);
  }

  return NextResponse.json(await fetchBrandsBySubcategory(subcategory));
}
