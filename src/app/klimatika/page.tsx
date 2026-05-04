import { KlimatikaHero } from "@/widgets/klimatika/sections/KlimatikaHero/KlimatikaHero";
import { InfoBanner } from '@/shared/ui/InfoBanner/InfoBanner';
import { AreasOfUse } from "@/widgets/klimatika/sections/AreasOfUse/AreasOfUse";
import { TechSolutions } from "@/widgets/klimatika/sections/TechSolutions/TechSolutions";



export default function KlimatikaPage() {

  return (

    <>

      <KlimatikaHero />

      <AreasOfUse />

      <TechSolutions/>

      <InfoBanner

        variant="uniray"
        title="УЗНАЙТЕ БОЛЬШЕ О UNIRAY"
        description="Наши специалисты проконсультируют о преимуществах оборудования"

      />

    </>

  );
  
}