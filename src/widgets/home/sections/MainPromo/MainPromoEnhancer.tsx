"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import type { HeroSlide } from "@/entities/site/model/defaultSlides";
import { prepareSlides } from "./MainPromo.prepare";
import type { Slide, SlideAction, Viewport } from "./MainPromo.model";
import { MainPromoPagination } from "./MainPromoPagination";
import { MainPromoPopup } from "./MainPromoPopup";
import { MainPromoSlide } from "./MainPromoSlide";

type SlotElement = {
  index: number;
  element: Element;
};

type MainPromoEnhancerProps = {
  initialSlides?: HeroSlide[];
};

const AUTO_DELAY = 4000;
const INITIAL_AUTO_DELAY = 8000;

export function MainPromoEnhancer({ initialSlides }: MainPromoEnhancerProps) {
  const router = useRouter();
  const slides = useMemo(() => prepareSlides(initialSlides), [initialSlides]);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const slideWidthRef = useRef(0);
  const slideStepRef = useRef(0);
  const autoTimerRef = useRef<number | null>(null);
  const initialAutoTimerRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const popupRef = useRef<Slide | null>(null);
  const pageIndexRef = useRef(0);

  const [pageIndex, setPageIndex] = useState(0);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [popupSlide, setPopupSlide] = useState<Slide | null>(null);
  const [slotElements, setSlotElements] = useState<SlotElement[]>([]);

  const clearRestart = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const stopAutoplay = useCallback(() => {
    if (initialAutoTimerRef.current) {
      clearTimeout(initialAutoTimerRef.current);
      initialAutoTimerRef.current = null;
    }

    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
  }, []);

  const startAutoplay = useCallback((delay = 0) => {
    const track = trackRef.current;
    if (autoTimerRef.current || initialAutoTimerRef.current || !track || popupRef.current || slides.length <= 1) {
      return;
    }

    const runAutoplay = () => {
      initialAutoTimerRef.current = null;
      const currentTrack = trackRef.current;
      if (autoTimerRef.current || !currentTrack || popupRef.current || slides.length <= 1) return;

      autoTimerRef.current = window.setInterval(() => {
        const container = trackRef.current;
        if (!container) return;

        const nextIndex = (pageIndexRef.current + 1) % slides.length;
        const slideStep = slideStepRef.current || slideWidthRef.current || container.clientWidth;
        if (!slideStep) return;

        container.scrollTo({
          left: nextIndex * slideStep,
          behavior: "smooth",
        });
        pageIndexRef.current = nextIndex;
      }, AUTO_DELAY);
    };

    if (delay > 0) {
      initialAutoTimerRef.current = window.setTimeout(runAutoplay, delay);
      return;
    }

    runAutoplay();
  }, [slides.length]);

  const pauseAndRestart = useCallback(
    (delay = 3000) => {
      stopAutoplay();
      clearRestart();

      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null;
        startAutoplay();
      }, delay);
    },
    [clearRestart, startAutoplay, stopAutoplay]
  );

  const canOpen = useCallback((slide: Slide) => Boolean(slide.popup), []);

  const openSlide = useCallback(
    (slide: Slide) => {
      if (slide.href) {
        router.push(slide.href);
        return;
      }

      if (canOpen(slide)) {
        setPopupSlide(slide);
      }
    },
    [canOpen, router]
  );

  const handleSlideClick = useCallback((slide: Slide) => {
    openSlide(slide);
  }, [openSlide]);

  const handleSlideKeyDown = useCallback(
    (slide: Slide) =>
      (event: React.KeyboardEvent) => {
        const isActivate = event.key === "Enter" || event.key === " ";
        if (!isActivate || (!slide.href && !canOpen(slide))) return;

        event.preventDefault();
        openSlide(slide);
      },
    [canOpen, openSlide]
  );

  const shouldShowAction = useCallback(
    (action: SlideAction) => {
      if (!action.showOn || action.showOn === "all") return true;
      if (action.showOn === "mobile") return viewport === "mobile";
      if (action.showOn === "tablet") return viewport === "tablet";
      if (action.showOn === "desktop") return viewport === "desktop";
      return true;
    },
    [viewport]
  );

  const shouldRenderSlot = useCallback(
    (idx: number) => {
      if (idx === 0) return false;
      if (idx === pageIndex || slides.length <= 1) return true;

      const nextIndex = (pageIndex + 1) % slides.length;
      const previousIndex = pageIndex === 0 ? null : pageIndex - 1;

      return idx === nextIndex || idx === previousIndex;
    },
    [pageIndex, slides.length]
  );

  const updatePageIndexFromScroll = useCallback(() => {
    const container = trackRef.current;
    if (!container) return;

    const slideWidth = slideWidthRef.current || container.clientWidth;
    const slideStep = slideStepRef.current || slideWidth;
    if (!slideStep) return;

    const index = Math.min(slides.length - 1, Math.max(0, Math.round(container.scrollLeft / slideStep)));
    pageIndexRef.current = index;
    setPageIndex((current) => (current === index ? current : index));
  }, [slides.length]);

  const scrollToSlide = useCallback(
    (idx: number) => {
      const container = trackRef.current;
      if (!container) return;

      const nextIndex = Math.min(slides.length - 1, Math.max(0, idx));
      const slideStep = slideStepRef.current || slideWidthRef.current || container.clientWidth;
      if (!slideStep) return;

      pageIndexRef.current = nextIndex;
      setPageIndex(nextIndex);
      container.scrollTo({ left: nextIndex * slideStep, behavior: "smooth" });
      pauseAndRestart();
    },
    [pauseAndRestart, slides.length]
  );

  useEffect(() => {
    const track = document.querySelector<HTMLDivElement>("[data-main-promo-track]");
    if (!track) return;

    trackRef.current = track;

    setSlotElements(
      Array.from(track.querySelectorAll("[data-main-promo-slot]"))
        .map((element) => ({
          element,
          index: Number((element as HTMLElement).dataset.mainPromoIndex),
        }))
        .filter((slot) => Number.isFinite(slot.index))
    );

    const updateSlideMetrics = () => {
      const gap = Number.parseFloat(window.getComputedStyle(track).columnGap || "0") || 0;
      const slideWidth = track.clientWidth;

      slideWidthRef.current = slideWidth;
      slideStepRef.current = slideWidth + gap;
    };

    const handlePointerPause = () => pauseAndRestart(4000);
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.closest("a,button")) return;

      const visual = target.closest<HTMLElement>("[data-main-promo-visual]");
      if (!visual || visual.dataset.mainPromoIndex !== "0") return;

      const firstSlide = slides[0];
      if (!firstSlide?.href && !canOpen(firstSlide)) return;

      openSlide(firstSlide);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const visual = target.closest<HTMLElement>("[data-main-promo-visual]");
      if (!visual || visual.dataset.mainPromoIndex !== "0") return;
      if (event.key !== "Enter" && event.key !== " ") return;

      const firstSlide = slides[0];
      if (!firstSlide?.href && !canOpen(firstSlide)) return;

      event.preventDefault();
      openSlide(firstSlide);
    };

    updateSlideMetrics();
    track.addEventListener("scroll", updatePageIndexFromScroll, { passive: true });
    track.addEventListener("touchstart", handlePointerPause, { passive: true });
    track.addEventListener("pointerdown", handlePointerPause, { passive: true });
    track.addEventListener("click", handleClick);
    track.addEventListener("keydown", handleKeyDown);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSlideMetrics);
    } else {
      observer = new ResizeObserver(updateSlideMetrics);
      observer.observe(track);
    }

    return () => {
      track.removeEventListener("scroll", updatePageIndexFromScroll);
      track.removeEventListener("touchstart", handlePointerPause);
      track.removeEventListener("pointerdown", handlePointerPause);
      track.removeEventListener("click", handleClick);
      track.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateSlideMetrics);
      observer?.disconnect();
      trackRef.current = null;
    };
  }, [canOpen, openSlide, pauseAndRestart, slides, updatePageIndexFromScroll]);

  useEffect(() => {
    pageIndexRef.current = pageIndex;
  }, [pageIndex]);

  useEffect(() => {
    popupRef.current = popupSlide;

    if (popupSlide) {
      stopAutoplay();
      clearRestart();
      return;
    }

    startAutoplay(INITIAL_AUTO_DELAY);

    return () => {
      stopAutoplay();
    };
  }, [popupSlide, clearRestart, startAutoplay, stopAutoplay]);

  useEffect(() => {
    const computeViewport = () => {
      const width = window.innerWidth;
      if (width <= 450) return "mobile" as const;
      if (width <= 1024) return "tablet" as const;
      return "desktop" as const;
    };

    const apply = () => setViewport(computeViewport());
    apply();

    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopAutoplay();
        clearRestart();
      } else {
        startAutoplay(INITIAL_AUTO_DELAY);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [clearRestart, startAutoplay, stopAutoplay]);

  useEffect(
    () => () => {
      stopAutoplay();
      clearRestart();
    },
    [clearRestart, stopAutoplay]
  );

  const popupProps = useMemo(() => {
    if (!popupSlide?.popup) return null;
    return {
      ariaLabel: popupSlide.popup.ariaLabel ?? "Информация",
      scrollContent: popupSlide.popup.scrollContent ?? true,
      content: popupSlide.popup.content,
    };
  }, [popupSlide]);

  return (
    <>
      {slotElements.map(({ index, element }) => {
        const slide = slides[index];
        if (!slide || !shouldRenderSlot(index)) return null;

        return createPortal(
          <MainPromoSlide
            key={slide.id}
            slide={slide}
            slideIndex={index}
            renderSlide
            isFirstSlide={false}
            asSlotContent
            canOpen={canOpen}
            onSlideClick={handleSlideClick}
            onSlideKeyDown={handleSlideKeyDown}
            shouldShowAction={shouldShowAction}
          />,
          element
        );
      })}
      <MainPromoPagination count={slides.length} activeIndex={pageIndex} onSelect={scrollToSlide} />
      <MainPromoPopup popup={popupProps} onClose={() => setPopupSlide(null)} />
    </>
  );
}
