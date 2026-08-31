import type { Metadata } from "next";

import { createPageMetadata } from "@/shared/lib/seo/metadata";

export const metadata: Metadata = createPageMetadata({
  title: "Климатическое оборудование",
  description:
    "Климатические решения КТС: подбор оборудования и компонентов для систем вентиляции, кондиционирования и холодоснабжения.",
  path: "/klimatika",
});

export default function KlimatikaLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
