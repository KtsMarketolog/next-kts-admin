'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { DASHBOARD_USAGE_ACTIONS, DASHBOARD_USAGE_LABELS } from '@/shared/lib/dashboardUsage';
import type { ProfitabilityInvoice } from '@/shared/lib/dashboardProfitabilityAudit';
import type { DashboardUsageRow } from '@/shared/lib/db/dashboardUsageRepo';
import styles from './dashboard-usage.module.scss';

function InvoiceAuditDetails({ eventId }: { eventId: string }) {
  const [open, setOpen] = useState(false);
  const [invoice, setInvoice] = useState<ProfitabilityInvoice | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || invoice) return;
    const controller = new AbortController();
    setError('');
    void fetch(`/api/admin/dashboard-usage/profitability?id=${encodeURIComponent(eventId)}`, {
      cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить детализацию');
      if (!controller.signal.aborted) setInvoice(data.invoice);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Детализация недоступна');
    });
    return () => controller.abort();
  }, [eventId, open, invoice, attempt]);
  const format = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 12 }).format(value);
  return <tr><td colSpan={5} className={styles.invoiceDetails}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Скрыть детализацию счёта' : 'Детализация загруженного счёта'}</button>
    {open && <section aria-label="Детализация загруженного счёта">
      {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt(attempt + 1)}>Повторить</button></p>}
      {!invoice && !error && <p role="status">Загружаем детализацию…</p>}
      {invoice && <>
        <h3>{invoice.documentType === 'quote' ? 'Коммерческое предложение' : 'Счёт'}: {invoice.invoiceNumber || 'номер не распознан'}</h3>
        <p>Сумма: {invoice.dealAmount === null ? 'не распознана' : `${format(invoice.dealAmount)} ${invoice.currency}`}.
          {invoice.amountSource === 'lines' && ' Рассчитана по исходным строкам документа.'}
          {invoice.amountSource === 'document' && ' Итого из исходного документа.'}
        </p>
        <p className={styles.notice}>Данные на момент успешной загрузки. Исходная валюта — без пересчёта в рубли и ручных корректировок расчёта. Пользователь и время события указаны в строке выше; содержание счёта передано самим HTML-отчётом.</p>
        <table><thead><tr><th>Номенклатура</th><th>Количество</th></tr></thead><tbody>
          {invoice.lines.map((line, index) => <tr key={index}><td>{line.nomenclature}</td><td>{format(line.quantity)}</td></tr>)}
        </tbody></table>
      </>}
    </section>}
  </td></tr>;
}

export function DashboardUsageJournal() {
  const [rows, setRows] = useState<DashboardUsageRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState({ dashboard: '', actor: '', action: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = useCallback(async (before?: string) => {
    setBusy(true); setError('');
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([key, value]) => { if (value) params.set(key, value); });
    if (before) params.set('before', before);
    try {
      const response = await fetch(`/api/admin/dashboard-usage?${params}`, { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить журнал');
      setRows((previous) => before ? [...previous, ...data.events] : data.events);
      setCursor(data.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Журнал недоступен'); }
    finally { setBusy(false); }
  }, [filter]);
  useEffect(() => { void load(); }, [load]);
  const reset = () => setFilter({ dashboard: '', actor: '', action: '' });
  return <main className={styles.root}>
    <header><div><h1>История использования дашбордов</h1><p>Журнал доступен ролям Администратор, Админ TOP и TOP. Показан последний месяц.</p></div><Link href="/admin/top">К отчётам</Link></header>
    <p className={styles.notice}>Записываются открытия и поддерживаемые действия, без значений фильтров и паролей. Только для подключённой «Рентабельности счетов» дополнительно сохраняются номер, номенклатура, количество, сумма и исходная валюта успешно загруженного счёта; сами файлы не сохраняются в журнале. Фоновые обновления не считаются действиями сотрудника. События внутри HTML передаются его адаптером и не подтверждают производительность сотрудника. Экспорт означает подготовку файла, а не подтверждение сохранения на устройстве. История начинается с подключения журнала.</p>
    <div className={styles.filters}>
      <label>Действие<select value={filter.action} disabled={busy} onChange={(event) => setFilter({ ...filter, action: event.target.value })}><option value="">Все действия</option>{DASHBOARD_USAGE_ACTIONS.map((action) => <option key={action} value={action}>{DASHBOARD_USAGE_LABELS[action]}</option>)}</select></label>
      {(filter.actor || filter.dashboard) && <span>Фильтр: {[filter.actor, filter.dashboard].filter(Boolean).join(' · ')}</span>}
      <button type="button" disabled={busy} onClick={reset}>Сбросить фильтры</button>
      <button type="button" disabled={busy} onClick={() => void load()}>Обновить</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className={styles.table}><table><thead><tr><th>Дата и время, МСК</th><th>Сотрудник</th><th>Дашборд</th><th>Действие</th><th>Режим</th></tr></thead><tbody>
      {rows.map((row) => <Fragment key={row.id}><tr>
        <td>{new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Moscow' }).format(new Date(row.createdAt))}</td>
        <td><button type="button" disabled={busy} onClick={() => setFilter({ ...filter, actor: row.actorKey })}>{row.actorName}</button><small>{row.actorRole}</small></td>
        <td><button type="button" disabled={busy} onClick={() => setFilter({ ...filter, dashboard: row.dashboardKey })}>{row.dashboardTitle}</button>{row.versionId && <small>HTML #{row.versionId}</small>}</td>
        <td>{row.hasProfitabilityDetails ? 'Загружен счёт / КП' : DASHBOARD_USAGE_LABELS[row.action]}</td><td>{row.preview ? 'Предпросмотр / архив' : 'Опубликованный отчёт'}</td>
      </tr>{row.hasProfitabilityDetails && <InvoiceAuditDetails eventId={row.id} />}</Fragment>)}
    </tbody></table></div>
    {!rows.length && !busy && !error && <p>Событий пока нет.</p>}
    {busy && <p role="status">Загружаем журнал…</p>}
    {cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>Показать ещё 50</button>}
    <p className={styles.notice}>Срок хранения — один календарный месяц назад от текущего времени МСК. Просроченные записи скрыты и удаляются отдельным серверным заданием; история снимков и права на отчёты от этого не меняются.</p>
  </main>;
}
