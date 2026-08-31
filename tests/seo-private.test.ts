import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import test from "node:test";

import { NextRequest } from "next/server";

import { config, proxy } from "../src/proxy";
import { createPrivateMetadata } from "../src/shared/lib/seo/privateMetadata";

const requireForNextTesting = createRequire(import.meta.url);

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

test("large TOP data upload bypasses proxy buffering without bypassing adjacent routes", () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    AsyncLocalStorage?: typeof AsyncLocalStorage;
  };
  runtimeGlobal.AsyncLocalStorage ??= AsyncLocalStorage;
  const { unstable_doesMiddlewareMatch } = requireForNextTesting(
    "next/experimental/testing/server",
  ) as {
    unstable_doesMiddlewareMatch: (input: {
      config: typeof config;
      nextConfig: Record<string, never>;
      url: string;
      headers?: Record<string, string>;
    }) => boolean;
  };
  const matches = (url: string, headers?: Record<string, string>) =>
    unstable_doesMiddlewareMatch({ config, nextConfig: {}, url, headers });

  assert.equal(matches("/api/admin/top-dashboard/blocks/7/data"), true);
  assert.equal(
    matches("/api/admin/top-dashboard/blocks/7/data", { "x-kts-top-data-upload": "1" }),
    false,
  );
  assert.equal(
    matches("/api/admin/top-dashboard/blocks/7/data/active", {
      "x-kts-top-data-upload": "1",
    }),
    true,
  );
  assert.equal(matches("/api/admin/top-dashboard/blocks/7/versions"), true);
});
