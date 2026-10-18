import type { HeroSlide } from "@/entities/site/model/defaultSlides";
import { fallbackSlides, mapManagedSlide, type Slide } from "./MainPromo.model";

export function prepareSlides(initialSlides?: HeroSlide[]): Slide[] {
  const managedSlides = Array.isArray(initialSlides)
    ? initialSlides.filter((slide) => typeof slide.imageUrl === "string" && slide.imageUrl)
    : [];

  // An explicitly empty list must stay empty, including after hydration.
  return Array.isArray(initialSlides) ? managedSlides.map((slide) => mapManagedSlide(slide)) : fallbackSlides;
}
