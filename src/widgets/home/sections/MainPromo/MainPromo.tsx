// MainPromo.tsx
import Container from "@/shared/ui/Container";
import type { HeroSlide } from "@/entities/site/model/defaultSlides";
import styles from "./MainPromo.module.scss";
import { prepareSlides } from "./MainPromo.prepare";
import { MainPromoStaticSlide } from "./MainPromoStaticSlide";
import { MainPromoEnhancerLoader } from "./MainPromoEnhancerLoader";

type MainPromoProps = {
  initialSlides?: HeroSlide[];
};

export const MainPromo = ({ initialSlides }: MainPromoProps) => {
  const slides = prepareSlides(initialSlides);
  const firstSlide = slides[0];

  if (!firstSlide) return null;

  return (
    <section className={styles.heroBanner} id="top">
      <Container>
        <div className={styles.scrollWrapper} data-main-promo-track>
          <MainPromoStaticSlide slide={firstSlide} />
          {slides.slice(1).map((slide, index) => (
            <div
              key={slide.id}
              className={styles.slide}
              data-main-promo-slot="true"
              data-main-promo-index={index + 1}
            />
          ))}
        </div>
        <MainPromoEnhancerLoader initialSlides={initialSlides} count={slides.length} />
      </Container>
    </section>
  );
};
