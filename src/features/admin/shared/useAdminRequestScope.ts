'use client';

import { useCallback, useEffect, useRef } from 'react';

import { adminRequest } from './adminRequest';

/** A component owns its requests; leaving it cancels their body reads as well. */
export function useAdminRequestScope() {
  const pending = useRef(new Set<AbortController>());
  const disposed = useRef(false);
  const cancelAll = useCallback(() => {
    for (const controller of pending.current) controller.abort();
  }, []);
  const isActive = useCallback(() => !disposed.current, []);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      cancelAll();
    };
  }, [cancelAll]);

  const request = useCallback(async (
    url: Parameters<typeof adminRequest>[0],
    init: Parameters<typeof adminRequest>[1] = {},
    options?: Parameters<typeof adminRequest>[2],
  ) => {
    const controller = new AbortController();
    const external = init?.signal;
    const abort = () => controller.abort();
    if (disposed.current || external?.aborted) controller.abort();
    external?.addEventListener('abort', abort, { once: true });
    pending.current.add(controller);
    try {
      return await adminRequest(url, { ...init, signal: controller.signal }, options);
    } finally {
      external?.removeEventListener('abort', abort);
      pending.current.delete(controller);
    }
  }, []);

  return { request, cancelAll, isActive };
}
