'use client';

import { useEffect, useRef } from 'react';

import type { AdminCrudHookOptions } from './hookTypes';
import { ContentOrderAcknowledgementError } from './reorder';
import { adminRequest, runWithRequestTimeout } from '@/features/admin/shared/adminRequest';

type ContentRequest = { url: string; init: RequestInit };
type ContentAction = {
  requests: [ContentRequest];
  mutation?: boolean;
  success: string;
  failure: string;
  onSaved?: (responses: Response[], signal: AbortSignal) => void | string | Promise<void | string>;
  onConflict?: () => void;
};

/** One mutation request per action; multi-row operations must be atomic on the server. */
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

  return async ({ requests, mutation = true, success, failure, onSaved, onConflict }: ContentAction) => {
    if (lock.current || !mounted.current) return false;
    lock.current = true;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    let confirmed = false;
    try {
      const { url, init } = requests[0];
      const response = await adminRequest(url, { ...init, signal: controller.signal }, { mutation });
      if (!mounted.current || controller.signal.aborted) return false;
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        if (response.status === 409 || response.status === 428) onConflict?.();
        showStatus(typeof data?.error === 'string' ? data.error : failure);
        return false;
      }
      confirmed = mutation;
      const message = await runWithRequestTimeout(async (signal) => {
        const acknowledgement = mutation ? await response.clone().json().catch(() => null) : null;
        signal.throwIfAborted();
        const detail = onSaved ? await onSaved([response], signal) : undefined;
        const warnings = Array.isArray(acknowledgement?.warnings)
          ? acknowledgement.warnings.filter((warning: unknown): warning is string => typeof warning === 'string') : [];
        return warnings.length ? `${detail || success}. ${warnings.join(' ')}` : detail;
      }, { signal: controller.signal });
      if (mounted.current) showStatus(message || success);
      return true;
    } catch (error) {
      if (error instanceof ContentOrderAcknowledgementError) {
        if (mounted.current && !controller.signal.aborted) {
          showStatus('Сервер не подтвердил новый порядок. Он мог сохраниться. Обновите страницу и проверьте порядок перед повторением.');
        }
        return false;
      }
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
