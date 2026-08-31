import type { Metadata } from "next";

import {
  createContactPageJsonLd,
  JsonLd,
} from "@/shared/lib/seo/jsonLd";
import { createPageMetadata } from "@/shared/lib/seo/metadata";

export const metadata: Metadata = createPageMetadata({
  title: "Контакты",
  description:
    "Контакты КТС: телефон, электронная почта и адрес. Свяжитесь с нами для подбора компонентов и консультации.",
  path: "/contacts",
});

export default function ContactsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <JsonLd data={createContactPageJsonLd()} />
      {children}
    </>
  );
}
