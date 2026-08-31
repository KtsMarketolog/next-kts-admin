import type { Metadata } from "next";

import { canonicalUrl } from "./siteUrl";

export const SITE_NAME = "КТС";
export const DEFAULT_OG_IMAGE_PATH = "/img/banner/slide2.png";

export type PageMetadataOptions = {
  title: string;
  description: string;
  path: string;
  image?: string;
  index?: boolean;
};

function absoluteImageUrl(image: string): string {
  const trimmed = image.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return canonicalUrl(trimmed || DEFAULT_OG_IMAGE_PATH);
}

export function createPageMetadata({
  title,
  description,
  path,
  image = DEFAULT_OG_IMAGE_PATH,
  index = true,
}: PageMetadataOptions): Metadata {
  const url = canonicalUrl(path);
  const imageUrl = absoluteImageUrl(image);
  const socialTitle = title.includes(SITE_NAME) ? title : `${title} | ${SITE_NAME}`;
  const isDefaultImage = imageUrl === absoluteImageUrl(DEFAULT_OG_IMAGE_PATH);

  return {
    title,
    description,
    alternates: {
      canonical: url,
    },
    robots: index
      ? {
          index: true,
          follow: true,
        }
      : {
          index: false,
          follow: true,
        },
    openGraph: {
      type: "website",
      locale: "ru_RU",
      siteName: SITE_NAME,
      url,
      title: socialTitle,
      description,
      images: [
        isDefaultImage
          ? {
              url: imageUrl,
              width: 1567,
              height: 723,
              alt: socialTitle,
            }
          : {
              url: imageUrl,
              alt: socialTitle,
            },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: [imageUrl],
    },
  };
}
