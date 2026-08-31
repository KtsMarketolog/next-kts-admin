import assert from "node:assert/strict";
import test from "node:test";

import {
  createHomeMetadata,
  createRootMetadata,
} from "../src/shared/lib/seo/rootMetadata";
import { getCanonicalOrigin } from "../src/shared/lib/seo/siteUrl";

test("root metadata contains shared defaults without forcing homepage SEO onto every route", () => {
  const metadata = createRootMetadata();

  assert.equal(new URL(String(metadata.metadataBase)).origin, getCanonicalOrigin());
  assert.equal(metadata.alternates, undefined);
  assert.equal(metadata.openGraph, undefined);
  assert.equal(metadata.twitter, undefined);
  assert.equal(metadata.robots, undefined);
});

test("homepage metadata owns the canonical URL and public indexing directives", () => {
  const metadata = createHomeMetadata();

  assert.equal(metadata.alternates?.canonical, getCanonicalOrigin());
  assert.equal(metadata.openGraph?.url, getCanonicalOrigin());
  assert.deepEqual(metadata.robots, { index: true, follow: true });
});

test("root metadata includes a normalized Yandex verification value", () => {
  const metadata = createRootMetadata({
    yandexVerification: "  test-yandex-verification  ",
  });

  assert.deepEqual(metadata.verification, {
    yandex: "test-yandex-verification",
  });
});

test("root metadata omits verification when the value is not configured", () => {
  for (const yandexVerification of [undefined, "", "   "]) {
    const metadata = createRootMetadata({ yandexVerification });

    assert.equal(Object.hasOwn(metadata, "verification"), false);
  }
});
