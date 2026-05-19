"use client";

import HashCleanup from "@/shared/lib/HashCleanup";
import { AboutKTS } from "@/widgets/home/sections/AboutKTS/AboutKTS";
import { BrandPortfolio } from "@/widgets/home/sections/BrandPortfolio/BrandPortfolio";
import { GroupCompaniesView } from "@/widgets/home/sections/GroupCompanies/GroupCompaniesView";
import { KeyAdvantages } from "@/widgets/home/sections/KeyAdvantages/KeyAdvantages";
import { NewsBlock } from "@/widgets/home/sections/NewsBlock/NewsBlock";
import { PartnersBanner } from "@/widgets/home/sections/PartnersBanner/PartnersBanner";
import { ProductsShowcase } from "@/widgets/home/sections/ProductsShowcase/ProductsShowcase";
import { PromotionsBlock } from "@/widgets/home/sections/PromotionsBlock/PromotionsBlock";

import type { HomeDeferredSectionsProps } from "./HomeDeferredSections.types";

export function HomeDeferredSections({
  groupCompanies,
  news,
  brandCategories,
  brandBrands,
}: HomeDeferredSectionsProps) {
  return (
    <>
      <GroupCompaniesView companies={groupCompanies} />
      <AboutKTS />
      <KeyAdvantages />
      <PartnersBanner />
      <PromotionsBlock />
      <ProductsShowcase />
      <NewsBlock initialNews={news} />
      <BrandPortfolio
        initialCategories={brandCategories}
        initialBrands={brandBrands}
      />
      <HashCleanup />
    </>
  );
}
