"use client";

import React from "react";

import Button from "@/shared/ui/Button/Button";
import styles from "./MainPromo.module.scss";
import type { Slide, SlideAction } from "./MainPromo.model";
import { getHeroImagePropsSet } from "./MainPromo.images";

type MainPromoSlideProps = {
  slide: Slide;
  slideIndex?: number;
  renderSlide: boolean;
  isFirstSlide: boolean;
  asSlotContent?: boolean;
  canOpen: (slide: Slide) => boolean;
  onSlideClick: (slide: Slide) => void;
  onSlideKeyDown: (slide: Slide) => (event: React.KeyboardEvent) => void;
  shouldShowAction: (action: SlideAction) => boolean;
};

export function MainPromoSlide({
  slide,
  slideIndex,
  renderSlide,
  isFirstSlide,
  asSlotContent = false,
  canOpen,
  onSlideClick,
  onSlideKeyDown,
  shouldShowAction,
}: MainPromoSlideProps) {
  if (!renderSlide) {
    return <div className={styles.slide} aria-hidden="true" />;
  }

  const clickable = Boolean(slide.href) || canOpen(slide);
  const loading = isFirstSlide ? "eager" : "lazy";
  const decoding = isFirstSlide ? "sync" : "async";

  const { desktop: desktopImage, tablet: tabletImage, mobile: mobileImage } = getHeroImagePropsSet({
    desktop: slide.bg,
    tablet: slide.tabletBg,
    mobile: slide.mobileBg,
    loading,
    decoding,
    ...(isFirstSlide ? { fetchPriority: "high" as const } : {}),
  });

  const visual = (
      <div
        className={`${styles.visual} ${slide.className ?? ""} ${clickable ? styles.isClickable : ""}`}
        data-main-promo-visual="true"
        data-main-promo-index={slideIndex}
        onClick={() => onSlideClick(slide)}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : -1}
        aria-label={slide.href ? "Перейти в раздел Климатика" : clickable ? "Открыть подробности" : undefined}
        onKeyDown={onSlideKeyDown(slide)}
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
            alt={typeof slide.title === "string" && slide.title.trim()
              ? slide.title
              : "Предложения и решения КТС"}
            className={styles.bgImage}
          />
        </picture>

        <div className={styles.contentCardBase}>
          {(slide.title || slide.subtitle) && (
            <div className={styles.textWrap}>
              <h2>{slide.title}</h2>
              <span className={styles.subTitle}>{slide.subtitle}</span>
            </div>
          )}

          <div className={styles.buttonsBase} onClickCapture={(event) => event.stopPropagation()}>
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

        {slide.actions?.map((action, index) => {
          if (!shouldShowAction(action)) return null;

          const actionButton = (
            <Button
              key={index}
              variant={action.button.variant}
              {...(action.button.withBg ? { withBg: true } : {})}
            >
              {action.button.text}
            </Button>
          );

          return (
            <div
              key={index}
              className={`${styles.slideAction} ${action.positionClass}`}
              onClickCapture={(event) => event.stopPropagation()}
            >
              {action.button.href ? (
                <a href={action.button.href} target="_blank" rel="noopener noreferrer">
                  {actionButton}
                </a>
              ) : (
                actionButton
              )}
            </div>
          );
        })}
      </div>
  );

  if (asSlotContent) {
    return visual;
  }

  return (
    <div className={styles.slide}>
      {visual}
    </div>
  );
}
