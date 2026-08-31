// src/app/page.tsx
import type { Metadata } from "next";
import { preload } from "react-dom";
import { DEFAULT_GROUP_COMPANIES } from "@/entities/site/model/defaultGroupCompanies";
import { DEFAULT_HERO_SLIDES, type HeroSlide } from "@/entities/site/model/defaultSlides";
import { DEFAULT_NEWS } from "@/entities/site/model/defaultNews";
import { HomeDeferredSections } from "@/widgets/home/HomeDeferredSections";
import { MainPromo } from "@/widgets/home/sections/MainPromo/MainPromo";
import {
  getBrandPortfolio,
  getGroupCompanies,
  getHeroSlides,
  getNewsItems,
} from "@/shared/lib/db";
import { getHeroSlideImagePropsSet } from "@/widgets/home/sections/MainPromo/MainPromo.images";
import { createHomeMetadata } from "@/shared/lib/seo/rootMetadata";

export const metadata: Metadata = createHomeMetadata();

export const revalidate = 600;

async function getHomeSlides() {
  try {
    const slides = await getHeroSlides({ activeOnly: true });
    if (slides.length) return slides;
  } catch {
    // Fall back to static slides when the database is unavailable during ISR/build.
  }

  return DEFAULT_HERO_SLIDES.map((slide, index) => ({ id: index + 1, ...slide }));
}

async function getHomeNews() {
  try {
    return await getNewsItems({ activeOnly: true });
  } catch {
    return DEFAULT_NEWS;
  }
}

async function getHomeBrandPortfolio() {
  try {
    return await getBrandPortfolio({ activeOnly: true });
  } catch {
    return { categories: [], brands: [] };
  }
}

async function getHomeGroupCompanies() {
  try {
    return await getGroupCompanies({ activeOnly: true });
  } catch {
    return DEFAULT_GROUP_COMPANIES;
  }
}

function preloadHomeHero(slide: HeroSlide | undefined) {
  if (!slide) return;

  const { desktop, tablet, mobile } = getHeroSlideImagePropsSet(slide);

  const preloadImage = (image: typeof desktop, media: string) => {
    if (!image.src) return;

    preload(String(image.src), {
      as: "image",
      fetchPriority: "high",
      imageSrcSet: typeof image.srcSet === "string" ? image.srcSet : undefined,
      imageSizes: typeof image.sizes === "string" ? image.sizes : undefined,
      media,
    });
  };

  preloadImage(mobile, "(max-width: 450px)");
  preloadImage(tablet, "(min-width: 451px) and (max-width: 1024px)");
  preloadImage(desktop, "(min-width: 1025px)");
}

export default async function Home() {
  const [slides, groupCompanies, news, brandPortfolio] = await Promise.all([
    getHomeSlides(),
    getHomeGroupCompanies(),
    getHomeNews(),
    getHomeBrandPortfolio(),
  ]);

  preloadHomeHero(slides[0]);

  return (
    <div>
      <MainPromo initialSlides={slides} />
      <HomeDeferredSections
        groupCompanies={groupCompanies}
        news={news}
        brandCategories={brandPortfolio.categories}
        brandBrands={brandPortfolio.brands}
      />
    </div>
  );
}
