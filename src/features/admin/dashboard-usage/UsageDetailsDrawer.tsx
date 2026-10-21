import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProfitabilityInvoice } from '@/shared/lib/dashboardProfitabilityAudit';
import type { DashboardUsageEmployeeReports, DashboardUsageRow } from '@/shared/lib/db/dashboardUsageRepo';
import { eventLabel, eventMode, firstPage, formatDuration, formatFileSize, formatTimestamp, roleLabels, uploadTypes, usagePeriodLabel, usageUrl, type UsagePeriod, type UsagePerson, type UsageSelection } from './usage-journal-shared';
import { useUsagePage } from './useUsagePage';
import { UsagePagination } from './UsagePagination';
import styles from './dashboard-usage.module.scss';

type ViewEvents = (person: UsagePerson, dashboard?: { key: string; title: string }) => void;

function EmployeeDetails({ selection, period, onViewEvents }: { selection: Extract<UsageSelection, { kind: 'employee' }>; period: UsagePeriod; onViewEvents: ViewEvents }) {
  const { person, summary } = selection;
  const [pages, setPages] = useState(firstPage);
  const reportsRef = useRef<HTMLElement>(null);
  const { data, busy, error, reload } = useUsagePage<DashboardUsageEmployeeReports>(
    usageUrl({ view: 'employee', actor: person.actorKey, ...period }, pages), 'Не удалось загрузить отчёты сотрудника');
  return <>
    <p className={styles.role}>{roleLabels[person.actorRole] ?? person.actorRole} · {usagePeriodLabel(period)}</p>
    {summary && <>
      <dl className={styles.metrics}>
        <div><dt>Отчёты</dt><dd>{summary.reportCount}</dd></div><div><dt>Действия</dt><dd>{summary.interactionCount}</dd></div>
        <div><dt>Загрузки файлов</dt><dd>{summary.uploadCount}</dd></div>
        <div><dt>Время просмотра</dt><dd>{summary.viewingSeconds > 0 ? formatDuration(summary.viewingSeconds) : 'Не зафиксировано'}</dd></div>
      </dl>
      <dl className={styles.facts}>
        <div><dt>Последнее открытие</dt><dd>{formatTimestamp(summary.lastOpenedAt)}</dd></div>
        <div><dt>Последнее действие сотрудника</dt><dd>{formatTimestamp(summary.lastInteractionAt)}</dd></div>
        <div><dt>Последнее событие (в том числе автоматическое)</dt><dd>{formatTimestamp(summary.lastUsedAt)}{summary.lastDashboardTitle && <small>{summary.lastDashboardTitle}</small>}</dd></div>
      </dl>
    </>}
    <button className={styles.primaryButton} type="button" onClick={() => onViewEvents(person)}>Посмотреть события</button>
    <section ref={reportsRef} aria-labelledby="usage-employee-reports-heading" className={styles.reportSection}>
      <h3 id="usage-employee-reports-heading">Отчёты сотрудника за выбранный период</h3>
      <p className={styles.notice}>Открытия, действия и загрузки файлов по каждому отчёту. Предпросмотры и архив не входят в итоги.</p>
      {error && <div role="alert" className={styles.error}>{error} <button type="button" onClick={reload}>Повторить</button></div>}
      {busy && <p role="status">Загружаем отчёты сотрудника…</p>}
      {data?.reports.map((report) => <article className={styles.reportCard} key={report.dashboardKey}>
        <h4>{report.dashboardTitle}</h4>
        <p className={styles.period}>Открытие: {formatTimestamp(report.lastOpenedAt)}<br />Событие: {formatTimestamp(report.lastUsedAt)}</p>
        <dl className={styles.reportMetrics}>
          <div><dt>Открытия</dt><dd>{report.openCount}</dd></div><div><dt>Действия</dt><dd>{report.interactionCount}</dd></div>
          <div><dt>Файлы</dt><dd>{report.uploadCount}</dd></div><div><dt>Просмотр</dt><dd>{report.viewingSeconds > 0 ? formatDuration(report.viewingSeconds) : '—'}</dd></div>
        </dl>
        <button type="button" onClick={() => onViewEvents(person, { key: report.dashboardKey, title: report.dashboardTitle })}>События: {report.dashboardTitle}</button>
      </article>)}
      {data && !data.reports.length && <p className={styles.empty}>Использование отчётов за этот период не зафиксировано.</p>}
      <UsagePagination pages={pages} nextCursor={data?.nextCursor} busy={busy} count={data?.reports.length} onChange={(next) => {
        setPages(next); reportsRef.current?.scrollIntoView({ block: 'start' });
      }} />
    </section>
    <p className={styles.notice}>Время — регистрация события сервером (МСК). Время просмотра отражает видимость отчёта, не продуктивность. Прошлую длительность восстановить нельзя.</p>
  </>;
}

