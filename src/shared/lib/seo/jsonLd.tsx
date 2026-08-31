import { DEFAULT_EMAIL, DEFAULT_PHONE } from "@/shared/lib/phone";

import { canonicalUrl, getCanonicalOrigin } from "./siteUrl";

export type JsonLdValue =
  | null
  | boolean
  | number
  | string
  | JsonLdValue[]
  | { [key: string]: JsonLdValue };

export function serializeJsonLd(value: JsonLdValue): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function JsonLd({ data }: { data: JsonLdValue }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}

export function createGlobalJsonLd(): JsonLdValue {
  const origin = getCanonicalOrigin();
  const organizationId = `${origin}/#organization`;
  const websiteId = `${origin}/#website`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: "КТС",
        url: origin,
        logo: {
          "@type": "ImageObject",
          url: canonicalUrl("/img/logo.svg"),
        },
        telephone: DEFAULT_PHONE,
        email: DEFAULT_EMAIL,
        address: {
          "@type": "PostalAddress",
          streetAddress: "ул. Мамасево, д. 1",
          addressLocality: "Волжск",
          addressRegion: "Республика Марий Эл",
          addressCountry: "RU",
        },
      },
      {
        "@type": "WebSite",
        "@id": websiteId,
        url: origin,
        name: "КТС",
        description:
          "Компоненты для холодильных и климатических систем",
        inLanguage: "ru-RU",
        publisher: {
          "@id": organizationId,
        },
      },
    ],
  };
}

type InformationalPageType = "AboutPage" | "ContactPage";

function createInformationalPageJsonLd({
  type,
  path,
  name,
  description,
}: {
  type: InformationalPageType;
  path: string;
  name: string;
  description: string;
}): JsonLdValue {
  const origin = getCanonicalOrigin();
  const url = canonicalUrl(path);

  return {
    "@context": "https://schema.org",
    "@type": type,
    "@id": `${url}#webpage`,
    url,
    name,
    description,
    inLanguage: "ru-RU",
    isPartOf: {
      "@id": `${origin}/#website`,
    },
    ...(type === "AboutPage"
      ? { about: { "@id": `${origin}/#organization` } }
      : { mainEntity: { "@id": `${origin}/#organization` } }),
  };
}

export function createAboutPageJsonLd(): JsonLdValue {
  return createInformationalPageJsonLd({
    type: "AboutPage",
    path: "/about",
    name: "О компании КТС",
    description:
      "Информация о компании КТС, поставщике компонентов для холодильных и климатических систем.",
  });
}

export function createContactPageJsonLd(): JsonLdValue {
  return createInformationalPageJsonLd({
    type: "ContactPage",
    path: "/contacts",
    name: "Контакты КТС",
    description:
      "Контактная информация КТС для консультаций и подбора оборудования.",
  });
}
