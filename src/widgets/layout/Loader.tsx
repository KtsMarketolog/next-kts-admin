// src/components/Loader.tsx
'use client';

import { useEffect, useRef, useState } from 'react';

export default function Loader({ children }: { children: React.ReactNode }) {
  const MIN_DISPLAY_TIME = 150;

  const [showReveal, setShowReveal] = useState(false);
  const startRef = useRef<number>(Date.now());
  const ranRef = useRef(false);

  useEffect(() => {
    // Если React StrictMode в dev — эффекты могут запускаться дважды
    if (ranRef.current) return;
    ranRef.current = true;

    const ssrLoader = document.getElementById('ssr-loader');
    const appContent = document.getElementById('app-content');

    // Базовая страховка
    if (!ssrLoader || !appContent) return;

    // Скрываем контент до гидрации (убирает любой "промежуток")
    // Важно: сначала ставим hydrated, потом показываем контент уже под лоадером
    document.documentElement.classList.add('hydrated');
    document.body.classList.remove('preload-bg');
    document.body.style.overflow = 'hidden';

    const finish = () => {
      const elapsed = Date.now() - startRef.current;
      const remaining = MIN_DISPLAY_TIME - elapsed;

      const doHide = () => {
        // hash-scroll (как у тебя)
        const hash = window.location.hash;
        if (hash) {
          const el = document.querySelector(hash);
          if (el) {
            (el as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'center' });
            history.replaceState(null, '', window.location.pathname);
          }
        }

        // Запускаем "шторку"
        setShowReveal(true);

        // Прячем SSR-лоадер классом (НЕ remove()) → меньше шансов словить DOM NotFoundError
        ssrLoader.classList.add('loaderHidden');

        const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', '#ffffff');

        // Возвращаем скролл
        document.body.style.overflow = '';

        setTimeout(() => document.getElementById('reveal-screen')?.classList.add('hidden'), 50);
        setTimeout(() => document.getElementById('reveal-screen')?.remove(), 1100);
      };

      if (remaining > 0) setTimeout(doHide, remaining);
      else doHide();
    };

    // Если уже complete — сразу финиш
    if (document.readyState === 'complete') {
      finish();
    } else {
      window.addEventListener('load', finish, { once: true });
      return () => window.removeEventListener('load', finish);
    }
  }, []);

  return (
    <>
      {/* CSS: 1) прячем app-content до hydrated (убирает мерцание),
              2) добавляем класс для скрытия SSR-лоадера */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
          /* КЛЮЧ: пока нет hydrated — контент невидим. Поэтому "сайт" никогда не успеет мелькнуть */
          html:not(.hydrated) #app-content { visibility: hidden; }

          :root{
            --bg-color: #010d3a;
            --veil-color: 0,10,58;
            --veil-alpha: .12;
            --veil-blur-peak: 6px;
            --pulse-glow: 0.12;
            --pulse-dur: 2200ms;
          }

          .loaderRoot{
            position: fixed; inset: 0;
            z-index: 9999;
            background: var(--bg-color);
            overflow: hidden;
            opacity: 1;
            transition: opacity 180ms ease;
          }
          .loaderHidden{
            opacity: 0;
            pointer-events: none;
          }

          .posterLayer{
            position: absolute; inset: 0;
            width: 100vw; height: 100svh;
            background-color: var(--bg-color);
            background-image: url('/loader.jpg');
            background-repeat: no-repeat;
            background-position: left 40% center;
            background-size: contain;
            pointer-events: none; user-select: none;
          }

          @media (max-width: 768px){
            .posterLayer{
              background-size: 140% auto;
              background-position: left 46% center;
            }
          }

          @media (max-width: 480px){
            .posterLayer{
              background-size: 170% auto;
              background-position: left 48% center;
            }
          }

          .glassOverlay{
            position: absolute; inset: 0;
            background: rgba(var(--veil-color), var(--veil-alpha));
          }

          .blurPulse{
            position: absolute; inset: 0;
            background: rgba(255,255,255,var(--pulse-glow));
            mix-blend-mode: soft-light;
            animation: blurBreath var(--pulse-dur) ease-in-out infinite;
            will-change: opacity, -webkit-backdrop-filter, backdrop-filter;
            transform: translateZ(0);
            pointer-events: none;
          }

          @keyframes blurBreath{
            0%{
              opacity: .30;
              -webkit-backdrop-filter: blur(0px) saturate(110%) brightness(1.01);
              backdrop-filter: blur(0px) saturate(110%) brightness(1.01);
            }
            50%{
              opacity: .85;
              -webkit-backdrop-filter: blur(var(--veil-blur-peak)) saturate(115%) brightness(1.04);
              backdrop-filter: blur(var(--veil-blur-peak)) saturate(115%) brightness(1.04);
            }
            100%{
              opacity: .30;
              -webkit-backdrop-filter: blur(0px) saturate(110%) brightness(1.01);
              backdrop-filter: blur(0px) saturate(110%) brightness(1.01);
            }
          }

          @media (max-width: 600px){
            .blurPulse{
              background: rgba(0,0,0,0.01);
              mix-blend-mode: normal;
              --veil-blur-peak: 6px;
              animation-duration: 2400ms;
            }
          }

          @media (prefers-reduced-motion: reduce){
            .blurPulse{ animation: none !important; }
          }

          #reveal-screen {
            position: fixed; inset: 0; z-index: 2147483647;
            background: #010d3a;
            transform: translateX(0);
            transition: transform 1s cubic-bezier(.22,.61,.36,1);
            overflow: hidden;
          }
          #reveal-screen::after {
            content: "";
            position: absolute; inset: 0;
            background: linear-gradient(90deg,
              rgba(255,255,255,0) 0%,
              rgba(255,255,255,0.18) 50%,
              rgba(255,255,255,0) 100%);
            mix-blend-mode: soft-light;
          }
          #reveal-screen.hidden { transform: translateX(100%); }
        `,
        }}
      />

      {showReveal && <div id="reveal-screen" className="reveal-screen" />}

      {children}
    </>
  );
}
