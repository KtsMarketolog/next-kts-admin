'use client';

import { useEffect, useState } from 'react';
import { adminRequest } from '../shared/adminRequest';

/** One result page, cancelled on navigation; slow/stale responses cannot replace a newer query. */
export function useUsagePage<T>(url: string, fallback: string) {
  const [attempt, setAttempt] = useState(0);
  const key = `${url}|${attempt}`;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const response = await adminRequest(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal }, { timeoutMs: 15_000 });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || fallback);
        if (!cancelled) setResult({ key, data });
      } catch (cause) {
        if (!cancelled) setResult({ key, error: controller.signal.aborted
          ? 'Сервер не ответил вовремя. Попробуйте ещё раз.' : cause instanceof Error ? cause.message : fallback });
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [url, key, fallback]);
  const current = result?.key === key ? result : null;
  return { data: current?.data, error: current?.error, busy: !current, reload: () => setAttempt((value) => value + 1) };
}
