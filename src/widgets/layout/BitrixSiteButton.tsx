'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

const HIDDEN_ROUTE_PREFIXES = ['/admin', '/cabinet', '/login', '/price'];
const VISIBILITY_STYLE_ID = 'bitrix-site-button-visibility-style';
const BITRIX_SITE_BUTTON_SCRIPT_ID = 'bitrix-site-button-loader';
const BITRIX_SITE_BUTTON_LOADER_URL = 'https://crm.kts-impex.ru/upload/crm/site_button/loader_1_1hr91m.js';

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

  useEffect(() => {
    if (hidden || document.getElementById(BITRIX_SITE_BUTTON_SCRIPT_ID)) return;

    const script = document.createElement('script');
    script.id = BITRIX_SITE_BUTTON_SCRIPT_ID;
    script.async = true;
    script.src = `${BITRIX_SITE_BUTTON_LOADER_URL}?${Math.floor(Date.now() / 60000)}`;

    const firstScript = document.getElementsByTagName('script')[0];
    if (firstScript?.parentNode) {
      firstScript.parentNode.insertBefore(script, firstScript);
    } else {
      document.head.appendChild(script);
    }
  }, [hidden]);

  return null;
}
