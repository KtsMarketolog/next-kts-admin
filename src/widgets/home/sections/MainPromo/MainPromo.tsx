
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
import { fallbackSlides, mapManagedSlide, type Slide, type SlideAction, type Viewport } from "./MainPromo.model";
import { MainPromoPagination } from "./MainPromoPagination";
import { MainPromoPopup } from "./MainPromoPopup";
import { MainPromoSlide } from "./MainPromoSlide";


export const MainPromo = () => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [slides, setSlides] = useState<Slide[]>(fallbackSlides);
  const router = useRouter();

  // единый стейт брейкпоинтов — и для extraSvg, и для actions
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const isTablet = viewport === "tablet";

  const [popupSlide, setPopupSlide] = useState<Slide | null>(null);
  const closePopup = () => setPopupSlide(null);

  // === autoplay refs/state ===
  const autoTimerRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const popupRef = useRef<Slide | null>(null);
  const pageIndexRef = useRef(0);

  const AUTO_DELAY = 4000;

  const clearRestart = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const stopAutoplay = useCallback(() => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
  }, []);

  const startAutoplay = useCallback(() => {
    if (autoTimerRef.current || !scrollRef.current || popupRef.current) return;

    autoTimerRef.current = window.setInterval(() => {
      const container = scrollRef.current;
      if (!container) return;

      const nextIndex = (pageIndexRef.current + 1) % slides.length;
      container.scrollTo({
        left: nextIndex * container.clientWidth,
        behavior: "smooth",
      });
      pageIndexRef.current = nextIndex;
    }, AUTO_DELAY);
  }, [slides.length]);

  useEffect(() => {
    let alive = true;

    fetch('/api/home-slides', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!alive || !Array.isArray(data?.slides) || data.slides.length === 0) return;

        setSlides(
          data.slides
            .filter((slide: { imageUrl?: unknown }) => typeof slide.imageUrl === 'string' && slide.imageUrl)
            .map((slide: {
              id: number | string;
              imageUrl: string;
              tabletImageUrl?: string | null;
              mobileImageUrl?: string | null;
              popupImageUrl?: string | null;
              popupTabletImageUrl?: string | null;
              popupMobileImageUrl?: string | null;
              popupTitle?: string | null;
              popupText?: string | null;
              linkUrl?: string | null;
              title?: string;
            }) => mapManagedSlide(slide)),
        );
      })
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, []);

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

    startAutoplay();

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
    const { scrollLeft, clientWidth } = container;
    const index = Math.round(scrollLeft / clientWidth);
    setPageIndex(index);
  };

  const scrollToSlide = (idx: number) => {
    const container = scrollRef.current;
    if (!container) return;
    pageIndexRef.current = idx;
    container.scrollTo({ left: idx * container.clientWidth, behavior: "smooth" });
    pauseAndRestart(); // пауза после ручного клика по пагинации
  };

  // не останавливаем на hover — убраны onMouseEnter/Leave handlers
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        stopAutoplay();
        clearRestart();
      } else {
        startAutoplay();
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
              isFirstSlide={idx === 0}
              isTablet={isTablet}
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
