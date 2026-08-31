import type { MetadataRoute } from "next";

import { canonicalUrl } from "@/shared/lib/seo/siteUrl";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/data/",
        "/klimatika/prog/firmware/update/",
      ],
    },
    sitemap: canonicalUrl("/sitemap.xml"),
  };
}
