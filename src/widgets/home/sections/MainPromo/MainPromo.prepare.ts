import type { HeroSlide } from "@/entities/site/model/defaultSlides";
import { fallbackSlides, mapManagedSlide, type Slide } from "./MainPromo.model";

export function prepareSlides(initialSlides?: HeroSlide[]): Slide[] {
  const managedSlides = Array.isArray(initialSlides)
    ? initialSlides.filter((slide) => typeof slide.imageUrl === "string" && slide.imageUrl)
    : [];

  return managedSlides.length ? managedSlides.map((slide) => mapManagedSlide(slide)) : fallbackSlides;
}
