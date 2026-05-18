export type SidebarData = {
  categories: {
    slug: string;
    title: string;
    icon?: string;
    subs?: { slug: string; title: string }[];
  }[];
  brands: { slug: string; title: string; popular?: boolean; logo?: string | null }[];
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Catalog API error ${response.status}: ${url}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchBrandsBySubcategory(subcategory: string) {
  return fetchJson<SidebarData['brands']>(
    `/api/catalog/brands-by-subcategory?subcategory=${encodeURIComponent(subcategory)}`,
  );
}

export const getBrandsForSubcategory = fetchBrandsBySubcategory;

export default async function getSidebarData(): Promise<SidebarData> {
  return fetchJson<SidebarData>('/api/catalog/sidebar');
}
