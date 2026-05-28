import { useEffect, useMemo, useState } from 'react';

import type { Slide } from '@/features/admin/types';
import type { ResponsiveImageSizes } from '@/features/admin/shared/AdminResponsiveImages';

export type ResponsiveTarget = 'desktop' | 'tablet' | 'mobile';
export type ImageGroup = 'slide' | 'popup';

type ImageSizeInfo = {
  url: string;
  label: string;
};

type ImageSizeGroup = Partial<Record<ResponsiveTarget, ImageSizeInfo>>;
type SlideImageSizes = Record<ImageGroup, ImageSizeGroup>;
type SlideImageSource = Pick<
  Slide,
  | 'imageUrl'
  | 'tabletImageUrl'
  | 'mobileImageUrl'
  | 'popupImageUrl'
  | 'popupTabletImageUrl'
  | 'popupMobileImageUrl'
>;

const IMAGE_SIZE_PENDING = 'определяется...';
const IMAGE_SIZE_UNKNOWN = 'не удалось определить';

function createEmptyImageSizes(): SlideImageSizes {
  return { slide: {}, popup: {} };
}

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

async function readRemoteImageSize(url: string) {
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });

    return response.ok ? formatContentLength(response.headers.get('content-length')) ?? IMAGE_SIZE_UNKNOWN : IMAGE_SIZE_UNKNOWN;
  } catch {
    return IMAGE_SIZE_UNKNOWN;
  }
}

function getResponsiveImages(source: SlideImageSource, group: ImageGroup) {
  const urls: Record<ResponsiveTarget, string | null | undefined> =
    group === 'slide'
      ? {
          desktop: source.imageUrl,
          tablet: source.tabletImageUrl,
          mobile: source.mobileImageUrl,
        }
      : {
          desktop: source.popupImageUrl,
          tablet: source.popupTabletImageUrl,
          mobile: source.popupMobileImageUrl,
        };

  return (Object.entries(urls) as Array<[ResponsiveTarget, string | null | undefined]>).filter(
    (entry): entry is [ResponsiveTarget, string] => Boolean(entry[1]),
  );
}

export function toImageSizeLabels(sizes: ImageSizeGroup): ResponsiveImageSizes {
  return {
    desktop: sizes.desktop?.label,
    tablet: sizes.tablet?.label,
    mobile: sizes.mobile?.label,
  };
}

function setImageSize(current: SlideImageSizes, group: ImageGroup, target: ResponsiveTarget, url: string, label: string) {
  return {
    ...current,
    [group]: {
      ...current[group],
      [target]: { url, label },
    },
  };
}

function removeImageSize(current: SlideImageSizes, group: ImageGroup, target: ResponsiveTarget) {
  const nextGroup = { ...current[group] };
  delete nextGroup[target];

  return {
    ...current,
    [group]: nextGroup,
  };
}

export function slideImagePatch(target: ResponsiveTarget, url: string) {
  return {
    ...(target === 'desktop' ? { imageUrl: url } : {}),
    ...(target === 'tablet' ? { tabletImageUrl: url } : {}),
    ...(target === 'mobile' ? { mobileImageUrl: url } : {}),
  };
}

export function popupImagePatch(target: ResponsiveTarget, url: string) {
  return {
    ...(target === 'desktop' ? { popupImageUrl: url } : {}),
    ...(target === 'tablet' ? { popupTabletImageUrl: url } : {}),
    ...(target === 'mobile' ? { popupMobileImageUrl: url } : {}),
  };
}