function InvoiceData({ eventId }: { eventId: string }) {
  const { data, error, busy, reload } = useUsagePage<{ invoice: ProfitabilityInvoice }>(
    `/api/admin/dashboard-usage/profitability?id=${encodeURIComponent(eventId)}`, 'Не удалось загрузить детализацию');
  const invoice = data?.invoice;
  const format = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 12 }).format(value);
  return <section aria-label="Детализация загруженного счёта" className={styles.invoiceDetails}>
    {error && <div role="alert" className={styles.error}>{error} <button type="button" onClick={reload}>Повторить</button></div>}
    {busy && <p role="status">Загружаем детализацию…</p>}
    {invoice && <>
      <h3>{invoice.documentType === 'quote' ? 'Коммерческое предложение' : 'Счёт'}: {invoice.invoiceNumber || 'номер не распознан'}</h3>
      <p>Сумма: {invoice.dealAmount === null ? 'не распознана' : `${format(invoice.dealAmount)} ${invoice.currency}`}.
        {invoice.amountSource === 'lines' && ' Рассчитана по исходным строкам документа.'}
        {invoice.amountSource === 'document' && ' Итого из исходного документа.'}</p>
      <p className={styles.notice}>Данные на момент успешной загрузки. Исходная валюта — без пересчёта в рубли и ручных корректировок расчёта. Содержание счёта передано самим HTML-отчётом.</p>
      <div className={styles.table} tabIndex={0} role="region" aria-label="Номенклатура счёта"><table><thead><tr><th>Номенклатура</th><th>Количество</th></tr></thead><tbody>
        {invoice.lines.map((line, index) => <tr key={index}><td>{line.nomenclature}</td><td>{format(line.quantity)}</td></tr>)}
      </tbody></table></div>
    </>}
  </section>;
}

function EventDetails({ event, onViewEvents }: { event: DashboardUsageRow; onViewEvents: ViewEvents }) {
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  return <>
    <p className={styles.eventTitle}>{eventLabel(event)}</p>
    <dl className={styles.facts}>
      <div><dt>Зарегистрировано, МСК</dt><dd>{formatTimestamp(event.createdAt)}</dd></div>
      {event.capturedAt && <div><dt>{event.capturedSource === 'server' ? 'Операция сохранена, МСК' : 'Зафиксировано браузером, МСК'}</dt>
        <dd>{formatTimestamp(event.capturedAt)}<small>{event.capturedSource === 'server'
          ? 'Время сохранения операции на сервере; запись в журнал могла поступить позже.'
          : 'Часы устройства сотрудника; время не подтверждено сервером. Фильтры и сводка используют время регистрации.'}</small></dd></div>}
      <div><dt>Сотрудник</dt><dd>{event.actorName}<small>{roleLabels[event.actorRole] ?? event.actorRole}</small></dd></div>
      <div><dt>Дашборд</dt><dd>{event.dashboardTitle}{event.versionId && <small>HTML #{event.versionId}</small>}</dd></div>
      <div><dt>Режим</dt><dd>{eventMode(event)}</dd></div>
      {event.upload && <div><dt>{event.uploadType ? uploadTypes[event.uploadType] : 'Файл обработан в отчёте'}</dt>
        <dd className={styles.upload}>{event.upload.name}<small>{formatFileSize(event.upload.size)}</small></dd></div>}
      {event.durationSeconds !== null && event.durationSeconds !== undefined && <div><dt>Время видимого отчёта</dt><dd>{formatDuration(event.durationSeconds)}</dd></div>}
    </dl>
    <button type="button" onClick={() => onViewEvents(event)}>Все события сотрудника</button>
    {event.hasProfitabilityDetails && <div className={styles.invoiceSection}>
      <button type="button" aria-expanded={invoiceOpen} onClick={() => setInvoiceOpen(!invoiceOpen)}>{invoiceOpen ? 'Скрыть детализацию счёта' : 'Детализация загруженного счёта'}</button>
      {invoiceOpen && <InvoiceData eventId={event.id} />}
    </div>}
    <p className={styles.notice}>Экспорт означает подготовку файла, а не подтверждение его сохранения на устройстве. Автоматическая загрузка данных не означает действие сотрудника.</p>
  </>;
}

export function UsageDetailsDrawer({ selection, period, onClose, onViewEvents }: {
  selection: UsageSelection; period: UsagePeriod; onClose: () => void; onViewEvents: ViewEvents;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.showModal();
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  const title = selection.kind === 'employee' ? `Сотрудник: ${selection.person.actorName}` : 'Подробности события';
  // Native modal dialog provides focus containment and makes the underlying page inert.
  return createPortal(<dialog ref={dialogRef} className={`${styles.drawer} ${styles.controls}`} aria-labelledby="usage-drawer-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.drawerContent}>
      <header className={styles.drawerHeader}><h2 id="usage-drawer-title">{title}</h2>
        <button type="button" aria-label="Закрыть подробности" onClick={onClose}>Закрыть <span aria-hidden="true">×</span></button></header>
      <div className={styles.drawerBody}>
        {selection.kind === 'employee' ? <EmployeeDetails selection={selection} period={period} onViewEvents={onViewEvents} />
          : <EventDetails event={selection.event} onViewEvents={onViewEvents} />}
      </div>
    </div>
  </dialog>, document.body);
}
