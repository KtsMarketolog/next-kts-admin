import assert from "node:assert/strict";
import test from "node:test";

import { createRootMetadata } from "../src/shared/lib/seo/rootMetadata";

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
