'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { adminRequest, ADMIN_UPLOAD_TIMEOUT_MS, runWithRequestTimeout } from '@/features/admin/shared/adminRequest';

import { CURRENCY_RPC_CHANNEL, CURRENCY_RPC_MAX_BYTES, parseCurrencyRpcRequest } from '@/shared/lib/currencyDashboardRpc';
import { createCurrencyDeviceBridge, isCurrencyDeviceMethod } from '@/shared/lib/currencyDashboardDeviceState';
import { createCurrencyDashboardScheduler, createCurrencySchedulerWorker } from '@/shared/lib/currencyDashboardScheduler';
import { useDashboardUsage } from '@/features/admin/dashboard-usage/useDashboardUsage';
import { DashboardAudienceEditor } from '@/features/admin/dashboard-access/DashboardAudienceEditor';
import { CurrencyHtmlManagement } from './CurrencyHtmlManagement';

import styles from './currency-dashboard.module.scss';

const SOURCE_LABELS: Record<string, string> = { 'cbr-daily':'Курсы ЦБ', 'cbr-history':'История ЦБ', 'cbr-base-history':'История ЦБ с 2022 года', 'moex-currency':'Валюты Мосбиржи', 'moex-futures':'Фьючерсы Мосбиржи', world:'Мировые курсы', copper:'Медь LME' };
const dateFormat = new Intl.DateTimeFormat('ru-RU', {dateStyle:'short', timeStyle:'short', timeZone:'Europe/Moscow'});

function CurrencyPublishedUsage({ iframeRef }: { iframeRef: RefObject<HTMLIFrameElement | null> }) {
  useDashboardUsage({ dashboardKey:'currency-rates', iframeRef, opaque:true });
  return null;
}

/** Mounted only after an administrator explicitly opens a draft in this client UI. */
function CurrencyHtmlPreview({ versionId }: { versionId: number }) {
  const [nonce] = useState(() => crypto.randomUUID());
  return <CurrencyDashboard nonce={nonce} deviceScope={null} canManage={false} embedded previewVersion={versionId} />;
}

