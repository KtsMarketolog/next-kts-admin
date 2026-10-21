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
      const previous = delivery.getSnapshot();
      const hadPendingEvents = previous.unsaved > 0 || (['authentication', 'session'].includes(previous.status) && previous.pending > 0);
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
      const snapshot = delivery.getSnapshot();
      if (!snapshot.unsaved && !(['authentication', 'session'].includes(snapshot.status) && snapshot.pending > 0)) return;
      flush();
      if (!window.confirm('Некоторые действия ещё не защищены от потери или относятся к завершённому сеансу. ОК — уйти, Отмена — остаться и дождаться отправки.')) {
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
  const stopped = ['authentication', 'session'].includes(state.status);
  const storageProblem = state.storage === 'unavailable' || state.storage === 'full';
  const problem = stopped || state.status === 'retrying' || state.status === 'offline' || state.skipped > 0 || state.quarantined > 0 || state.expired > 0 || storageProblem;
  return <Context.Provider value={delivery}>
    {children}
    {problem && <aside className={styles.notice} role="status" aria-live="polite" aria-label="Состояние журнала действий">
      <strong>Журнал действий: {state.pending} ожидают записи</strong>
      <p>{stopped
        ? 'Исходный сеанс завершён или изменился. Обновите страницу для продолжения работы. Его очередь не будет отправлена от имени другого сотрудника или нового сеанса.'
        : state.pending > 0 ? state.unsaved > 0
          ? 'Сервер пока не подтвердил запись. Повторим отправку автоматически. Часть событий ещё не сохранена в браузере — до сохранения не закрывайте страницу.'
          : 'События сохранены в этом браузере. Повторим отправку автоматически, в том числе после перезагрузки в том же сеансе.'
          : 'Остальные события отправляются независимо от отклонённых записей.'}</p>
      {storageProblem && <p>{state.storage === 'full' ? 'Локальная очередь достигла ограничения объёма.' : 'Локальное хранилище журнала недоступно.'} Не сохранено в браузере: {state.unsaved}. Доставка работает, пока страница открыта; при закрытии эти события могут быть потеряны.</p>}
      {state.quarantined > 0 && <p>Изолировано событий: {state.quarantined}. Сервер отклонил их из-за доступа или формата. Они не блокируют другие отчёты и не отправляются повторно автоматически.</p>}
      <p>Локальная очередь: до 20 000 событий, 16 МиБ и 30 дней. Она привязана к исходному сеансу; очистка данных браузера удаляет очередь.</p>
      {state.skipped > 0 && <p>Очередь была заполнена: не удалось сохранить действий — {state.skipped}. Уже собранные события не удалены.</p>}
      {state.expired > 0 && <p>Удалено просроченных или повреждённых локальных записей: {state.expired}. Неподтверждённые события хранятся до 30 дней; очистка данных браузера также удаляет их.</p>}
      {!stopped && state.pending > 0 && <button type="button" onClick={() => { void delivery.flush(); }}>Повторить отправку</button>}
    </aside>}
  </Context.Provider>;
}
