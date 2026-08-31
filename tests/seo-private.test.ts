import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { proxy } from "../src/proxy";
import { createPrivateMetadata } from "../src/shared/lib/seo/privateMetadata";

test("private page metadata prevents indexing, following, and caching", () => {
  const metadata = createPrivateMetadata();

  assert.deepEqual(metadata.robots, {
    index: false,
    follow: false,
    nocache: true,
  });
});

test("proxy sends noindex headers for private pages and every API response", () => {
  const privatePaths = [
    "/admin",
    "/admin/site/users",
    "/cabinet",
    "/cabinet/login",
    "/login",
    "/price/private-token",
    "/price/private-token/pdf",
    "/price/private-token/excel",
    "/api/site-settings",
    "/api/admin/session",
    "/api/client/documents",
    "/api/price/private-token/pdf",
  ];

  for (const pathname of privatePaths) {
    const response = proxy(new NextRequest(`https://kts-impex.ru${pathname}`));
    assert.equal(
      response.headers.get("x-robots-tag"),
      "noindex, nofollow, noarchive",
      pathname,
    );
  }
});

test("proxy keeps public HTML indexable", () => {
  for (const pathname of ["/", "/catalog", "/about", "/contacts"]) {
    const response = proxy(new NextRequest(`https://kts-impex.ru${pathname}`));
    assert.equal(response.headers.get("x-robots-tag"), null, pathname);
  }
});

test("proxy prevents private pages from being stored", () => {
  for (const pathname of [
    "/admin",
    "/cabinet",
    "/login",
    "/price/private-token",
    "/api/admin/session",
    "/api/client/documents",
    "/api/price/private-token/pdf",
  ]) {
    const response = proxy(new NextRequest(`https://kts-impex.ru${pathname}`));
    assert.equal(response.headers.get("cache-control"), "private, no-store", pathname);
  }
});
