"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import type { HeroSlide } from "@/entities/site/model/defaultSlides";

type MainPromoEnhancerLoaderProps = {
  initialSlides?: HeroSlide[];
  count: number;
};

const MainPromoEnhancer = dynamic(
  () => import("./MainPromoEnhancer").then((module) => module.MainPromoEnhancer),
  { ssr: false, loading: () => null }
);

function StaticPagination({ count }: { count: number }) {
  return (
    <div className="kts-main-promo__pagination" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={`kts-main-promo__dot${index === 0 ? " kts-main-promo__dot--active" : ""}`}
        />
      ))}
    </div>
  );
}

export function MainPromoEnhancerLoader({ initialSlides, count }: MainPromoEnhancerLoaderProps) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const win = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (typeof win.requestIdleCallback === "function" && typeof win.cancelIdleCallback === "function") {
      const idleId = win.requestIdleCallback(() => setEnabled(true), { timeout: 1200 });
      return () => win.cancelIdleCallback?.(idleId);
    }

    let secondFrameId = 0;
    const frameId = win.requestAnimationFrame(() => {
      secondFrameId = win.requestAnimationFrame(() => setEnabled(true));
    });

    return () => {
      win.cancelAnimationFrame(frameId);
      if (secondFrameId) {
        win.cancelAnimationFrame(secondFrameId);
      }
    };
  }, []);

  if (!enabled) {
    return <StaticPagination count={count} />;
  }

  return <MainPromoEnhancer initialSlides={initialSlides} />;
}
