import type { Metadata } from "next";

import {
  createAboutPageJsonLd,
  JsonLd,
} from "@/shared/lib/seo/jsonLd";
import { createPageMetadata } from "@/shared/lib/seo/metadata";

export const metadata: Metadata = createPageMetadata({
  title: "О компании",
  description:
    "КТС поставляет компоненты для холодильных и климатических систем, помогает с подбором оборудования и техническими решениями.",
  path: "/about",
});

export default function AboutLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <JsonLd data={createAboutPageJsonLd()} />
      {children}
    </>
  );
}
