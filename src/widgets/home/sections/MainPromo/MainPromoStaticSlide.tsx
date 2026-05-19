import Button from "@/shared/ui/Button/Button";
import styles from "./MainPromo.module.scss";
import type { Slide } from "./MainPromo.model";
import { getHeroImagePropsSet } from "./MainPromo.images";

type MainPromoStaticSlideProps = {
  slide: Slide;
};

export function MainPromoStaticSlide({ slide }: MainPromoStaticSlideProps) {
  const clickable = Boolean(slide.href) || Boolean(slide.popup);
  const { desktop: desktopImage, tablet: tabletImage, mobile: mobileImage } = getHeroImagePropsSet({
    desktop: slide.bg,
    tablet: slide.tabletBg,
    mobile: slide.mobileBg,
    loading: "eager",
    decoding: "sync",
    fetchPriority: "high",
  });

  return (
    <div className={styles.slide} data-main-promo-slide="0">
      <div
        className={`${styles.visual} ${slide.className ?? ""} ${clickable ? styles.isClickable : ""}`}
        data-main-promo-visual="true"
        data-main-promo-index="0"
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : -1}
      >
        <picture className={styles.bgPicture}>
          <source
            media="(max-width: 450px)"
            srcSet={mobileImage.srcSet ?? mobileImage.src}
            sizes={mobileImage.sizes}
          />
          <source
            media="(max-width: 1024px)"
            srcSet={tabletImage.srcSet ?? tabletImage.src}
            sizes={tabletImage.sizes}
          />
          <img
            {...desktopImage}
            alt=""
            className={styles.bgImage}
          />
        </picture>

        <div className={styles.contentCardBase}>
          {(slide.title || slide.subtitle) && (
            <div className={styles.textWrap}>
              <h1>{slide.title}</h1>
              <span className={styles.subTitle}>{slide.subtitle}</span>
            </div>
          )}

          <div className={styles.buttonsBase}>
            {slide.buttons.map((button, index) => {
              const buttonContent = (
                <Button key={index} variant={button.variant} {...(button.withBg ? { withBg: true } : {})}>
                  {button.text}
                </Button>
              );

              return button.href ? (
                <a key={index} href={button.href} target="_blank" rel="noopener noreferrer">
                  {buttonContent}
                </a>
              ) : (
                buttonContent
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
