"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

export default function ScrollToHashWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isFirstRunRef = useRef(true);
  const previousPathnameRef = useRef<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash;

    if (pathname === "/" && hash) {
      const el = document.querySelector(hash);

      if (el) {
        const timer = window.setTimeout(() => {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          history.replaceState(null, "", "/");
        }, 200);

        isFirstRunRef.current = false;
        previousPathnameRef.current = pathname;

        return () => window.clearTimeout(timer);
      }
    }

    const isFirstRun = isFirstRunRef.current;
    const previousPathname = previousPathnameRef.current;

    isFirstRunRef.current = false;
    previousPathnameRef.current = pathname;

    if (isFirstRun) return;
    if (previousPathname === pathname) return;

    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [pathname]);

  return <>{children}</>;
}
