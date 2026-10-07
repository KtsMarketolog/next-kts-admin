'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { DASHBOARD_USAGE_MARKER, DASHBOARD_USAGE_MAX_BATCH, readDashboardUsageMessage, type DashboardUsageAction, type DashboardUsageEvent } from '@/shared/lib/dashboardUsage';

/** Opaque frames speak only to their authenticated parent, never to the API. */
export function useDashboardUsage({ dashboardKey, iframeRef, preview = false, versionId = null, opaque = false }: {
  dashboardKey: string; iframeRef: RefObject<HTMLIFrameElement | null>;
  preview?: boolean; versionId?: number | null; opaque?: boolean;
}) {
  const recordRef = useRef<(action: DashboardUsageAction) => void>(() => {});
  const record = useCallback((action: DashboardUsageAction) => recordRef.current(action), []);
  useEffect(() => {
    const nonce = crypto.randomUUID().replaceAll('-', '');
    let events: DashboardUsageEvent[] = [], stopped = false, sending = false, opened = false;
    const recent = new Map<DashboardUsageAction, number>();
    const enqueue = (action: DashboardUsageAction) => {
      if (stopped || document.hidden) return;
      const now = Date.now();
      if (now - (recent.get(action) ?? 0) < (action === 'data_loaded' ? 10_000 : 500)) return;
      recent.set(action, now);
      if (events.length < 100) events.push({ id: crypto.randomUUID().replaceAll('-', ''), action });
    };
    recordRef.current = enqueue;
    const flush = async () => {
      if (sending || events.length === 0) return;
      const batch = events.splice(0, DASHBOARD_USAGE_MAX_BATCH); sending = true;
      try {
        const response = await fetch('/api/admin/dashboard-usage', { method: 'POST', credentials: 'same-origin',
          cache: 'no-store', keepalive: true, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dashboardKey, preview, versionId, events: batch }) });
        // Fail closed on lost access, without disrupting the actual report.
        if (response.status === 401 || response.status === 403) { stopped = true; events = []; }
      } catch { /* Usage is best-effort, not a reason to block a business report. */ }
      finally { sending = false; }
    };
    const probe = () => iframeRef.current?.contentWindow?.postMessage({ marker: DASHBOARD_USAGE_MARKER, type: 'init', nonce }, opaque ? '*' : window.location.origin);
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== (opaque ? 'null' : window.location.origin)) return;
      if (event.data?.marker === DASHBOARD_USAGE_MARKER && event.data.type === 'ready') { probe(); return; }
      const action = readDashboardUsageMessage(event.data, nonce);
      if (action) {
        if (!opened) { enqueue('report_open'); opened = true; }
        if (action !== 'report_open') enqueue(action);
      }
    };
    window.addEventListener('message', receive);
    const initialProbe = window.setInterval(probe, 1000);
    const flushTimer = window.setInterval(() => { void flush(); }, 5000);
    const visibility = () => { if (document.hidden) void flush(); else probe(); };
    document.addEventListener('visibilitychange', visibility);
    probe();
    return () => {
      window.removeEventListener('message', receive); document.removeEventListener('visibilitychange', visibility);
      clearInterval(initialProbe); clearInterval(flushTimer); recordRef.current = () => {}; void flush();
    };
  }, [dashboardKey, iframeRef, opaque, preview, versionId]);
  return record;
}
