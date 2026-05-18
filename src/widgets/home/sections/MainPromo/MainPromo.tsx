
// MainPromo.tsx
"use client";

import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import styles from "./MainPromo.module.scss";
import Container from '@/shared/ui/Container';
import { useRouter } from "next/navigation";
import type { HeroSlide } from "@/entities/site/model/defaultSlides";
import { fallbackSlides, mapManagedSlide, type Slide, type SlideAction, type Viewport } from "./MainPromo.model";
import { MainPromoPagination } from "./MainPromoPagination";
import { MainPromoPopup } from "./MainPromoPopup";
import { MainPromoSlide } from "./MainPromoSlide";


type MainPromoProps = {
  initialSlides?: HeroSlide[];
};

function prepareSlides(initialSlides?: HeroSlide[]) {
  const managedSlides = Array.isArray(initialSlides)
    ? initialSlides.filter((slide) => typeof slide.imageUrl === "string" && slide.imageUrl)
    : [];

  return managedSlides.length ? managedSlides.map((slide) => mapManagedSlide(slide)) : fallbackSlides;
}

const AUTO_DELAY = 4000;
const INITIAL_AUTO_DELAY = 8000;

export const MainPromo = ({ initialSlides }: MainPromoProps) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const slideWidthRef = useRef(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMounted, setHasMounted] = useState(false);
  const slides = useMemo<Slide[]>(() => prepareSlides(initialSlides), [initialSlides]);
  const router = useRouter();

  // единый стейт брейкпоинтов для actions
  const [viewport, setViewport] = useState<Viewport>("desktop");

  const [popupSlide, setPopupSlide] = useState<Slide | null>(null);
  const closePopup = () => setPopupSlide(null);

  // === autoplay refs/state ===
  const autoTimerRef = useRef<number | null>(null);
  const initialAutoTimerRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const popupRef = useRef<Slide | null>(null);
  const pageIndexRef = useRef(0);
  const slideStepRef = useRef(0);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const updateSlideMetrics = () => {
      const gap = Number.parseFloat(window.getComputedStyle(container).columnGap || "0") || 0;
      const slideWidth = container.clientWidth;

      slideWidthRef.current = slideWidth;
      slideStepRef.current = slideWidth + gap;
    };

    updateSlideMetrics();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSlideMetrics);
      return () => window.removeEventListener("resize", updateSlideMetrics);
    }

    const observer = new ResizeObserver(updateSlideMetrics);

    observer.observe(container);

    return () => observer.disconnect();
  }, []);

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
    if (autoTimerRef.current || initialAutoTimerRef.current || !scrollRef.current || popupRef.current || slides.length <= 1) {
      return;
    }

    const runAutoplay = () => {
      initialAutoTimerRef.current = null;
      if (autoTimerRef.current || !scrollRef.current || popupRef.current || slides.length <= 1) return;

      autoTimerRef.current = window.setInterval(() => {
        const container = scrollRef.current;
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
    pageIndexRef.current = pageIndex;
  }, [pageIndex]);

  useEffect(() => {
    const computeViewport = () => {
      const w = window.innerWidth;
      if (w <= 450) return "mobile" as const;
      if (w <= 1024) return "tablet" as const;
      return "desktop" as const;
    };

    const apply = () => setViewport(computeViewport());
    apply();

    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const slideWidth = slideWidthRef.current || container.clientWidth;
    const slideStep = slideStepRef.current || slideWidth;
    if (!slideStep) return;

    const index = Math.min(slides.length - 1, Math.max(0, Math.round(container.scrollLeft / slideStep)));
    setPageIndex((current) => (current === index ? current : index));
  };

  const scrollToSlide = (idx: number) => {
    const container = scrollRef.current;
    if (!container) return;
    const nextIndex = Math.min(slides.length - 1, Math.max(0, idx));
    const slideStep = slideStepRef.current || slideWidthRef.current || container.clientWidth;
    if (!slideStep) return;

    pageIndexRef.current = nextIndex;
    setPageIndex(nextIndex);
    container.scrollTo({ left: nextIndex * slideStep, behavior: "smooth" });
    pauseAndRestart(); // пауза после ручного клика по пагинации
  };

  // не останавливаем на hover — убраны onMouseEnter/Leave handlers
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        stopAutoplay();
        clearRestart();
      } else {
        startAutoplay(INITIAL_AUTO_DELAY);
      }
    };

    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [clearRestart, startAutoplay, stopAutoplay]);

  useEffect(
    () => () => {
      stopAutoplay();
      clearRestart();
    },
    [clearRestart, stopAutoplay]
  );

  const canOpen = useCallback((slide: Slide) => Boolean(slide.popup), []);

  const handleSlideClick = (slide: Slide) => {
    if (slide.href) {
      router.push(slide.href);
      return;
    }
    if (canOpen(slide)) setPopupSlide(slide);
  };

  const handleSlideKeyDown =
    (slide: Slide) =>
    (e: React.KeyboardEvent) => {
      const isActivate = e.key === "Enter" || e.key === " ";
      if (!isActivate) return;

      if (slide.href) {
        e.preventDefault();
        router.push(slide.href);
        return;
      }

      if (!canOpen(slide)) return;
      e.preventDefault();
      setPopupSlide(slide);
    };


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

  const shouldRenderSlide = useCallback(
    (idx: number) => {
      if (idx === pageIndex || slides.length <= 1) return true;
      if (!hasMounted) return false;

      const nextIndex = (pageIndex + 1) % slides.length;
      const previousIndex = pageIndex === 0 ? null : pageIndex - 1;

      return idx === nextIndex || idx === previousIndex;
    },
    [hasMounted, pageIndex, slides.length]
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
    <section className={styles.heroBanner} id="top">
      <Container>
        <div
          className={styles.scrollWrapper}
          ref={scrollRef}
          onScroll={handleScroll}
          onTouchStart={() => pauseAndRestart(4000)}
          onPointerDown={() => pauseAndRestart(4000)}
        >
          {slides.map((slide, idx) => (
            <MainPromoSlide
              key={slide.id}
              slide={slide}
              renderSlide={shouldRenderSlide(idx)}
              isFirstSlide={idx === 0}
              canOpen={canOpen}
              onSlideClick={handleSlideClick}
              onSlideKeyDown={handleSlideKeyDown}
              shouldShowAction={shouldShowAction}
            />
          ))}
        </div>
        <MainPromoPagination count={slides.length} activeIndex={pageIndex} onSelect={scrollToSlide} />
      </Container>
      <MainPromoPopup popup={popupProps} onClose={closePopup} />
    </section>
  );
};
