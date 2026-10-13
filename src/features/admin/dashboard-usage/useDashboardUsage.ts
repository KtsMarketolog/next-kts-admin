'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { DASHBOARD_USAGE_MARKER, readDashboardUsageMessageDetails, type DashboardUsageAction, type DashboardUsageEvent } from '@/shared/lib/dashboardUsage';
import { useProfitabilityAuditGuard } from './useProfitabilityAuditGuard';
import { useDashboardUsageDelivery } from './DashboardUsageDeliveryProvider';

/** Opaque frames speak only to their authenticated parent, never to the API. */
export function useDashboardUsage({ dashboardKey, iframeRef, preview = false, versionId = null, opaque = false }: {
  dashboardKey: string; iframeRef: RefObject<HTMLIFrameElement | null>;
  preview?: boolean; versionId?: number | null; opaque?: boolean;
}) {
  useProfitabilityAuditGuard(iframeRef);
  const delivery = useDashboardUsageDelivery();
  const recordRef = useRef<(action: DashboardUsageAction) => void>(() => {});
  const record = useCallback((action: DashboardUsageAction) => recordRef.current(action), []);
  useEffect(() => {
    const nonce = crypto.randomUUID().replaceAll('-', '');
    let stopped = false, opened = false;
    let observedFrame: HTMLIFrameElement | null = null, inViewport = false;
    const viewing = delivery?.viewing.register({ dashboardKey, preview, versionId });
    const updateVisible = () => viewing?.setVisible(!stopped && opened && inViewport && !document.hidden);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      const entry = entries.find((item) => item.target === observedFrame);
      if (!entry) return;
      inViewport = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
      updateVisible();
    });
    const recent = new Map<DashboardUsageAction, number>();
    const enqueue = (action: DashboardUsageAction, upload?: DashboardUsageEvent['upload']) => {
      // A user-selected import may finish after the tab becomes hidden; retain that success.
      if (stopped || (document.hidden && !upload)) return;
      // Presence and successful server uploads cannot be asserted by report actions.
      if (action === 'viewing_time' || action === 'file_uploaded') return;
      const now = Date.now();
      if (!upload && now - (recent.get(action) ?? 0) < (action === 'data_loaded' ? 10_000 : 500)) return;
      recent.set(action, now);
      delivery?.enqueue({ dashboardKey, preview, versionId }, { id: crypto.randomUUID().replaceAll('-', ''), action, ...(upload ? { upload } : {}) });
    };
    recordRef.current = enqueue;
    const probe = () => {
      if (observedFrame !== iframeRef.current) {
        observer?.disconnect(); observedFrame = iframeRef.current; inViewport = false; opened = false; updateVisible();
        if (observedFrame) observer?.observe(observedFrame);
      }
      iframeRef.current?.contentWindow?.postMessage({ marker: DASHBOARD_USAGE_MARKER, type: 'init', nonce }, opaque ? '*' : window.location.origin);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== (opaque ? 'null' : window.location.origin)) return;
      if (event.data?.marker === DASHBOARD_USAGE_MARKER && event.data.type === 'ready') { probe(); return; }
      const message = readDashboardUsageMessageDetails(event.data, nonce);
      if (message) {
        if (!opened) { enqueue('report_open'); opened = true; }
        updateVisible();
        if (message.action !== 'report_open') enqueue(message.action, message.upload);
      }
    };
    window.addEventListener('message', receive);
    const initialProbe = window.setInterval(probe, 1000);
    const visibility = () => { updateVisible(); if (document.hidden) void delivery?.flush(); else probe(); };
    const pageHide = () => { viewing?.setVisible(false); void delivery?.flush(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pageHide);
    probe();
    return () => {
      window.removeEventListener('message', receive); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pageHide);
      stopped = true;
      observer?.disconnect(); viewing?.dispose();
      clearInterval(initialProbe); recordRef.current = () => {}; void delivery?.flush();
    };
  }, [dashboardKey, delivery, iframeRef, opaque, preview, versionId]);
  return record;
}
