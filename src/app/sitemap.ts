import type { MetadataRoute } from "next";
import { unstable_cache } from "next/cache";

import { PUBLIC_CATALOG_CACHE_TAG } from "@/entities/catalog/api/catalogRevalidation";
import {
  buildSitemap,
  loadCatalogSitemapData,
} from "@/shared/lib/seo/sitemap";

export const dynamic = "force-dynamic";

const loadCachedCatalogSitemapData = unstable_cache(
  loadCatalogSitemapData,
  ["public-catalog-sitemap"],
  {
    revalidate: 300,
    tags: [PUBLIC_CATALOG_CACHE_TAG],
  },
);

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap(await loadCachedCatalogSitemapData());
}
