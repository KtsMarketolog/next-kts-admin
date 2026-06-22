'use client';

import { useEffect } from 'react';
import Script from 'next/script';
import { usePathname } from 'next/navigation';

const HIDDEN_ROUTE_PREFIXES = ['/admin', '/cabinet', '/login', '/price'];
const VISIBILITY_STYLE_ID = 'bitrix-site-button-visibility-style';

const BITRIX_SITE_BUTTON_SCRIPT = `
        (function(w,d,u){
                var s=d.createElement('script');s.async=true;s.src=u+'?'+(Date.now()/60000|0);
                var h=d.getElementsByTagName('script')[0];h.parentNode.insertBefore(s,h);
        })(window,document,'https://crm.kts-impex.ru/upload/crm/site_button/loader_1_1hr91m.js');
`;

function shouldHideWidget(pathname: string) {
  return HIDDEN_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function ensureVisibilityStyle() {
  if (document.getElementById(VISIBILITY_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = VISIBILITY_STYLE_ID;
  style.textContent = `
html[data-bitrix-site-button="hidden"] .b24-widget-button-wrapper,
html[data-bitrix-site-button="hidden"] .b24-widget-button-popup,
html[data-bitrix-site-button="hidden"] [class*="b24-widget-button"],
html[data-bitrix-site-button="hidden"] [id*="b24-widget-button"],
html[data-bitrix-site-button="hidden"] .bx-livechat-wrapper,
html[data-bitrix-site-button="hidden"] [id^="bx-livechat"],
html[data-bitrix-site-button="hidden"] iframe[src*="crm.kts-impex.ru"] {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;
  document.head.appendChild(style);
}

export function BitrixSiteButton() {
  const pathname = usePathname() || '/';
  const hidden = shouldHideWidget(pathname);

  useEffect(() => {
    ensureVisibilityStyle();
    document.documentElement.dataset.bitrixSiteButton = hidden ? 'hidden' : 'visible';
  }, [hidden]);

  if (hidden) return null;

  return (
    <Script id="bitrix-site-button" strategy="lazyOnload">
      {BITRIX_SITE_BUTTON_SCRIPT}
    </Script>
  );
}
