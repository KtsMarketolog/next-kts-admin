'use client';

import { useEffect, useRef } from 'react';

import type { AdminCrudHookOptions } from './hookTypes';
import { adminRequest, runWithRequestTimeout } from '@/features/admin/shared/adminRequest';

type ContentRequest = { url: string; init: RequestInit };
type ContentAction = {
  requests: ContentRequest[];
  success: string;
  failure: string;
  onSaved?: (responses: Response[], signal: AbortSignal) => void | Promise<void>;
  onConfirmed?: (response: Response, index: number, signal: AbortSignal) => void | Promise<void>;
};

/** One content mutation at a time, including all requests in a reorder batch. */
export function useAdminContentAction({ setBusy, showStatus, actionLock }: AdminCrudHookOptions) {
  const localLock = useRef(false);
  const lock = actionLock ?? localLock;
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);

  return async ({ requests, success, failure, onSaved, onConfirmed }: ContentAction) => {
    if (lock.current || !mounted.current) return false;
    lock.current = true;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    let confirmed = false;
    try {
      // allSettled is intentional: one rejected request must not unlock the
      // reorder controls while sibling writes are still in flight.
      const results = await Promise.allSettled(requests.map(({ url, init }) =>
        adminRequest(url, { ...init, signal: controller.signal }, { mutation: true })));
      if (!mounted.current || controller.signal.aborted) return false;
      const saved = results.filter((result) => result.status === 'fulfilled' && result.value.ok).length;
      if (onConfirmed) {
        for (const [index, result] of results.entries()) {
          if (result.status === 'fulfilled' && result.value.ok) {
            await runWithRequestTimeout((signal) => Promise.resolve(onConfirmed(result.value.clone(), index, signal)), { signal: controller.signal });
          }
        }
      }
      if (saved !== results.length) {
        if (results.length > 1) {
          showStatus(`Порядок сохранён не полностью: подтверждено ${saved} из ${results.length}. Часть изменений могла сохраниться. Обновите страницу и проверьте порядок перед повторной отправкой.`);
        } else {
          const result = results[0];
          if (result?.status === 'rejected') {
            showStatus(result.reason instanceof Error ? result.reason.message : failure);
          } else if (result?.status === 'fulfilled') {
            const data = await result.value.json().catch(() => null);
            showStatus(typeof data?.error === 'string' ? data.error : failure);
          } else showStatus(failure);
        }
        return false;
      }
      confirmed = true;
      if (onSaved) await runWithRequestTimeout((signal) => Promise.resolve(onSaved(results.map((result) => (result as PromiseFulfilledResult<Response>).value), signal)), { signal: controller.signal });
      if (mounted.current) showStatus(success);
      return true;
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        showStatus(confirmed
          ? `${success}. Не удалось обновить список. Изменения уже сохранены; обновите страницу, не повторяя сохранение.`
          : error instanceof Error ? error.message : failure);
      }
      return confirmed;
    } finally {
      if (active.current === controller) {
        active.current = null;
        lock.current = false;
        setBusy(false);
      }
    }
  };
}
