// src/app/page.tsx
import { preload } from "react-dom";
import { DEFAULT_HERO_SLIDES } from "@/entities/site/model/defaultSlides";
import type { HeroSlide } from "@/entities/site/model/defaultSlides";
import { DEFAULT_NEWS } from "@/entities/site/model/defaultNews";
import { GroupCompanies } from "@/widgets/home/sections/GroupCompanies/GroupCompanies";
import { AboutKTS } from "@/widgets/home/sections/AboutKTS/AboutKTS";
import { KeyAdvantages } from "@/widgets/home/sections/KeyAdvantages/KeyAdvantages";
import { PartnersBanner } from "@/widgets/home/sections/PartnersBanner/PartnersBanner";
import { PromotionsBlock } from "@/widgets/home/sections/PromotionsBlock/PromotionsBlock";
import { MainPromo } from "@/widgets/home/sections/MainPromo/MainPromo";
import { ProductsShowcase } from "@/widgets/home/sections/ProductsShowcase/ProductsShowcase";
import { BrandPortfolio } from '@/widgets/home/sections/BrandPortfolio/BrandPortfolio';
import { NewsBlock } from "@/widgets/home/sections/NewsBlock/NewsBlock";
import HashCleanup from "@/shared/lib/HashCleanup";
import { getBrandPortfolio, getHeroSlides, getNewsItems } from "@/shared/lib/db";
import { getHeroSlideImagePropsSet } from "@/widgets/home/sections/MainPromo/MainPromo.images";

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

function preloadHomeHero(slide: HeroSlide | undefined) {
  if (!slide) return;

  const { desktop, tablet, mobile } = getHeroSlideImagePropsSet(slide);

  const preloadImage = (
    image: typeof desktop,
    media: string,
  ) => {
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
  const [slides, news, brandPortfolio] = await Promise.all([
    getHomeSlides(),
    getHomeNews(),
    getHomeBrandPortfolio(),
  ]);

  preloadHomeHero(slides[0]);

  return (

    <div>

      <MainPromo initialSlides={slides} />
      <GroupCompanies />
      <AboutKTS />
      <KeyAdvantages />


      <PartnersBanner />
      <PromotionsBlock />
      <ProductsShowcase />
      <NewsBlock initialNews={news} />
      <BrandPortfolio initialCategories={brandPortfolio.categories} initialBrands={brandPortfolio.brands} />
      <HashCleanup />

    </div>

  );

}
