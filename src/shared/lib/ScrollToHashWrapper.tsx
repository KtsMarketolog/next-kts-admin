"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export default function ScrollToHashWrapper({

  children,

}: {

  children: React.ReactNode;

}) {

  const pathname = usePathname();

  useEffect(() => {

    const hash = window.location.hash;

    // 1) Если есть hash и мы на главной — скроллим к секции
    if (pathname === "/" && hash) {

      const el = document.querySelector(hash);

      if (el) {

        // небольшой таймаут — чтобы DOM успел отрендериться после навигации
        setTimeout(() => {

          el.scrollIntoView({ behavior: "smooth", block: "center" });

          // опционально: очищаем hash, чтобы дальше не "залипало"
          history.replaceState(null, "", "/");

        }, 200);

        return;

      }

    }

    // 2) Во ВСЕХ остальных случаях при смене страницы — наверх
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });

  }, [pathname]);

  return <>{children}</>;

}