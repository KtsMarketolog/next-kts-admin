'use client';

import { useEffect, type RefObject } from 'react';

const MARKER = 'kts-profitability-audit-v1';
const FRAME_CHANGE_EVENT = 'kts-profitability-before-frame-change';
const DISCARD_WARNING = 'Не все сведения о загруженных счетах записаны в журнал. Если продолжить, неподтверждённые записи могут быть потеряны. Продолжить?';

/** Explicit replacements may ask; background refreshes must retain a pending report without a dialog. */
export function requestProfitabilityFrameChange(frame: HTMLIFrameElement | null, prompt = true): boolean {
  if (typeof window === 'undefined' || !frame) return true;
  return window.dispatchEvent(new CustomEvent(FRAME_CHANGE_EVENT, { cancelable: true, detail: { frame, prompt } }));
}

/** The unsandboxed page owns the guard: sandboxed frames cannot show beforeunload dialogs. */
export function useProfitabilityAuditGuard(iframeRef: RefObject<HTMLIFrameElement | null>) {
  useEffect(() => {
    let pending = false;
    let observedFrame: HTMLIFrameElement | null = null;
    let frameApprovalUntil = 0;
    let navigationApprovalUntil = 0;
    const currentFrame = () => {
      const frame = iframeRef.current;
      if (frame !== observedFrame) {
        observedFrame = frame;
        frameApprovalUntil = 0;
        pending = false;
      }
      return frame;
    };
    const receive = (event: MessageEvent) => {
      const frame = currentFrame();
      if (!frame || event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 3
        || data.marker !== MARKER || data.type !== 'pending-state' || typeof data.pending !== 'boolean') return;
      pending = data.pending;
    };
    const unload = (event: BeforeUnloadEvent) => {
      currentFrame();
      if (!pending || Date.now() < navigationApprovalUntil) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const beforeFrameChange = (event: Event) => {
      const detail = (event as CustomEvent<{ frame?: HTMLIFrameElement; prompt?: boolean }>).detail;
      const frame = currentFrame();
      if (!frame || detail?.frame !== frame || !pending || event.defaultPrevented) return;
      if (detail.prompt === false) {
        if (Date.now() >= frameApprovalUntil) event.preventDefault();
        return;
      }
      if (!window.confirm(DISCARD_WARNING)) {
        event.preventDefault();
        return;
      }
      // Allow the immediate post-operation replacement without disabling unload protection if that operation fails.
      frameApprovalUntil = Date.now() + 5000;
    };
    const loaded = (event: Event) => {
      if (event.target !== iframeRef.current) return;
      observedFrame = iframeRef.current;
      frameApprovalUntil = 0;
      pending = false;
    };
    const navigate = (event: MouseEvent) => {
      currentFrame();
      if (!pending || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return;
      const target = anchor.getAttribute('target');
      if (target && !['_self', '_parent', '_top'].includes(target.toLowerCase())) return;
      const destination = new URL(anchor.href, window.location.href);
      if (!['http:', 'https:'].includes(destination.protocol)) return;
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname
        && destination.search === window.location.search) return; // In-page anchors retain the report.
      if (!window.confirm(DISCARD_WARNING)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else {
        // Avoid a second native prompt for the same explicitly accepted hard navigation.
        navigationApprovalUntil = Date.now() + 1500;
      }
    };
    window.addEventListener('message', receive);
    window.addEventListener('beforeunload', unload);
    window.addEventListener(FRAME_CHANGE_EVENT, beforeFrameChange);
    document.addEventListener('click', navigate, true);
    document.addEventListener('load', loaded, true);
    return () => {
      window.removeEventListener('message', receive);
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener(FRAME_CHANGE_EVENT, beforeFrameChange);
      document.removeEventListener('click', navigate, true);
      document.removeEventListener('load', loaded, true);
    };
  }, [iframeRef]);
}
