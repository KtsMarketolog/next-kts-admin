"use client";

import React from "react";

import Button from "@/shared/ui/Button/Button";
import styles from "./MainPromo.module.scss";
import type { Slide, SlideAction } from "./MainPromo.model";

type MainPromoSlideProps = {
  slide: Slide;
  isFirstSlide: boolean;
  isTablet: boolean;
  canOpen: (slide: Slide) => boolean;
  onSlideClick: (slide: Slide) => void;
  onSlideKeyDown: (slide: Slide) => (event: React.KeyboardEvent) => void;
  shouldShowAction: (action: SlideAction) => boolean;
};

export function MainPromoSlide({
  slide,
  isFirstSlide,
  isTablet,
  canOpen,
  onSlideClick,
  onSlideKeyDown,
  shouldShowAction,
}: MainPromoSlideProps) {
  const clickable = Boolean(slide.href) || canOpen(slide);

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
          <source media="(max-width: 450px)" srcSet={slide.mobileBg} />
          <source media="(max-width: 1024px)" srcSet={slide.tabletBg} />
          <img
            src={slide.bg}
            alt=""
            className={styles.bgImage}
            loading={isFirstSlide ? "eager" : "lazy"}
            fetchPriority={isFirstSlide ? "high" : undefined}
            decoding={isFirstSlide ? "auto" : "async"}
          />
        </picture>

        {slide.extraSvg && (
          <img
            src={isTablet && slide.extraSvgTablet ? slide.extraSvgTablet : slide.extraSvg}
            alt=""
            className={styles.extraSvg}
            loading={isFirstSlide ? "eager" : "lazy"}
            decoding={isFirstSlide ? "auto" : "async"}
          />
        )}

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
