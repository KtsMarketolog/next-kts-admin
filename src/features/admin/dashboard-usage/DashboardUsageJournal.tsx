'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { DASHBOARD_USAGE_ACTIONS, DASHBOARD_USAGE_LABELS } from '@/shared/lib/dashboardUsage';
import type { ProfitabilityInvoice } from '@/shared/lib/dashboardProfitabilityAudit';
import type { DashboardUsageRow, DashboardUsageSummary, DashboardUsageEmployeeReports } from '@/shared/lib/db/dashboardUsageRepo';
import styles from './dashboard-usage.module.scss';

const formatTimestamp = (value: string | null) => value
  ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Moscow' }).format(new Date(value))
  : 'Нет за этот месяц';
const roleLabels: Record<string, string> = { admin: 'Администратор', admintop: 'Админ ТОП', top: 'ТОП',
  manager: 'МР', support_manager: 'МС', wholesale_admin: 'Администратор прайсов', purchaser: 'Закупки' };
function formatDuration(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return [hours ? `${hours} ч` : '', minutes ? `${minutes} мин` : '', `${seconds % 60} с`].filter(Boolean).join(' ');
}
const formatFileSize = (bytes: number) => bytes < 1024 ? `${bytes} Б` : bytes < 1048576
  ? `${(bytes / 1024).toFixed(1)} КБ` : `${(bytes / 1048576).toFixed(1)} МБ`;
const uploadTypes = { html: 'Версия HTML', data: 'Данные отчёта', personal: 'Личный снимок' };

