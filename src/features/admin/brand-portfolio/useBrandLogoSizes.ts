import { useEffect, useState } from 'react';

import type { Brand } from '@/features/admin/types';

export const BRAND_LOGO_SIZE_PENDING = 'определяется...';
const BRAND_LOGO_SIZE_UNKNOWN = 'не удалось определить';

type BrandLogoSize = {
  url: string;
  label: string;
};

export function formatFileSize(bytes: number) {
  const kilobytes = bytes / 1024;

  if (kilobytes < 1024) {
    return `${Math.ceil(kilobytes)} КБ`;
  }

  return `${(kilobytes / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function formatContentLength(contentLength: string | null) {
  const bytes = Number(contentLength);

  return Number.isFinite(bytes) && bytes > 0 ? formatFileSize(bytes) : null;
}

function readRemoteLogoSize(imageUrl: string, onDone: (label: string) => void) {
  fetch(imageUrl, { method: 'HEAD', cache: 'no-store' })
    .then((response) => (response.ok ? formatContentLength(response.headers.get('content-length')) : null))
    .then((label) => onDone(label ?? BRAND_LOGO_SIZE_UNKNOWN))
    .catch(() => onDone(BRAND_LOGO_SIZE_UNKNOWN));
}

export function useBrandLogoSizes({ brands, draftImageUrl }: { brands: Brand[]; draftImageUrl: string }) {
  const [brandLogoSizes, setBrandLogoSizes] = useState<Record<number, BrandLogoSize>>({});
  const [brandDraftLogoSize, setBrandDraftLogoSize] = useState<BrandLogoSize | null>(null);

  useEffect(() => {
    const brandsWithLogos = brands.filter((brand) => brand.imageUrl);

    if (!brandsWithLogos.length) {
      setBrandLogoSizes({});
      return;
    }

    let isMounted = true;

    setBrandLogoSizes((current) => {
      const next: Record<number, BrandLogoSize> = {};

      for (const brand of brandsWithLogos) {
        const currentSize = current[brand.id];
        next[brand.id] =
          currentSize?.url === brand.imageUrl
            ? currentSize
            : { url: brand.imageUrl, label: BRAND_LOGO_SIZE_PENDING };
      }

      return next;
    });

    for (const brand of brandsWithLogos) {
      const imageUrl = brand.imageUrl;

      readRemoteLogoSize(imageUrl, (label) => {
        if (!isMounted) return;

        setBrandLogoSizes((current) => {
          const currentSize = current[brand.id];
          if (currentSize?.url !== imageUrl) return current;

          return {
            ...current,
            [brand.id]: { url: imageUrl, label },
          };
        });
      });
    }

    return () => {
      isMounted = false;
    };
  }, [brands]);

  useEffect(() => {
    if (!draftImageUrl) {
      setBrandDraftLogoSize(null);
      return;
    }

    if (brandDraftLogoSize?.url === draftImageUrl) {
      return;
    }

    let isMounted = true;
    const imageUrl = draftImageUrl;

    setBrandDraftLogoSize({ url: imageUrl, label: BRAND_LOGO_SIZE_PENDING });

    readRemoteLogoSize(imageUrl, (label) => {
      if (isMounted) setBrandDraftLogoSize({ url: imageUrl, label });
    });

    return () => {
      isMounted = false;
    };
  }, [draftImageUrl, brandDraftLogoSize?.url]);

  return {
    brandLogoSizes,
    brandDraftLogoSize,
    setBrandDraftLogoSize,
    setSavedBrandLogoSize: (brandId: number, url: string, label: string) => {
      setBrandLogoSizes((current) => ({
        ...current,
        [brandId]: { url, label },
      }));
    },
  };
}
