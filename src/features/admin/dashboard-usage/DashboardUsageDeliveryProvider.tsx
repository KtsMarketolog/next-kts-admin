'use client';

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { DashboardUsageDelivery } from '@/shared/lib/dashboardUsageDelivery';
import styles from './delivery-status.module.scss';

const Context = createContext<DashboardUsageDelivery | null>(null);
export const useDashboardUsageDelivery = () => useContext(Context);

/** The session comes from the server-rendered admin shell, never from a delayed client lookup. */
export function DashboardUsageDeliveryProvider({ sessionId, children }: { sessionId: string | null; children: ReactNode }) {
  const delivery = useMemo(() => new DashboardUsageDelivery(sessionId), [sessionId]);
  const state = useSyncExternalStore(delivery.subscribe, delivery.getSnapshot, delivery.getSnapshot);
  useEffect(() => {
    delivery.resume();
    let navigationApprovedUntil = 0;
    const viewingTimer = window.setInterval(() => { delivery.viewing.flush(); }, 15_000);
    const flush = () => { void delivery.flush(); };
    const unload = (event: BeforeUnloadEvent) => {
      const hadPendingEvents = delivery.getSnapshot().pending > 0;
      // Final viewing seconds are best-effort: a fresh pulse alone must not block normal closing.
      delivery.viewing.flush();
      flush();
      if (!hadPendingEvents || Date.now() < navigationApprovedUntil) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return;
      const target = anchor.getAttribute('target');
      if (target && !['_self', '_parent', '_top'].includes(target.toLowerCase())) return;
      const destination = new URL(anchor.href, window.location.href);
      if (!['http:', 'https:'].includes(destination.protocol)) return;
      if (destination.origin === window.location.origin && (destination.pathname === '/admin' || destination.pathname.startsWith('/admin/'))) return;
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      if (!delivery.getSnapshot().pending) return;
      flush();
      if (!window.confirm('Некоторые действия ещё не записаны в журнал. При выходе из кабинета они могут быть потеряны. ОК — уйти, Отмена — остаться и дождаться отправки.')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else {
        // A native hard-navigation prompt must not repeat the just-accepted choice.
        navigationApprovedUntil = Date.now() + 1500;
      }
    };
    window.addEventListener('online', flush);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', unload);
    document.addEventListener('visibilitychange', flush);
    document.addEventListener('click', navigate, true);
    return () => {
      window.removeEventListener('online', flush);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('visibilitychange', flush);
      document.removeEventListener('click', navigate, true);
      window.clearInterval(viewingTimer);
      delivery.viewing.flush();
      // Child report remounts keep this layout-level queue. Full layout teardown gets a final attempt.
      flush();
      delivery.dispose();
    };
  }, [delivery]);
  const stopped = ['authentication', 'access', 'session', 'rejected'].includes(state.status);
  const problem = stopped || state.status === 'retrying' || state.status === 'offline' || state.skipped > 0;
  return <Context.Provider value={delivery}>
    {children}
    {problem && <aside className={styles.notice} role="status" aria-live="polite" aria-label="Состояние журнала действий">
      <strong>Журнал действий: {state.pending} ожидают записи</strong>
      <p>{stopped
        ? 'Отправка остановлена: изменились сеанс или права доступа либо сервер отклонил события. Обновите страницу; неподтверждённые действия могут быть потеряны.'
        : 'Сервер пока не подтвердил запись. Повторим отправку автоматически. До подтверждения не закрывайте страницу.'}</p>
      {state.skipped > 0 && <p>Очередь была заполнена: не удалось сохранить действий — {state.skipped}. Уже собранные события не удалены.</p>}
      {!stopped && state.pending > 0 && <button type="button" onClick={() => { void delivery.flush(); }}>Повторить отправку</button>}
    </aside>}
  </Context.Provider>;
}
