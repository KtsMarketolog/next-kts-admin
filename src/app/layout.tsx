// src/app/layout.tsx
import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./fix-ios-zoom.scss";
import Header from "@/widgets/layout/Header/Header";
// TEMP: Loader is disabled while measuring Lighthouse without the preload overlay.
// import Loader from "@/widgets/layout/Loader";
import { ConditionalFooter } from "@/widgets/layout/ConditionalFooter";
import { BitrixSiteButton } from "@/widgets/layout/BitrixSiteButton";
import ScrollToHashWrapper from "@/shared/lib/ScrollToHashWrapper";
import CookieBannerLoader from '@/shared/ui/CookieBanner/CookieBannerLoader';

export const metadata: Metadata = {

  title: "KTS",
  description: "Компоненты технических систем",

};

export const viewport: Viewport = {

  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",

};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {

  return (

    <html lang="ru" data-scroll-behavior="smooth">

      <body>

        {/* TEMP: Loader is disabled while measuring Lighthouse without the preload overlay.
        <div id="ssr-loader" className="loaderRoot" role="progressbar" aria-busy="true" aria-label="Загрузка">

          <div className="posterLayer" aria-hidden="true" />
          <div className="glassOverlay" />
          <div className="blurPulse" />

        </div>
        */}

        {/* TEMP: app content is visible immediately while Loader is disabled. */}
        <div id="app-content">

          <Header />

          {/* TEMP: Loader wrapper is disabled to avoid hiding content until window.load. */}

          <ScrollToHashWrapper>
              
            {children}

            <CookieBannerLoader />

          </ScrollToHashWrapper>

          <ConditionalFooter />

          <BitrixSiteButton />

        </div>

      </body>

    </html>

  );

}
