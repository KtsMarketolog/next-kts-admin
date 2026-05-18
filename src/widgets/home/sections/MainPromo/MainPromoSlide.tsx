"use client";

import React from "react";
import { getImageProps } from "next/image";

import Button from "@/shared/ui/Button/Button";
import styles from "./MainPromo.module.scss";
import type { Slide, SlideAction } from "./MainPromo.model";

const heroImageSizes = "(max-width: 450px) 100vw, (max-width: 1024px) 100vw, 82vw";

const heroImageDimensions = {
  desktop: { width: 1920, height: 900 },
  tablet: { width: 1024, height: 486 },
  mobile: { width: 800, height: 848 },
};

type MainPromoSlideProps = {
  slide: Slide;
  renderSlide: boolean;
  isFirstSlide: boolean;
  canOpen: (slide: Slide) => boolean;
  onSlideClick: (slide: Slide) => void;
  onSlideKeyDown: (slide: Slide) => (event: React.KeyboardEvent) => void;
  shouldShowAction: (action: SlideAction) => boolean;
};

export function MainPromoSlide({
  slide,
  renderSlide,
  isFirstSlide,
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
  const decoding = isFirstSlide ? "auto" : "async";

  const desktopImage = getImageProps({
    src: slide.bg,
    alt: "",
    sizes: heroImageSizes,
    quality: 75,
    loading,
    decoding,
    width: heroImageDimensions.desktop.width,
    height: heroImageDimensions.desktop.height,
    ...(isFirstSlide ? { fetchPriority: "high" as const } : {}),
  }).props;

  const tabletImage = getImageProps({
    src: slide.tabletBg || slide.bg,
    alt: "",
    sizes: heroImageSizes,
    quality: 75,
    loading,
    decoding,
    width: heroImageDimensions.tablet.width,
    height: heroImageDimensions.tablet.height,
    ...(isFirstSlide ? { fetchPriority: "high" as const } : {}),
  }).props;

  const mobileImage = getImageProps({
    src: slide.mobileBg || slide.tabletBg || slide.bg,
    alt: "",
    sizes: heroImageSizes,
    quality: 75,
    loading,
    decoding,
    width: heroImageDimensions.mobile.width,
    height: heroImageDimensions.mobile.height,
    ...(isFirstSlide ? { fetchPriority: "high" as const } : {}),
  }).props;

  return (
    <div className={styles.slide}>
      <div
        className={`${styles.visual} ${slide.className} ${clickable ? styles.isClickable : ""}`}
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
    </div>
  );
}
