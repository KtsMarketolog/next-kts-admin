import assert from "node:assert/strict";
import test from "node:test";

import robots from "../src/app/robots";
import {
  createAboutPageJsonLd,
  createContactPageJsonLd,
  createGlobalJsonLd,
  serializeJsonLd,
} from "../src/shared/lib/seo/jsonLd";
import {
  buildSitemap,
  EMPTY_CATALOG_SITEMAP_DATA,
} from "../src/shared/lib/seo/sitemap";
import {
  canonicalUrl,
  getCanonicalOrigin,
  PRODUCTION_SITE_ORIGIN,
} from "../src/shared/lib/seo/siteUrl";

test("canonical origin prefers SITE_URL and strips paths and trailing slashes", () => {
  assert.equal(
    getCanonicalOrigin({
      SITE_URL: "  https://example.test/site///  ",
      NEXT_PUBLIC_SITE_URL: "https://public.example.test",
    }),
    "https://example.test",
  );
});

test("canonical origin falls back through public env to production", () => {
  assert.equal(
    getCanonicalOrigin({
      SITE_URL: "not a valid URL ^",
      NEXT_PUBLIC_SITE_URL: "public.example.test/",
    }),
    "https://public.example.test",
  );
  assert.equal(
    getCanonicalOrigin({ SITE_URL: "", NEXT_PUBLIC_SITE_URL: "" }),
    PRODUCTION_SITE_ORIGIN,
  );
});

test("canonical URL joins a site path and never retains a fragment", () => {
  const environment = {
    SITE_URL: "https://example.test/",
    NEXT_PUBLIC_SITE_URL: "",
  };

  assert.equal(canonicalUrl("/catalog?q=1#section", environment), "https://example.test/catalog?q=1");
  assert.equal(canonicalUrl("/", environment), "https://example.test");
});

test("JSON-LD serialization escapes HTML-significant less-than characters", () => {
  const data = {
    "@context": "https://schema.org",
    name: "</script><script>alert(1)</script>",
  };
  const serialized = serializeJsonLd(data);

  assert.equal(serialized.includes("<"), false);
  assert.deepEqual(JSON.parse(serialized), data);
});

test("global JSON-LD exposes stable Organization and WebSite identifiers", () => {
  const data = createGlobalJsonLd() as {
    "@graph": Array<Record<string, unknown>>;
  };
  const origin = getCanonicalOrigin();

  assert.equal(data["@graph"][0]["@type"], "Organization");
  assert.equal(data["@graph"][0]["@id"], `${origin}/#organization`);
  assert.equal(data["@graph"][1]["@type"], "WebSite");
  assert.equal(data["@graph"][1]["@id"], `${origin}/#website`);
});

test("informational page JSON-LD references the global website and organization", () => {
  const origin = getCanonicalOrigin();
  const about = createAboutPageJsonLd() as Record<string, any>;
  const contacts = createContactPageJsonLd() as Record<string, any>;

  assert.equal(about["@type"], "AboutPage");
  assert.equal(about.url, canonicalUrl("/about"));
  assert.equal(about.about["@id"], `${origin}/#organization`);
  assert.equal(contacts["@type"], "ContactPage");
  assert.equal(contacts.url, canonicalUrl("/contacts"));
  assert.equal(contacts.mainEntity["@id"], `${origin}/#organization`);
});

test("robots allows public HTML and blocks technical resources", () => {
  const value = robots();

  assert.deepEqual(value.rules, {
    userAgent: "*",
    allow: "/",
    disallow: [
      "/api/",
      "/data/",
      "/klimatika/prog/firmware/update/",
    ],
  });
  assert.equal(value.sitemap, canonicalUrl("/sitemap.xml"));
});

test("sitemap always contains public static routes and no private routes", () => {
  const urls = buildSitemap(EMPTY_CATALOG_SITEMAP_DATA).map((entry) => entry.url);

  assert.deepEqual(urls, [
    canonicalUrl("/"),
    canonicalUrl("/catalog"),
    canonicalUrl("/catalog/brands"),
    canonicalUrl("/about"),
    canonicalUrl("/contacts"),
    canonicalUrl("/klimatika"),
  ]);
  assert.equal(urls.some((url) => /\/(?:admin|api|login|cabinet|price)(?:\/|$)/.test(url)), false);
});

test("sitemap adds only supplied nonempty catalog entities and active promo", () => {
  const sitemap = buildSitemap({
    categories: [{ slug: "cooling", imageUrl: "/uploads/category.jpg" }],
    subcategories: [{ categorySlug: "cooling", slug: "compressors" }],
    brands: [{ slug: "carel", logoUrl: "https://cdn.example.test/carel.png" }],
    hasActivePromoProducts: true,
  });
  const byUrl = new Map(sitemap.map((entry) => [entry.url, entry]));

  assert.deepEqual(byUrl.get(canonicalUrl("/catalog/cooling"))?.images, [
    canonicalUrl("/uploads/category.jpg"),
  ]);
  assert.equal(byUrl.has(canonicalUrl("/catalog/cooling/compressors")), true);
  assert.deepEqual(byUrl.get(canonicalUrl("/catalog/brands/carel"))?.images, [
    "https://cdn.example.test/carel.png",
  ]);
  assert.equal(byUrl.has(canonicalUrl("/catalog/promo")), true);
  assert.equal(sitemap.every((entry) => entry.lastModified === undefined), true);
});

test("sitemap drops blank and case-insensitive duplicate routes", () => {
  const sitemap = buildSitemap({
    categories: [
      { slug: "", imageUrl: null },
      { slug: "Cooling", imageUrl: null },
      { slug: "cooling", imageUrl: null },
      { slug: "brands", imageUrl: "/uploads/unreachable.jpg" },
    ],
    subcategories: [
      { categorySlug: "Cooling", slug: "Compressors" },
      { categorySlug: "cooling", slug: "compressors" },
      { categorySlug: "", slug: "invalid" },
    ],
    brands: [
      { slug: "Carel", logoUrl: null },
      { slug: "carel", logoUrl: null },
      { slug: "", logoUrl: null },
    ],
    hasActivePromoProducts: false,
  });
  const urls = sitemap.map((entry) => entry.url);
  const normalized = urls.map((url) => url.toLowerCase());

  assert.equal(new Set(normalized).size, normalized.length);
  assert.equal(normalized.filter((url) => url.endsWith("/catalog/brands")).length, 1);
  assert.equal(normalized.some((url) => url.endsWith("/catalog/")), false);
});