export function useSlideImageSizes({ slides, draft }: { slides: Slide[]; draft: Omit<Slide, 'id'> }) {
  const [slideImageSizes, setSlideImageSizes] = useState<Record<number, SlideImageSizes>>({});
  const [draftImageSizes, setDraftImageSizes] = useState<SlideImageSizes>(() => createEmptyImageSizes());
  const draftImageSource = useMemo<SlideImageSource>(
    () => ({
      imageUrl: draft.imageUrl,
      tabletImageUrl: draft.tabletImageUrl,
      mobileImageUrl: draft.mobileImageUrl,
      popupImageUrl: draft.popupImageUrl,
      popupTabletImageUrl: draft.popupTabletImageUrl,
      popupMobileImageUrl: draft.popupMobileImageUrl,
    }),
    [
      draft.imageUrl,
      draft.tabletImageUrl,
      draft.mobileImageUrl,
      draft.popupImageUrl,
      draft.popupTabletImageUrl,
      draft.popupMobileImageUrl,
    ],
  );

  useEffect(() => {
    if (!slides.length) {
      setSlideImageSizes({});
      return;
    }

    let isMounted = true;

    setSlideImageSizes((current) => {
      const next: Record<number, SlideImageSizes> = {};

      for (const slide of slides) {
        let nextSlideSizes = createEmptyImageSizes();

        for (const group of ['slide', 'popup'] as const) {
          for (const [target, url] of getResponsiveImages(slide, group)) {
            const currentInfo = current[slide.id]?.[group]?.[target];
            nextSlideSizes = setImageSize(
              nextSlideSizes,
              group,
              target,
              url,
              currentInfo?.url === url ? currentInfo.label : IMAGE_SIZE_PENDING,
            );
          }
        }

        if (Object.keys(nextSlideSizes.slide).length || Object.keys(nextSlideSizes.popup).length) {
          next[slide.id] = nextSlideSizes;
        }
      }

      return next;
    });

    for (const slide of slides) {
      for (const group of ['slide', 'popup'] as const) {
        for (const [target, url] of getResponsiveImages(slide, group)) {
          void readRemoteImageSize(url).then((label) => {
            if (!isMounted) return;

            setSlideImageSizes((current) => {
              const currentInfo = current[slide.id]?.[group]?.[target];
              if (!currentInfo || currentInfo.url !== url) return current;

              return {
                ...current,
                [slide.id]: setImageSize(current[slide.id] ?? createEmptyImageSizes(), group, target, url, label),
              };
            });
          });
        }
      }
    }

    return () => {
      isMounted = false;
    };
  }, [slides]);

  useEffect(() => {
    let isMounted = true;

    setDraftImageSizes((current) => {
      let next = createEmptyImageSizes();

      for (const group of ['slide', 'popup'] as const) {
        for (const [target, url] of getResponsiveImages(draftImageSource, group)) {
          const currentInfo = current[group][target];
          next = setImageSize(next, group, target, url, currentInfo?.url === url ? currentInfo.label : IMAGE_SIZE_PENDING);
        }
      }

      return next;
    });

    for (const group of ['slide', 'popup'] as const) {
      for (const [target, url] of getResponsiveImages(draftImageSource, group)) {
        void readRemoteImageSize(url).then((label) => {
          if (!isMounted) return;

          setDraftImageSizes((current) => {
            const currentInfo = current[group][target];
            if (!currentInfo || currentInfo.url !== url) return current;

            return setImageSize(current, group, target, url, label);
          });
        });
      }
    }

    return () => {
      isMounted = false;
    };
  }, [draftImageSource]);

  return {
    slideImageSizes,
    draftImageSizes,
    setDraftImageSize: (group: ImageGroup, target: ResponsiveTarget, url: string, label: string) => {
      setDraftImageSizes((current) => setImageSize(current, group, target, url, label));
    },
    removeDraftImageSize: (group: ImageGroup, target: ResponsiveTarget) => {
      setDraftImageSizes((current) => removeImageSize(current, group, target));
    },
    setSavedSlideImageSize: (slideId: number, group: ImageGroup, target: ResponsiveTarget, url: string, label: string) => {
      setSlideImageSizes((current) => ({
        ...current,
        [slideId]: setImageSize(current[slideId] ?? createEmptyImageSizes(), group, target, url, label),
      }));
    },
    removeSavedSlideImageSize: (slideId: number, group: ImageGroup, target: ResponsiveTarget) => {
      setSlideImageSizes((current) => ({
        ...current,
        [slideId]: removeImageSize(current[slideId] ?? createEmptyImageSizes(), group, target),
      }));
    },
  };
}
