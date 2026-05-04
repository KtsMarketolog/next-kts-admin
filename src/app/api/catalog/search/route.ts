import { NextRequest, NextResponse } from 'next/server';
import { searchProducts } from '@/entities/catalog/api/catalogApi';

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  return NextResponse.json(await searchProducts(query));
}
