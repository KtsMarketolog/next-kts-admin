'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import {
  BITRIX_SITE_BUTTON_LOADER_URL,
  BITRIX_SITE_BUTTON_SCRIPT_ID,
  shouldHideBitrixSiteButton,
} from './bitrixSiteButtonConfig';

const VISIBILITY_STYLE_ID = 'bitrix-site-button-visibility-style';

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

@media (min-width: 768px) and (max-width: 1180px) {
  html[data-bitrix-site-button="visible"] .b24-widget-button-wrapper.b24-widget-button-position-bottom-right {
    right: max(28px, env(safe-area-inset-right)) !important;
    bottom: max(28px, env(safe-area-inset-bottom)) !important;
  }

  html[data-bitrix-site-button="visible"] .b24-widget-button-popup {
    max-width: min(360px, calc(100vw - 56px)) !important;
  }
}

@media (max-width: 767px) {
  html[data-bitrix-site-button="visible"] .b24-widget-button-wrapper.b24-widget-button-position-bottom-right {
    right: max(14px, env(safe-area-inset-right)) !important;
    bottom: max(14px, env(safe-area-inset-bottom)) !important;
  }

  html[data-bitrix-site-button="visible"] .b24-widget-button-block,
  html[data-bitrix-site-button="visible"] .b24-widget-button-inner-block {
    width: 56px !important;
    height: 56px !important;
  }

  html[data-bitrix-site-button="visible"] .b24-widget-button-inner-mask {
    top: -6px !important;
    left: -6px !important;
    width: calc(100% + 12px) !important;
    height: 68px !important;
  }

  html[data-bitrix-site-button="visible"] .b24-widget-button-icon-container {
    transform: scale(0.9) !important;
  }

  html[data-bitrix-site-button="visible"] .b24-widget-button-social-item {
    width: 42px !important;
    height: 42px !important;
    margin-right: 6px !important;
    margin-bottom: 8px !important;
  }

  html[data-bitrix-site-button="visible"] .b24-widget-button-social-tooltip {
    max-width: calc(100vw - 96px) !important;
    white-space: normal !important;
  }

  html[data-bitrix-site-button="visible"] .b24-widget-button-popup {
    right: 0 !important;
    left: auto !important;
    max-width: calc(100vw - 32px) !important;
  }

  html[data-bitrix-site-button="visible"] .bx-livechat-wrapper,
  html[data-bitrix-site-button="visible"] [class*="bx-livechat"][class*="wrapper"],
  html[data-bitrix-site-button="visible"] iframe[src*="crm.kts-impex.ru"][style*="position: fixed"],
  html[data-bitrix-site-button="visible"] iframe[src*="crm.kts-impex.ru"][style*="position:fixed"] {
    right: max(10px, env(safe-area-inset-right)) !important;
    left: max(10px, env(safe-area-inset-left)) !important;
    bottom: max(10px, env(safe-area-inset-bottom)) !important;
    width: auto !important;
    max-width: none !important;
    height: min(620px, calc(100dvh - 20px)) !important;
    max-height: calc(100dvh - 20px) !important;
  }
}

@media (max-width: 420px) {
  html[data-bitrix-site-button="visible"] .bx-livechat-wrapper,
  html[data-bitrix-site-button="visible"] [class*="bx-livechat"][class*="wrapper"],
  html[data-bitrix-site-button="visible"] iframe[src*="crm.kts-impex.ru"][style*="position: fixed"],
  html[data-bitrix-site-button="visible"] iframe[src*="crm.kts-impex.ru"][style*="position:fixed"] {
    top: max(10px, env(safe-area-inset-top)) !important;
    height: auto !important;
    min-height: 0 !important;
  }
}
`;
  document.head.appendChild(style);
}

export function BitrixSiteButton() {
  const pathname = usePathname() || '/';
  const hidden = shouldHideBitrixSiteButton(pathname);

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