export function CurrencyDashboard({ nonce, deviceScope, canManage, embedded = false, canAssignAccess = false, previewVersion }: { nonce: string; deviceScope: string | null; canManage: boolean; embedded?: boolean; canAssignAccess?: boolean; previewVersion?: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLElement>(null);
  const [error, setError] = useState('');
  const [sources, setSources] = useState<Record<string, {fetchedAt: string; stale: boolean}>>({});
  const [publication, setPublication] = useState<{ base: string; nonce: string } | null>(null);
  const frameNonce = publication?.base === nonce ? publication.nonce : nonce;
  const isPreview = previewVersion !== undefined;
  const embeddedView = embedded || isPreview;
  const readOnly = !canManage || embeddedView;

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let pageAway = false;
    let scheduleTarget: Window | null = null;
    const pending = new Map<string, AbortController>();
    const completed = new Set<string>();
    const iframe = frame.current;
    const scheduler = createCurrencyDashboardScheduler({
      createWorker: createCurrencySchedulerWorker,
      setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
      clearInterval: (timer) => window.clearInterval(timer),
      tick: () => {
        if (!disposed && !pageAway && scheduleTarget && frame.current?.contentWindow === scheduleTarget) {
          scheduleTarget.postMessage({ channel: CURRENCY_RPC_CHANNEL, nonce: frameNonce, event: 'schedule:tick' }, '*');
        }
      },
    });
    const resetFrame = () => {
      generation++;
      scheduleTarget = null;
      scheduler.stop();
      for (const controller of pending.values()) controller.abort();
      pending.clear();
      completed.clear();
    };
    const pauseSchedule = () => { pageAway = true; scheduler.stop(); };
    const resumeSchedule = () => {
      pageAway = false;
      if (scheduleTarget) { scheduler.start(); scheduler.tick(); }
    };
    const visibleSchedule = () => { if (!document.hidden && !pageAway && scheduleTarget) scheduler.tick(); };
    const deviceCommand = createCurrencyDeviceBridge(isPreview ? null : deviceScope, () => isPreview ? null : window.localStorage, () => {
      if (isPreview) return null;
      if (!window.isSecureContext || !('Notification' in window)) return null;
      return {
        permission: () => Notification.permission,
        requestPermission: () => Notification.requestPermission(),
        show: (body: string) => {
          const options: NotificationOptions & { renotify: boolean } = { body, tag: 'kts-rate', renotify: true, requireInteraction: true, silent: false };
          new Notification('Курсы валют', options);
        },
      };
    });
    const receive = async (event: MessageEvent) => {
      if (disposed) return;
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (!data || data.channel !== CURRENCY_RPC_CHANNEL || data.nonce !== frameNonce
        || typeof data.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(data.id)) return;
      if (pending.has(data.id) || completed.has(data.id) || pending.size >= 16) return;
      const target = event.source as Window;
      const requestGeneration = generation;
      const reply = (value: object) => {
        // The destination is an opaque-origin, sandboxed iframe; source and nonce
        // identify this exact instance. No credentials are sent into the frame.
        if (!disposed && generation === requestGeneration && frame.current?.contentWindow === target) {
          target.postMessage({ channel: CURRENCY_RPC_CHANNEL, nonce: frameNonce, id: data.id, ...value }, '*');
        }
      };
      const controller = new AbortController();
      pending.set(data.id, controller);
      try {
        if (data.method === 'schedule:start') {
          if (!data.params || typeof data.params !== 'object' || Array.isArray(data.params) || Reflect.ownKeys(data.params).length) {
            throw new Error('Некорректные параметры расписания отчёта.');
          }
          scheduleTarget = target;
          if (!pageAway) scheduler.start();
          reply({ result: { started: true } });
          return;
        }
        if (isCurrencyDeviceMethod(data.method)) {
          reply({ result: await runWithRequestTimeout(async () => deviceCommand(data.method, data.params), { signal: controller.signal, timeoutMs: 60_000 }) });
          return;
        }
        const payload = parseCurrencyRpcRequest(data);
        if ((isPreview || readOnly) && (payload.method === 'snapshot:save' || payload.method === 'snapshot:rollback')) {
          reply({error:{message:'На этом экране доступен только просмотр.', status:403, code:'CURRENCY_READ_ONLY'}});
          return;
        }
        const body = JSON.stringify(payload);
        if (new TextEncoder().encode(body).byteLength > CURRENCY_RPC_MAX_BYTES) throw new Error('Снимок больше 2 МБ');
        const mutation = payload.method === 'snapshot:save' || payload.method === 'snapshot:rollback';
        const response = await adminRequest('/api/admin/currency-dashboard', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal,
        }, { mutation, timeoutMs: mutation ? ADMIN_UPLOAD_TIMEOUT_MS : 60_000 });
        const result = await response.json();
        if (disposed || generation !== requestGeneration) return;
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
        if (generation === requestGeneration) {
          if (pending.get(data.id) === controller) pending.delete(data.id);
          completed.add(data.id);
          if (completed.size > 1000) completed.delete(completed.values().next().value!);
        }
      }
    };
    window.addEventListener('message', receive);
    window.addEventListener('pagehide', pauseSchedule);
    window.addEventListener('pageshow', resumeSchedule);
    document.addEventListener('visibilitychange', visibleSchedule);
    iframe?.addEventListener('load', resetFrame);
    return () => {
      disposed = true;
      window.removeEventListener('message', receive);
      window.removeEventListener('pagehide', pauseSchedule);
      window.removeEventListener('pageshow', resumeSchedule);
      document.removeEventListener('visibilitychange', visibleSchedule);
      iframe?.removeEventListener('load', resetFrame);
      resetFrame();
    };
  }, [frameNonce, deviceScope, isPreview, previewVersion, readOnly]);

  const fullScreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await container.current?.requestFullscreen();
    } catch { setError('Этот браузер не разрешил полноэкранный режим. Можно увеличить окно браузера вручную.'); }
  };

  return (
    <section className={embeddedView ? styles.embedded : styles.root} ref={container}>
      {!isPreview && <CurrencyPublishedUsage key={frameNonce} iframeRef={frame} />}
      {!embeddedView && <div className={styles.toolbar}>
        <div><h1>Курсы валют и медь</h1><p>Общие данные для сотрудников с доступом · авторский HTML-дашборд{readOnly && ' · только просмотр'}</p></div>
        <nav aria-label="Навигация отчёта">
          <Link href="/admin/top">К списку отчётов</Link>
          <button type="button" onClick={fullScreen}>На весь экран</button>
        </nav>
      </div>}
      {!embeddedView && Object.keys(sources).length > 0 ? <details className={styles.sourceDates}>
        <summary>Последние успешные проверки источников, МСК</summary>
        <p>Время получения данных не означает время изменения котировки. Дата действия курса и задержка источника показаны внутри отчёта.</p>
        <ul>{Object.entries(sources).map(([kind, source]) => <li key={kind}>{SOURCE_LABELS[kind]}: {dateFormat.format(new Date(source.fetchedAt))} МСК{source.stale ? ' — показана сохранённая версия, источник недоступен' : ''}</li>)}</ul>
      </details> : null}
      {error && <p className={styles.error} role="alert">{error} <Link href="/admin">Открыть кабинет</Link></p>}
      <iframe
        key={`${frameNonce}:${previewVersion ?? 'published'}`}
        ref={frame}
        title={isPreview ? 'Предпросмотр HTML — курсы валют и медь' : 'Курсы валют и медь — интерактивный дашборд'}
        src={`/api/admin/currency-dashboard/frame?nonce=${encodeURIComponent(frameNonce)}${readOnly ? '&readOnly=1' : ''}${isPreview ? `&previewVersion=${previewVersion}` : ''}`}
        sandbox="allow-scripts allow-downloads allow-modals allow-forms"
        allow="fullscreen; autoplay"
        allowFullScreen
        referrerPolicy="same-origin"
        className={styles.frame}
      />
      {!embeddedView && canManage ? <CurrencyHtmlManagement
        onPublished={() => {
          setSources({});
          setError('');
          setPublication({ base: nonce, nonce: crypto.randomUUID() });
        }}
        renderPreview={(versionId) => <CurrencyHtmlPreview key={versionId} versionId={versionId} />}
      /> : null}
      {!embeddedView && canAssignAccess ? <DashboardAudienceEditor dashboardKey="currency-rates" /> : null}
    </section>
  );
}
