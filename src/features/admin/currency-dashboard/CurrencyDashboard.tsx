'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { CURRENCY_RPC_CHANNEL, CURRENCY_RPC_MAX_BYTES, parseCurrencyRpcRequest } from '@/shared/lib/currencyDashboardRpc';
import { useDashboardUsage } from '@/features/admin/dashboard-usage/useDashboardUsage';
import { DashboardAudienceEditor } from '@/features/admin/dashboard-access/DashboardAudienceEditor';

import styles from './currency-dashboard.module.scss';

const SOURCE_LABELS: Record<string, string> = { 'cbr-daily':'Курсы ЦБ', 'cbr-history':'История ЦБ', 'moex-currency':'Валюты Мосбиржи', 'moex-futures':'Фьючерсы Мосбиржи', world:'Мировые курсы', copper:'Медь LME' };
const dateFormat = new Intl.DateTimeFormat('ru-RU', {dateStyle:'short', timeStyle:'short', timeZone:'Europe/Moscow'});

export function CurrencyDashboard({ nonce, canManage, embedded = false, canAssignAccess = false }: { nonce: string; canManage: boolean; embedded?: boolean; canAssignAccess?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLElement>(null);
  const [error, setError] = useState('');
  const [sources, setSources] = useState<Record<string, {fetchedAt: string; stale: boolean}>>({});
  useDashboardUsage({dashboardKey:'currency-rates', iframeRef:frame, opaque:true});

  useEffect(() => {
    let disposed = false;
    const pending = new Map<string, AbortController>();
    const completed = new Set<string>();
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (!data || data.channel !== CURRENCY_RPC_CHANNEL || data.nonce !== nonce
        || typeof data.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(data.id)) return;
      if (pending.has(data.id) || completed.has(data.id) || pending.size >= 16) return;
      const target = event.source as Window;
      const reply = (value: object) => {
        // The destination is an opaque-origin, sandboxed iframe; source and nonce
        // identify this exact instance. No credentials are sent into the frame.
        if (!disposed && frame.current?.contentWindow === target) {
          target.postMessage({ channel: CURRENCY_RPC_CHANNEL, nonce, id: data.id, ...value }, '*');
        }
      };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      pending.set(data.id, controller);
      try {
        const payload = parseCurrencyRpcRequest(data);
        if (!canManage && (payload.method === 'snapshot:save' || payload.method === 'snapshot:rollback')) {
          reply({error:{message:'На этом экране доступен только просмотр.', status:403, code:'CURRENCY_READ_ONLY'}});
          return;
        }
        const body = JSON.stringify(payload);
        if (new TextEncoder().encode(body).byteLength > CURRENCY_RPC_MAX_BYTES) throw new Error('Снимок больше 2 МБ');
        const response = await fetch('/api/admin/currency-dashboard', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) {
          if (response.status === 403 && result.code === 'CURRENCY_READ_ONLY') {
            setError('Доступен только просмотр. Нет прав на изменение общих данных дашборда.');
          } else if (response.status === 401 || response.status === 403) {
            setError('Доступ к отчёту завершён. Войдите в кабинет повторно. Несохранённые поля не отправлены.');
          }
          reply({ error: { message: result.error ?? 'Не удалось выполнить запрос', status: response.status, code: result.code } });
        } else {
          const metadata = result?._currencySource;
          const kind = payload.params.kind;
          if (payload.method === 'source' && typeof kind === 'string' && SOURCE_LABELS[kind]
            && typeof metadata?.fetchedAt === 'string' && Number.isFinite(Date.parse(metadata.fetchedAt))) {
            setSources((previous) => ({...previous, [kind]:{fetchedAt:metadata.fetchedAt, stale:metadata.stale === true}}));
          }
          reply({ result });
        }
      } catch (cause) {
        reply({ error: { message: cause instanceof Error && cause.name !== 'AbortError'
          ? cause.message : 'Сервер не ответил. Проверьте соединение и повторите запрос.' } });
      } finally {
        clearTimeout(timeout);
        pending.delete(data.id);
        completed.add(data.id);
        if (completed.size > 1000) completed.delete(completed.values().next().value!);
      }
    };
    window.addEventListener('message', receive);
    return () => {
      disposed = true;
      window.removeEventListener('message', receive);
      for (const controller of pending.values()) controller.abort();
    };
  }, [nonce, canManage]);

  const fullScreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await container.current?.requestFullscreen();
    } catch { setError('Этот браузер не разрешил полноэкранный режим. Можно увеличить окно браузера вручную.'); }
  };

  return (
    <section className={embedded ? styles.embedded : styles.root} ref={container}>
      {!embedded && <div className={styles.toolbar}>
        <div><h1>Курсы валют и медь</h1><p>Общие данные для сотрудников с доступом · авторский дашборд V21{!canManage && ' · только просмотр'}</p></div>
        <nav aria-label="Навигация отчёта">
          <Link href="/admin/top">К списку отчётов</Link>
          <button type="button" onClick={fullScreen}>На весь экран</button>
        </nav>
      </div>}
      {!embedded && Object.keys(sources).length > 0 ? <details className={styles.sourceDates}>
        <summary>Последние успешные проверки источников, МСК</summary>
        <p>Время получения данных не означает время изменения котировки. Дата действия курса и задержка источника показаны внутри отчёта.</p>
        <ul>{Object.entries(sources).map(([kind, source]) => <li key={kind}>{SOURCE_LABELS[kind]}: {dateFormat.format(new Date(source.fetchedAt))} МСК{source.stale ? ' — показана сохранённая версия, источник недоступен' : ''}</li>)}</ul>
      </details> : null}
      {error && <p className={styles.error} role="alert">{error} <Link href="/admin">Открыть кабинет</Link></p>}
      <iframe
        ref={frame}
        title="Курсы валют и медь — интерактивный дашборд"
        src={`/api/admin/currency-dashboard/frame?nonce=${encodeURIComponent(nonce)}${embedded ? '&readOnly=1' : ''}`}
        sandbox="allow-scripts allow-downloads allow-modals allow-forms"
        allow="fullscreen; autoplay"
        allowFullScreen
        referrerPolicy="same-origin"
        className={styles.frame}
      />
      {!embedded && canAssignAccess ? <DashboardAudienceEditor dashboardKey="currency-rates" /> : null}
    </section>
  );
}
