// src/app/layout.tsx
import type { Metadata, Viewport } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";
import "./fix-ios-zoom.scss";
import Header from "@/widgets/layout/Header/Header";
import { ConditionalFooter } from "@/widgets/layout/ConditionalFooter";
import ScrollToHashWrapper from "@/shared/lib/ScrollToHashWrapper";
import CookieBanner from '@/shared/ui/CookieBanner/CookieBanner';

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

      <body className={montserrat.variable}>

        {/* Весь контент сайта */}
        <div id="app-content">

          <Header />

          <ScrollToHashWrapper>
              
            {children}

            <CookieBanner />

          </ScrollToHashWrapper>

          <ConditionalFooter />

        </div>

      </body>

    </html>

  );

}
