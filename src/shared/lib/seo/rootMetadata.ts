import type { Metadata } from "next";

import {
  DEFAULT_OG_IMAGE_PATH,
  SITE_NAME,
} from "./metadata";
import { canonicalUrl, getCanonicalOrigin } from "./siteUrl";

type RootMetadataOptions = {
  yandexVerification?: string;
};

export const ROOT_TITLE =
  "КТС — компоненты для холодильных и климатических систем";
export const ROOT_DESCRIPTION =
  "Поставляем проверенные компоненты для холодильных и климатических систем по России и СНГ. Подбор оборудования и техническая поддержка.";

export function createHomeMetadata(): Metadata {
  const origin = getCanonicalOrigin();
  const imageUrl = canonicalUrl(DEFAULT_OG_IMAGE_PATH);

  return {
    alternates: {
      canonical: origin,
    },
    openGraph: {
      type: "website",
      locale: "ru_RU",
      siteName: SITE_NAME,
      url: origin,
      title: ROOT_TITLE,
      description: ROOT_DESCRIPTION,
      images: [
        {
          url: imageUrl,
          width: 1567,
          height: 723,
          alt: ROOT_TITLE,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: ROOT_TITLE,
      description: ROOT_DESCRIPTION,
      images: [imageUrl],
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}

export function createRootMetadata({
  yandexVerification,
}: RootMetadataOptions = {}): Metadata {
  const normalizedYandexVerification = yandexVerification?.trim();
  const origin = getCanonicalOrigin();

  return {
    metadataBase: new URL(origin),
    title: {
      default: ROOT_TITLE,
      template: `%s | ${SITE_NAME}`,
    },
    description: ROOT_DESCRIPTION,
    applicationName: SITE_NAME,
    authors: [{ name: SITE_NAME, url: origin }],
    creator: SITE_NAME,
    publisher: SITE_NAME,
    ...(normalizedYandexVerification
      ? {
          verification: {
            yandex: normalizedYandexVerification,
          },
        }
      : {}),
  };
}
