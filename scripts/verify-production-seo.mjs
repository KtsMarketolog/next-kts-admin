const baseOrigin = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const canonicalOrigin = (process.argv[3] || "https://kts-impex.ru").replace(/\/$/, "");
const expectedRobotsTokens = ["noindex", "nofollow", "nocache"];
const expectedHeaderTokens = ["noindex", "nofollow", "noarchive"];
const requireYandexVerification = process.env.SEO_REQUIRE_YANDEX_VERIFICATION === "1";
const requireCatalogEntities = process.env.SEO_REQUIRE_CATALOG_ENTITIES === "1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function findTag(html, tagName, attributes) {
  const tags = html.match(new RegExp(`<${tagName}\\b[^>]*>`, "gi")) || [];
  return tags.find((tag) =>
    Object.entries(attributes).every(([name, value]) => attribute(tag, name)?.toLowerCase() === value.toLowerCase()),
  );
}

function findTags(html, tagName, attributes) {
  const tags = html.match(new RegExp(`<${tagName}\\b[^>]*>`, "gi")) || [];
  return tags.filter((tag) =>
    Object.entries(attributes).every(([name, value]) => attribute(tag, name)?.toLowerCase() === value.toLowerCase()),
  );
}

function directiveTokens(value) {
  return new Set(
    (value || "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function normalizeComparableUrl(value) {
  return new URL(value).href;
}

function pageTitle(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  return match?.[1]?.replace(/\s+/g, " ").trim() || null;
}

function metaContent(html, attributes) {
  const tag = findTag(html, "meta", attributes);
  return tag ? attribute(tag, "content") : null;
}

async function mapInBatches(values, batchSize, mapper) {
  const output = [];

  for (let offset = 0; offset < values.length; offset += batchSize) {
    output.push(...await Promise.all(values.slice(offset, offset + batchSize).map(mapper)));
  }

  return output;
}

function collectJsonLdTypes(html) {
  const types = new Set();
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);

  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;

    const schemaType = value["@type"];
    if (Array.isArray(schemaType)) {
      schemaType.forEach((type) => typeof type === "string" && types.add(type));
    } else if (typeof schemaType === "string") {
      types.add(schemaType);
    }
    Object.values(value).forEach(visit);
  }

  for (const [, attributes, body] of scripts) {
    const tag = `<script${attributes}>`;
    if (attribute(tag, "type")?.toLowerCase() !== "application/ld+json") continue;
    try {
      visit(JSON.parse(body));
    } catch {
      throw new Error("A JSON-LD script contains invalid JSON");
    }
  }

  return types;
}

function assertDirectives(value, expected, label) {
  const tokens = directiveTokens(value);
  for (const token of expected) {
    assert(tokens.has(token), `${label} is missing ${token}: ${value || "<empty>"}`);
  }
}

function allRobotsDirectiveTokens(html) {
  const tokens = new Set();

  for (const tag of findTags(html, "meta", { name: "robots" })) {
    for (const token of directiveTokens(attribute(tag, "content"))) tokens.add(token);
  }

  return tokens;
}

function assertCleanNoindexPage(result, label, { noCanonical = false } = {}) {
  const robotsTags = findTags(result.body, "meta", { name: "robots" });
  assert(robotsTags.length > 0, `${label} has no robots meta tag`);
  const tokens = allRobotsDirectiveTokens(result.body);
  assert(tokens.has("noindex"), `${label} robots meta is missing noindex`);
  assert(!tokens.has("index"), `${label} robots metadata contains conflicting index`);

  if (noCanonical) {
    assert(
      !findTag(result.body, "link", { rel: "canonical" }),
      `${label} must not inherit a canonical URL`,
    );
  }
}

