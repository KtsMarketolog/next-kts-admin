'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { CURRENCY_RPC_CHANNEL, CURRENCY_RPC_MAX_BYTES, parseCurrencyRpcRequest } from '@/shared/lib/currencyDashboardRpc';

import styles from './currency-dashboard.module.scss';

export function CurrencyDashboard({ nonce }: { nonce: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLElement>(null);
  const [error, setError] = useState('');

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
        const body = JSON.stringify(payload);
        if (new TextEncoder().encode(body).byteLength > CURRENCY_RPC_MAX_BYTES) throw new Error('Снимок больше 2 МБ');
        const response = await fetch('/api/admin/currency-dashboard', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            setError('Доступ к отчёту завершён. Войдите в кабинет повторно. Несохранённые поля не отправлены.');
          }
          reply({ error: { message: result.error ?? 'Не удалось выполнить запрос', status: response.status, code: result.code } });
        } else reply({ result });
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
  }, [nonce]);

  const fullScreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await container.current?.requestFullscreen();
    } catch { setError('Этот браузер не разрешил полноэкранный режим. Можно увеличить окно браузера вручную.'); }
  };

  return (
    <main className={styles.root} ref={container}>
      <div className={styles.toolbar}>
        <div><h1>Курсы валют и медь</h1><p>Общие данные для Админа и Админ TOP · авторский дашборд V21</p></div>
        <nav aria-label="Навигация отчёта">
          <Link href="/admin/top">К списку отчётов</Link>
          <button type="button" onClick={fullScreen}>На весь экран</button>
        </nav>
      </div>
      {error && <p className={styles.error} role="alert">{error} <Link href="/admin">Открыть кабинет</Link></p>}
      <iframe
        ref={frame}
        title="Курсы валют и медь — интерактивный дашборд"
        src={`/api/admin/currency-dashboard/frame?nonce=${encodeURIComponent(nonce)}`}
        sandbox="allow-scripts allow-downloads allow-modals allow-forms"
        allow="fullscreen; autoplay"
        allowFullScreen
        referrerPolicy="same-origin"
        className={styles.frame}
      />
    </main>
  );
}