function EmployeeUsageSummary({ onSelect }: { onSelect: (actorKey: string, actorName: string) => void }) {
  const [summary, setSummary] = useState<DashboardUsageSummary | null>(null);
  const [searchDraft, setSearchDraft] = useState(''), [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const load = useCallback(async (after?: string) => {
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setBusy(true); setError('');
    if (!after) setSummary(null);
    const params = new URLSearchParams({ view: 'employees' });
    if (search) params.set('search', search);
    if (after) params.set('after', after);
    try {
      const response = await fetch(`/api/admin/dashboard-usage?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить сводку');
      if (!controller.signal.aborted) setSummary((previous) => ({ ...data,
        employees: after && previous ? [...previous.employees, ...data.employees] : data.employees }));
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Сводка недоступна');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }, [search]);
  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load]);
  return <section className={styles.summary} aria-labelledby="usage-employees-heading">
    <h2 id="usage-employees-heading">Последняя активность сотрудников</h2>
    <p className={styles.notice}>Все действующие сотрудники, в том числе без событий за последний месяц. Предпросмотры и архив не учитываются. «Последнее событие» может быть автоматической загрузкой данных; «Действие сотрудника» — вкладка, фильтр, расчёт, экспорт или успешная загрузка файла. Время — регистрация события сервером: при проблемах сети запись может поступить позже.</p>
    <p className={styles.notice}>Время просмотра — сколько отчёт был виден в открытой вкладке, а не оценка работы сотрудника. На парном экране общий итог не удваивается; по каждому отчёту показан его собственный видимый интервал. Новые показатели и имена файлов фиксируются с подключения этой версии журнала; прошлую длительность восстановить нельзя.</p>
    {summary && <p className={styles.notice}>Период: с {formatTimestamp(summary.periodStart)} по {formatTimestamp(summary.generatedAt)} МСК.</p>}
    <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); const next = searchDraft.trim(); if (next === search) void load(); else setSearch(next); }}>
      <label>Сотрудник<input type="search" maxLength={100} value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Поиск по имени" /></label>
      <button type="submit" disabled={busy}>Найти</button>
      <button type="button" disabled={busy} onClick={() => { setSearchDraft(''); if (search) setSearch(''); else void load(); }}>Сбросить</button>
      <button type="button" disabled={busy} onClick={() => void load()}>Обновить сводку</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {summary && <div className={styles.table}><table><thead><tr><th>Сотрудник</th><th>Последнее открытие</th><th>Последнее событие</th><th>Последнее действие сотрудника</th><th>За месяц</th></tr></thead><tbody>
      {summary.employees.map((employee) => <tr key={employee.actorKey}>
        <td><button type="button" onClick={() => onSelect(employee.actorKey, employee.actorName)}>{employee.actorName}</button><small>{roleLabels[employee.actorRole] ?? employee.actorRole}</small></td>
        <td>{formatTimestamp(employee.lastOpenedAt)}</td>
        <td>{formatTimestamp(employee.lastUsedAt)}{employee.lastDashboardTitle && <small>{employee.lastDashboardTitle}</small>}</td>
        <td>{formatTimestamp(employee.lastInteractionAt)}</td>
        <td>Отчётов: {employee.reportCount}<small>Действий: {employee.interactionCount}</small><small>Загрузок файлов: {employee.uploadCount ?? 0}</small><small>Просмотр: {formatDuration(employee.viewingSeconds)}</small>{!employee.lastUsedAt && <small>Нет зафиксированного использования</small>}</td>
      </tr>)}
    </tbody></table></div>}
    {summary && !summary.employees.length && <p>Сотрудники не найдены.</p>}
    {busy && <p role="status">Загружаем сводку…</p>}
    {summary?.nextCursor && <button type="button" disabled={busy} onClick={() => void load(summary.nextCursor!)}>Ещё 50 сотрудников</button>}
  </section>;
}

function EmployeeReportDetails({ actorKey, onSelect }: { actorKey: string; onSelect: (dashboardKey: string) => void }) {
  const [data, setData] = useState<DashboardUsageEmployeeReports | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const load = useCallback(async (after?: string) => {
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setBusy(true); setError('');
    if (!after) setData(null);
    const params = new URLSearchParams({ view: 'employee', actor: actorKey });
    if (after) params.set('after', after);
    try {
      const response = await fetch(`/api/admin/dashboard-usage?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось загрузить отчёты сотрудника');
      if (!controller.signal.aborted) setData((previous) => ({ ...result,
        reports: after && previous ? [...previous.reports, ...result.reports] : result.reports }));
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Сводка недоступна'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [actorKey]);
  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load]);
  return <section className={styles.summary} aria-labelledby="usage-employee-reports-heading">
    <h3 id="usage-employee-reports-heading">Отчёты сотрудника за последний месяц</h3>
    <p className={styles.notice}>Выберите отчёт, чтобы ниже увидеть действия и имена успешно загруженных файлов. Предпросмотры и архив не входят в эти итоги.</p>
    <button type="button" disabled={busy} onClick={() => void load()}>Обновить отчёты сотрудника</button>
    {error && <p role="alert">{error}</p>}
    {data && <div className={styles.table}><table><thead><tr><th>Дашборд</th><th>Последнее открытие / событие, МСК</th><th>Время просмотра</th><th>За месяц</th></tr></thead><tbody>
      {data.reports.map((report) => <tr key={report.dashboardKey}>
        <td><button type="button" onClick={() => onSelect(report.dashboardKey)}>{report.dashboardTitle}</button></td>
        <td>{formatTimestamp(report.lastOpenedAt)}<small>Событие: {formatTimestamp(report.lastUsedAt)}</small></td>
        <td>{formatDuration(report.viewingSeconds)}</td>
        <td>Открытий: {report.openCount}<small>Действий: {report.interactionCount}</small><small>Загрузок файлов: {report.uploadCount}</small></td>
      </tr>)}
    </tbody></table></div>}
    {data && !data.reports.length && <p>Использование отчётов за этот период не зафиксировано.</p>}
    {busy && <p role="status">Загружаем отчёты сотрудника…</p>}
    {data?.nextCursor && <button type="button" disabled={busy} onClick={() => void load(data.nextCursor!)}>Ещё 50 отчётов</button>}
  </section>;
}

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
  const [actorName, setActorName] = useState('');
  const [includePreview, setIncludePreview] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const eventsRef = useRef<HTMLElement | null>(null);
  const load = useCallback(async (before?: string) => {
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setBusy(true); setError('');
    if (!before) { setRows([]); setCursor(null); }
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([key, value]) => { if (value) params.set(key, value); });
    if (before) params.set('before', before);
    if (includePreview) params.set('preview', '1');
    try {
      const response = await fetch(`/api/admin/dashboard-usage?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить журнал');
      if (!controller.signal.aborted) {
        setRows((previous) => before ? [...previous, ...data.events] : data.events);
        setCursor(data.nextCursor);
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Журнал недоступен'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [filter, includePreview]);
  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load]);
  const reset = () => { setFilter({ dashboard: '', actor: '', action: '' }); setActorName(''); setIncludePreview(false); };
  return <main className={styles.page}>
    <div className={styles.root}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>Панель управления</p><h1>Журнал и сотрудники</h1><p className={styles.notice}>История использования дашбордов за последний месяц. Доступна администратору, Админ ТОП и ТОП.</p></div>
      <nav className={styles.navigation} aria-label="Навигация журнала">
        <Link className={styles.backLink} href="/admin">← В админку</Link>
        <Link className={styles.backLink} href="/admin/top">К отчётам</Link>
      </nav>
    </header>
    <p className={styles.notice}>Записываются открытия и поддерживаемые действия, без значений фильтров и паролей. Для успешных загрузок — имя и размер файла, без его содержимого. Только для подключённой «Рентабельности счетов» дополнительно сохраняются номер, номенклатура, количество, сумма и исходная валюта успешно загруженного счёта; сами файлы не сохраняются в журнале. Фоновые обновления не считаются действиями сотрудника. События внутри HTML передаются его адаптером и не подтверждают производительность сотрудника. Экспорт означает подготовку файла, а не подтверждение сохранения на устройстве. История начинается с подключения журнала.</p>
    <EmployeeUsageSummary onSelect={(actor, name) => { setFilter({ dashboard: '', actor, action: '' }); setActorName(name); setIncludePreview(false); eventsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />
    <section ref={eventsRef} className={styles.events} aria-labelledby="usage-events-heading">
    <h2 id="usage-events-heading">События{actorName ? `: ${actorName}` : ''}</h2>
    {filter.actor && <EmployeeReportDetails key={filter.actor} actorKey={filter.actor} onSelect={(dashboard) => { setFilter({ ...filter, dashboard, action: '' }); setIncludePreview(false); }} />}
    <div className={styles.filters}>
      <label>Действие<select value={filter.action} disabled={busy} onChange={(event) => setFilter({ ...filter, action: event.target.value })}><option value="">Все действия</option>{DASHBOARD_USAGE_ACTIONS.map((action) => <option key={action} value={action}>{DASHBOARD_USAGE_LABELS[action]}</option>)}</select></label>
      <label className={styles.checkbox}><input type="checkbox" checked={includePreview} disabled={busy} onChange={(event) => setIncludePreview(event.target.checked)} />Включить предпросмотры и архив</label>
      {(filter.actor || filter.dashboard) && <span>Фильтр: {[actorName || filter.actor, filter.dashboard].filter(Boolean).join(' · ')}</span>}
      <button type="button" disabled={busy} onClick={reset}>Сбросить фильтры</button>
      <button type="button" disabled={busy} onClick={() => void load()}>Обновить</button>
    </div>
    <p className={styles.notice}>Интервалы просмотра включены в сводные итоги. Чтобы увидеть отдельные интервалы, выберите действие «Время видимого отчёта».</p>
    {error && <p role="alert">{error}</p>}
    <div className={styles.table}><table><thead><tr><th>Зарегистрировано, МСК</th><th>Сотрудник</th><th>Дашборд</th><th>Действие</th><th>Режим</th></tr></thead><tbody>
      {rows.map((row) => <Fragment key={row.id}><tr>
        <td>{new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Moscow' }).format(new Date(row.createdAt))}</td>
        <td><button type="button" disabled={busy} onClick={() => { setFilter({ ...filter, actor: row.actorKey }); setActorName(row.actorName); }}>{row.actorName}</button><small>{roleLabels[row.actorRole] ?? row.actorRole}</small></td>
        <td><button type="button" disabled={busy} onClick={() => setFilter({ ...filter, dashboard: row.dashboardKey })}>{row.dashboardTitle}</button>{row.versionId && <small>HTML #{row.versionId}</small>}</td>
        <td>{row.hasProfitabilityDetails ? 'Загружен счёт / КП' : DASHBOARD_USAGE_LABELS[row.action]}
          {row.upload && <small className={styles.upload}>{row.uploadType ? `${uploadTypes[row.uploadType]}: ` : 'Файл обработан в отчёте: '}{row.upload.name} · {formatFileSize(row.upload.size)}</small>}
          {row.durationSeconds !== null && row.durationSeconds !== undefined && <small>{formatDuration(row.durationSeconds)}</small>}
        </td><td>{row.preview ? 'Предпросмотр / архив' : row.action === 'file_uploaded' ? 'Сохранено на сайте' : 'Опубликованный отчёт'}</td>
      </tr>{row.hasProfitabilityDetails && <InvoiceAuditDetails eventId={row.id} />}</Fragment>)}
    </tbody></table></div>
    {!rows.length && !busy && !error && <p>Событий пока нет.</p>}
    {busy && <p role="status">Загружаем журнал…</p>}
    {cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>Показать ещё 50</button>}
    <p className={styles.notice}>Срок хранения — один календарный месяц назад от текущего времени МСК. Просроченные записи скрыты и удаляются отдельным серверным заданием; история снимков и права на отчёты от этого не меняются.</p>
    </section>
    </div>
  </main>;
}
