import { AboutHero } from '@/widgets/about/sections/AboutHero/AboutHero';
import { CompanyGallery } from '@/widgets/about/sections/CompanyGallery/CompanyGallery';
import { TeamSection } from '@/widgets/about/sections/TeamSection/TeamSection';
import { InfoBanner } from '@/shared/ui/InfoBanner/InfoBanner';

export default function AboutPage() {

  return (
 
    <>

      <AboutHero />

      <CompanyGallery />

      <TeamSection/>

      <InfoBanner

        id="cooperation"
        variant="team"
        title="Станьте частью успешной команды!"
        description="Приглашаем специалистов, готовых развиваться и строить карьеру в сильной команде"

      />
    
    </>
  )

}