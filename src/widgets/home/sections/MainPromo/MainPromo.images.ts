import { getImageProps } from "next/image";
import type { HeroSlide } from "@/entities/site/model/defaultSlides";

export const heroImageSizes = "(max-width: 450px) 100vw, (max-width: 1024px) 100vw, 82vw";
export const heroImageQuality = 65;

const heroImageDimensions = {
  desktop: { width: 1567, height: 723 },
  tablet: { width: 988, height: 723 },
  mobile: { width: 800, height: 848 },
};

type HeroImageSourceInput = {
  desktop: string;
  tablet?: string | null;
  mobile?: string | null;
  loading?: "eager" | "lazy";
  decoding?: "auto" | "async" | "sync";
  fetchPriority?: "high" | "low" | "auto";
};

type HeroImageProps = ReturnType<typeof getImageProps>["props"];

export type HeroImagePropsSet = {
  desktop: HeroImageProps;
  tablet: HeroImageProps;
  mobile: HeroImageProps;
};

function isUploadedImage(src: string) {
  return src.startsWith("/uploads/");
}

function getRawImageProps({
  src,
  loading,
  decoding,
  fetchPriority,
  width,
  height,
}: {
  src: string;
  loading: "eager" | "lazy";
  decoding: "auto" | "async" | "sync";
  fetchPriority?: "high" | "low" | "auto";
  width: number;
  height: number;
}): HeroImageProps {
  return {
    src,
    srcSet: src,
    sizes: heroImageSizes,
    alt: "",
    loading,
    decoding,
    width,
    height,
    ...(fetchPriority ? { fetchPriority } : {}),
  } as HeroImageProps;
}

function getHeroImageProps({
  src,
  loading,
  decoding,
  fetchPriority,
  width,
  height,
}: {
  src: string;
  loading: "eager" | "lazy";
  decoding: "auto" | "async" | "sync";
  fetchPriority?: "high" | "low" | "auto";
  width: number;
  height: number;
}) {
  if (isUploadedImage(src)) {
    return getRawImageProps({ src, loading, decoding, fetchPriority, width, height });
  }

  return getImageProps({
    src,
    alt: "",
    sizes: heroImageSizes,
    quality: heroImageQuality,
    loading,
    decoding,
    width,
    height,
    ...(fetchPriority ? { fetchPriority } : {}),
  }).props;
}

export function getHeroImagePropsSet({
  desktop,
  tablet,
  mobile,
  loading = "lazy",
  decoding = "async",
  fetchPriority,
}: HeroImageSourceInput): HeroImagePropsSet {
  const desktopImage = getHeroImageProps({
    src: desktop,
    loading,
    decoding,
    width: heroImageDimensions.desktop.width,
    height: heroImageDimensions.desktop.height,
    fetchPriority,
  });

  const tabletImage = getHeroImageProps({
    src: tablet || desktop,
    loading,
    decoding,
    width: heroImageDimensions.tablet.width,
    height: heroImageDimensions.tablet.height,
    fetchPriority,
  });

  const mobileImage = getHeroImageProps({
    src: mobile || tablet || desktop,
    loading,
    decoding,
    width: heroImageDimensions.mobile.width,
    height: heroImageDimensions.mobile.height,
    fetchPriority,
  });

  return {
    desktop: desktopImage,
    tablet: tabletImage,
    mobile: mobileImage,
  };
}

export function getHeroSlideImagePropsSet(slide: Pick<HeroSlide, "imageUrl" | "tabletImageUrl" | "mobileImageUrl">) {
  return getHeroImagePropsSet({
    desktop: slide.imageUrl,
    tablet: slide.tabletImageUrl,
    mobile: slide.mobileImageUrl,
    loading: "eager",
    decoding: "sync",
    fetchPriority: "high",
  });
}
