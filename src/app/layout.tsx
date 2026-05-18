// src/app/layout.tsx
import type { Metadata, Viewport } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";
import "./fix-ios-zoom.scss";
import Header from "@/widgets/layout/Header/Header";
import Loader from "@/widgets/layout/Loader";
import { ConditionalFooter } from "@/widgets/layout/ConditionalFooter";
import ScrollToHashWrapper from "@/shared/lib/ScrollToHashWrapper";
import CookieBannerLoader from '@/shared/ui/CookieBanner/CookieBannerLoader';

const montserrat = Montserrat({

  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-montserrat",

});

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

      <body className={`${montserrat.variable} preload-bg`}>

        <div id="ssr-loader" className="loaderRoot" role="progressbar" aria-busy="true" aria-label="Загрузка">

          <div className="posterLayer" aria-hidden="true" />
          <div className="glassOverlay" />
          <div className="blurPulse" />

        </div>

        {/* Весь контент — в обертке, которую скрываем до hydrated */}
        <div id="app-content">

          <Header />

          <Loader>

            <ScrollToHashWrapper>
              
              {children}

              <CookieBannerLoader />

            </ScrollToHashWrapper>

          </Loader>

          <ConditionalFooter />

        </div>

      </body>

    </html>

  );

}
