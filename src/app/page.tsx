// src/app/page.tsx
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

export const revalidate = 600;

export default function Home() {

  return (

    <div>

      <MainPromo />
      <GroupCompanies />
      <AboutKTS />
      <KeyAdvantages />


      <PartnersBanner />
      <PromotionsBlock />
      <ProductsShowcase />
      <NewsBlock />
      <BrandPortfolio />
      <HashCleanup />

    </div>

  );

}