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

export function getHeroImagePropsSet({
  desktop,
  tablet,
  mobile,
  loading = "lazy",
  decoding = "async",
  fetchPriority,
}: HeroImageSourceInput): HeroImagePropsSet {
  const priorityProps = fetchPriority ? { fetchPriority } : {};

  const desktopImage = getImageProps({
    src: desktop,
    alt: "",
    sizes: heroImageSizes,
    quality: heroImageQuality,
    loading,
    decoding,
    width: heroImageDimensions.desktop.width,
    height: heroImageDimensions.desktop.height,
    ...priorityProps,
  }).props;

  const tabletImage = getImageProps({
    src: tablet || desktop,
    alt: "",
    sizes: heroImageSizes,
    quality: heroImageQuality,
    loading,
    decoding,
    width: heroImageDimensions.tablet.width,
    height: heroImageDimensions.tablet.height,
    ...priorityProps,
  }).props;

  const mobileImage = getImageProps({
    src: mobile || tablet || desktop,
    alt: "",
    sizes: heroImageSizes,
    quality: heroImageQuality,
    loading,
    decoding,
    width: heroImageDimensions.mobile.width,
    height: heroImageDimensions.mobile.height,
    ...priorityProps,
  }).props;

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
