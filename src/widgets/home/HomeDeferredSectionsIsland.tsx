"use client";

import { useEffect, useState, type ComponentType } from "react";

import { HomeDeferredSectionsFallback } from "./HomeDeferredSectionsFallback";
import type { HomeDeferredSectionsProps } from "./HomeDeferredSections.types";

type IdleWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

export function HomeDeferredSectionsIsland(props: HomeDeferredSectionsProps) {
  const [DeferredSections, setDeferredSections] = useState<ComponentType<HomeDeferredSectionsProps> | null>(null);

  useEffect(() => {
    let isMounted = true;
    const idleWindow = window as IdleWindow;

    const loadSections = () => {
      void import("./HomeDeferredSections").then((module) => {
        if (isMounted) {
          setDeferredSections(() => module.HomeDeferredSections);
        }
      });
    };

    const canUseIdleCallback = typeof idleWindow.requestIdleCallback === "function";
    const handle = canUseIdleCallback
      ? idleWindow.requestIdleCallback(loadSections, { timeout: 1200 })
      : window.setTimeout(loadSections, 1);

    return () => {
      isMounted = false;

      if (canUseIdleCallback) {
        idleWindow.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
  }, []);

  if (!DeferredSections) {
    return <HomeDeferredSectionsFallback />;
  }

  return <DeferredSections {...props} />;
}
