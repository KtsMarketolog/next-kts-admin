import { readFile } from "node:fs/promises";

const expectedVerification = process.env.YANDEX_SITE_VERIFICATION?.trim();

if (!expectedVerification) {
  throw new Error("YANDEX_SITE_VERIFICATION is required for the production build");
}

const homepageHtml = await readFile(".next/server/app/index.html", "utf8");
const verificationValues = Array.from(
  homepageHtml.matchAll(
    /<meta\s+name=["']yandex-verification["']\s+content=["']([^"']+)["'][^>]*>/gi,
  ),
  (match) => match[1],
);

if (
  verificationValues.length !== 1 ||
  verificationValues[0] !== expectedVerification
) {
  throw new Error(
    "The production homepage artifact does not contain the configured Yandex verification metadata",
  );
}

console.log("Yandex verification metadata is present in the homepage artifact.");