async function get(pathname) {
  const response = await fetch(`${baseOrigin}${pathname}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  return { response, body };
}

async function probeImage(location) {
  const response = await fetch(location, {
    headers: { range: "bytes=0-0" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel();
  return response;
}

function assertStatus(result, expected, pathname) {
  assert(
    result.response.status === expected,
    `${pathname} returned ${result.response.status}, expected ${expected}`,
  );
}

async function verify() {
  const [
    home,
    catalog,
    filteredCatalog,
    login,
    robots,
    sitemap,
    api,
    publicData,
    missingCategory,
    missingPage,
    missingPrice,
    admin,
    cabinet,
    privatePriceApi,
    adminApi,
    clientApi,
  ] = await Promise.all([
    get("/"),
    get("/catalog"),
    get("/catalog?utm_source=seo-smoke"),
    get("/login"),
    get("/robots.txt"),
    get("/sitemap.xml"),
    get("/api/site-settings"),
    get("/data/cities.json"),
    get("/catalog/__seo-smoke-missing-category-404__"),
    get("/__seo-smoke-missing-page-404__"),
    get("/price/__seo-smoke-missing-private-price-404__"),
    get("/admin"),
    get("/cabinet"),
    get("/api/price/__seo-smoke-missing-private-price-404__/pdf"),
    get("/api/admin/session"),
    get("/api/client/documents"),
  ]);

  for (const [pathname, result] of [
    ["/", home],
    ["/catalog", catalog],
    ["/catalog?utm_source=seo-smoke", filteredCatalog],
    ["/login", login],
    ["/robots.txt", robots],
    ["/sitemap.xml", sitemap],
    ["/api/site-settings", api],
    ["/data/cities.json", publicData],
  ]) {
    assertStatus(result, 200, pathname);
  }

  const homeOgUrl = findTag(home.body, "meta", { property: "og:url" });
  assert(homeOgUrl, "/ has no og:url metadata");
  assert(
    normalizeComparableUrl(attribute(homeOgUrl, "content")) === normalizeComparableUrl(canonicalOrigin),
    "/ has a non-canonical og:url",
  );

  const homeSchemaTypes = collectJsonLdTypes(home.body);
  for (const schemaType of ["Organization", "WebSite"]) {
    assert(homeSchemaTypes.has(schemaType), `/ JSON-LD is missing ${schemaType}`);
  }
  const catalogSchemaTypes = collectJsonLdTypes(catalog.body);
  for (const schemaType of ["CollectionPage", "BreadcrumbList", "ItemList"]) {
    assert(catalogSchemaTypes.has(schemaType), `/catalog JSON-LD is missing ${schemaType}`);
  }

  const filteredCatalogRobots = findTag(filteredCatalog.body, "meta", { name: "robots" });
  assert(filteredCatalogRobots, "/catalog filter URL has no robots meta tag");
  assertDirectives(
    attribute(filteredCatalogRobots, "content"),
    ["noindex", "follow"],
    "/catalog filter robots meta",
  );

  if (requireYandexVerification) {
    assert(
      findTag(home.body, "meta", { name: "yandex-verification" }),
      "/ has no yandex-verification metadata",
    );
  }
  assertStatus(missingCategory, 404, "/catalog/__seo-smoke-missing-category-404__");
  assertStatus(missingPage, 404, "/__seo-smoke-missing-page-404__");
  assertStatus(missingPrice, 404, "/price/__seo-smoke-missing-private-price-404__");
  assertCleanNoindexPage(missingCategory, "catalog 404", { noCanonical: true });
  assertCleanNoindexPage(missingPage, "global 404", { noCanonical: true });
  assertCleanNoindexPage(missingPrice, "private price 404", { noCanonical: true });
  for (const [label, result] of [
    ["catalog 404", missingCategory],
    ["global 404", missingPage],
    ["private price 404", missingPrice],
  ]) {
    assert(!findTag(result.body, "meta", { property: "og:url" }), `${label} must not have og:url`);
  }

  for (const [pathname, result, expectedUrl] of [
    ["/", home, canonicalOrigin],
    ["/catalog", catalog, `${canonicalOrigin}/catalog`],
  ]) {
    const canonicalTag = findTag(result.body, "link", { rel: "canonical" });
    assert(canonicalTag, `${pathname} has no canonical link`);
    const canonicalHref = attribute(canonicalTag, "href");
    assert(
      normalizeComparableUrl(canonicalHref) === normalizeComparableUrl(expectedUrl),
      `${pathname} canonical is ${canonicalHref}, expected ${expectedUrl}`,
    );
  }

  assertDirectives(
    [...allRobotsDirectiveTokens(login.body)].join(","),
    expectedRobotsTokens,
    "/login robots meta",
  );
  assertDirectives(
    [...allRobotsDirectiveTokens(missingPrice.body)].join(","),
    expectedRobotsTokens,
    "/price/** robots meta",
  );
  assertDirectives(api.response.headers.get("x-robots-tag"), expectedHeaderTokens, "/api/site-settings X-Robots-Tag");
  assertDirectives(
    publicData.response.headers.get("x-robots-tag"),
    expectedHeaderTokens,
    "/data/cities.json X-Robots-Tag",
  );

  for (const [pathname, result] of [
    ["/admin", admin],
    ["/cabinet", cabinet],
    ["/price/__seo-smoke-missing-private-price-404__", missingPrice],
  ]) {
    assertDirectives(result.response.headers.get("x-robots-tag"), expectedHeaderTokens, `${pathname} X-Robots-Tag`);
    assert(
      result.response.headers.get("cache-control")?.toLowerCase().includes("private") &&
        result.response.headers.get("cache-control")?.toLowerCase().includes("no-store"),
      `${pathname} must send private, no-store caching`,
    );
  }
  assertDirectives(
    privatePriceApi.response.headers.get("x-robots-tag"),
    expectedHeaderTokens,
    "/api/price/** X-Robots-Tag",
  );
  assert(
    privatePriceApi.response.headers.get("cache-control")?.toLowerCase().includes("private") &&
      privatePriceApi.response.headers.get("cache-control")?.toLowerCase().includes("no-store"),
    "/api/price/** must send private, no-store caching",
  );
  for (const [pathname, result] of [
    ["/api/admin/session", adminApi],
    ["/api/client/documents", clientApi],
  ]) {
    assertDirectives(result.response.headers.get("x-robots-tag"), expectedHeaderTokens, `${pathname} X-Robots-Tag`);
    assert(
      result.response.headers.get("cache-control")?.toLowerCase().includes("private") &&
        result.response.headers.get("cache-control")?.toLowerCase().includes("no-store"),
      `${pathname} must send private, no-store caching`,
    );
  }

  assert(/(^|\n)User-agent:\s*\*/i.test(robots.body), "robots.txt has no User-agent: * group");
  assert(
    new RegExp(`(^|\\n)Sitemap:\\s*${canonicalOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sitemap\\.xml\\s*($|\\n)`, "i").test(robots.body),
    "robots.txt has no canonical Sitemap directive",
  );
  for (const technicalPath of ["/api/", "/data/", "/klimatika/prog/firmware/update/"]) {
    assert(
      new RegExp(`(^|\\n)Disallow:\\s*${technicalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*($|\\n)`, "i").test(robots.body),
      `robots.txt does not disallow ${technicalPath}`,
    );
  }
  for (const privatePath of ["/admin", "/login", "/cabinet", "/price"]) {
    assert(
      !new RegExp(`(^|\\n)Disallow:\\s*${privatePath}(?:/|\\s|$)`, "i").test(robots.body),
      `robots.txt must not hide ${privatePath}; crawlers need to read its noindex directive`,
    );
  }

  assert(/<urlset\b/i.test(sitemap.body), "sitemap.xml has no urlset");
  const locations = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((match) => match[1].trim());
  const imageLocations = [...sitemap.body.matchAll(/<image:loc>([^<]+)<\/image:loc>/gi)].map((match) => match[1].trim());
  const normalizedLocations = locations.map(normalizeComparableUrl);
  for (const pathname of ["/", "/catalog", "/catalog/brands", "/about", "/contacts", "/klimatika"]) {
    assert(
      normalizedLocations.includes(normalizeComparableUrl(`${canonicalOrigin}${pathname === "/" ? "" : pathname}`)),
      `sitemap.xml is missing ${pathname}`,
    );
  }
  assert(
    locations.every((location) => new URL(location).origin === new URL(canonicalOrigin).origin),
    "sitemap.xml contains a non-canonical origin",
  );
  assert(
    locations.every(
      (location) => !/^\/(?:admin|login|cabinet|price|api)(?:\/|$)/i.test(new URL(location).pathname),
    ),
    "sitemap.xml contains a private URL",
  );
  assert(
    new Set(normalizedLocations.map((location) => location.toLowerCase())).size === locations.length,
    "sitemap.xml contains duplicate or case-variant URLs",
  );
  assert(
    locations.every((location) => {
      const url = new URL(location);
      return !url.search && !url.hash && (url.pathname === "/" || !url.pathname.endsWith("/"));
    }),
    "sitemap.xml contains query parameters, fragments, or a non-root trailing slash",
  );

  const sitemapPaths = locations.map((location) => new URL(location).pathname);
  const categoryPaths = sitemapPaths.filter((pathname) => /^\/catalog\/(?!brands$|promo$)[^/]+$/.test(pathname));
  const subcategoryPaths = sitemapPaths.filter((pathname) => /^\/catalog\/(?!brands\/)[^/]+\/[^/]+$/.test(pathname));
  const brandPaths = sitemapPaths.filter((pathname) => /^\/catalog\/brands\/[^/]+$/.test(pathname));
  if (requireCatalogEntities) {
    assert(categoryPaths.length > 0, "sitemap.xml has no active nonempty category");
    assert(subcategoryPaths.length > 0, "sitemap.xml has no active nonempty subcategory");
    assert(brandPaths.length > 0, "sitemap.xml has no active nonempty brand");
  }

  const uniqueImageLocations = [...new Set(imageLocations)];
  for (const location of uniqueImageLocations) {
    assert(new URL(location).protocol === "https:", `sitemap image is not HTTPS: ${location}`);
  }
  const imageResponses = await mapInBatches(uniqueImageLocations, 6, async (location) => ({
    location,
    response: await probeImage(location),
  }));
  for (const { location, response } of imageResponses) {
    assert(response.ok, `sitemap image returned ${response.status}: ${location}`);
    assert(
      response.headers.get("content-type")?.toLowerCase().startsWith("image/"),
      `sitemap image has a non-image content type: ${location}`,
    );
  }

  const sitemapPages = await mapInBatches(locations, 8, async (location) => {
    const target = new URL(location);
    const result = await get(`${target.pathname}${target.search}`);
    return { location, result };
  });
  const titles = new Map();

  for (const { location, result } of sitemapPages) {
    assertStatus(result, 200, location);

    const canonicalTag = findTag(result.body, "link", { rel: "canonical" });
    assert(canonicalTag, `${location} has no canonical link`);
    const canonicalHref = attribute(canonicalTag, "href");
    assert(
      normalizeComparableUrl(canonicalHref) === normalizeComparableUrl(location),
      `${location} canonical is ${canonicalHref}`,
    );
    const ogUrl = metaContent(result.body, { property: "og:url" });
    assert(ogUrl, `${location} has no og:url`);
    assert(
      normalizeComparableUrl(ogUrl) === normalizeComparableUrl(location),
      `${location} og:url is ${ogUrl}`,
    );
    assert(metaContent(result.body, { name: "twitter:card" }), `${location} has no Twitter Card`);

    const pageRobots = findTag(result.body, "meta", { name: "robots" });
    if (pageRobots) {
      const tokens = directiveTokens(attribute(pageRobots, "content"));
      assert(!tokens.has("noindex"), `${location} is in sitemap but has noindex`);
    }

    const title = pageTitle(result.body);
    assert(title, `${location} has no title`);
    const titleKey = title.toLocaleLowerCase("ru-RU");
    assert(!titles.has(titleKey), `${location} duplicates the title of ${titles.get(titleKey)}`);
    titles.set(titleKey, location);
  }

  const descriptions = new Map();
  for (const { location, result } of sitemapPages) {
    const description = metaContent(result.body, { name: "description" });
    assert(description, `${location} has no meta description`);
    const descriptionKey = description.replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
    assert(
      !descriptions.has(descriptionKey),
      `${location} duplicates the description of ${descriptions.get(descriptionKey)}`,
    );
    descriptions.set(descriptionKey, location);
  }

  if (brandPaths[0]) {
    const outOfRange = await get(`${brandPaths[0]}?page=999999`);
    assertStatus(outOfRange, 404, `${brandPaths[0]}?page=999999`);
    assertCleanNoindexPage(outOfRange, "out-of-range catalog page", { noCanonical: true });
  }

  const sitemapByPath = new Map(
    sitemapPages.map(({ location, result }) => [new URL(location).pathname, result]),
  );
  for (const [pathname, schemaType] of [
    ["/about", "AboutPage"],
    ["/contacts", "ContactPage"],
  ]) {
    const page = sitemapByPath.get(pathname);
    assert(page, `sitemap.xml is missing ${pathname}`);
    assert(
      collectJsonLdTypes(page.body).has(schemaType),
      `${pathname} JSON-LD is missing ${schemaType}`,
    );
  }

  console.log(
    `SEO production smoke passed for ${baseOrigin}: ${locations.length} canonical sitemap URLs checked.`,
  );
}

verify().catch((error) => {
  console.error(`SEO production smoke failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
