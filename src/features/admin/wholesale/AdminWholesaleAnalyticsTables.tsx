import styles from '@/app/admin/admin.module.scss';

import type { Analytics, AnalyticsEvent, ClientRow, ProblemPrice } from './AdminWholesaleAnalyticsTypes';
import {
  EmptyState,
  Badge,
  actorLabels,
  eventDetailLabels,
  eventLabels,
  formatDate,
  formatDateOnly,
  managerAnalyticsHref,
  priceEditHref,
  problemClass,
  problemLabels,
} from './AdminWholesaleAnalyticsHelpers';

export function ProblemPricesTable({ title, rows, routerPush, empty }: { title: string; rows: ProblemPrice[]; routerPush: (href: string) => void; empty: string }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text={empty} /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Проблемы</th><th>Создан</th><th>Обновлён</th><th>Срок</th><th>Просмотры</th><th>PDF</th><th>Действие</th></tr></thead>
            <tbody>
              {rows.map((price) => (
                <tr key={price.id}>
                  <td><strong>{price.title}</strong></td>
                  <td>{price.clientName || '—'}</td>
                  <td>{price.managerName || '—'}</td>
                  <td><div className={styles.analyticsBadgesRow}>{price.problems.map((problem) => <span className={problemClass(problem)} key={problem}>{problemLabels[problem]}</span>)}</div></td>
                  <td>{formatDate(price.createdAt)}</td>
                  <td>{formatDate(price.updatedAt)}</td>
                  <td>{formatDateOnly(price.validUntil)}</td>
                  <td>{price.views ?? 0}</td>
                  <td>{price.pdfDownloads ?? 0}</td>
                  <td><button type="button" onClick={() => routerPush(priceEditHref(price))}>Редактировать</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function SimplePricesTable({ title, rows, routerPush, empty, showDays }: { title: string; rows: ProblemPrice[]; routerPush: (href: string) => void; empty: string; showDays?: boolean }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text={empty} /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Создан</th><th>Активен</th><th>Срок</th>{showDays ? <th>Осталось</th> : null}<th>Действие</th></tr></thead>
            <tbody>{rows.map((price) => <tr key={`${title}-${price.id}`}><td>{price.title}</td><td>{price.clientName || '—'}</td><td>{price.managerName || '—'}</td><td>{formatDate(price.createdAt)}</td><td>{price.isActive ? 'Да' : 'Нет'}</td><td>{formatDateOnly(price.validUntil)}</td>{showDays ? <td>{price.daysLeft ?? '—'}</td> : null}<td><button type="button" onClick={() => routerPush(priceEditHref(price))}>Редактировать</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ProblemsByManagerTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.priceQuality.problemsByManager;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Проблемы по менеджерам</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Проблемных прайсов нет" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Менеджер</th><th>Пустые</th><th>Без клиента</th><th>Без срока</th><th>Просроченные</th><th>Без просмотров</th><th>Не обновлялись</th><th>Всего</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.managerId}><td>{row.managerName}</td><td>{row.emptyPrices}</td><td>{row.pricesWithoutClient}</td><td>{row.pricesWithoutExpiration}</td><td>{row.expiredPrices}</td><td>{row.pricesWithoutViews}</td><td>{row.stalePrices30Days}</td><td>{row.totalProblems}</td><td><button type="button" onClick={() => routerPush(managerAnalyticsHref(row.managerId))}>Аналитика</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ClientsTable({ title, rows, routerPush, empty }: { title: string; rows: ClientRow[]; routerPush: (href: string) => void; empty: string }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text={empty} /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Менеджер</th><th>Прайс</th><th>24 часа</th><th>7 дней</th><th>Всего</th><th>PDF</th><th>Последняя активность</th><th>Статус</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${title}-${row.clientId}-${row.priceId}`}><td>{row.clientName}</td><td>{row.managerName || '—'}</td><td>{row.priceTitle || '—'}</td><td>{row.viewsLast24Hours}</td><td>{row.viewsLast7Days}</td><td>{row.views}</td><td>{row.pdfDownloads}</td><td>{formatDate(row.lastActivityAt)}</td><td><Badge tone={row.status === 'Горячий' ? 'danger' : row.status === 'Не открывал' ? 'warning' : 'orange'}>{row.status}</Badge></td><td>{row.priceId ? <button type="button" onClick={() => routerPush(priceEditHref({ priceId: row.priceId ?? undefined, managerId: row.managerId ?? undefined }))}>Редактировать</button> : '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function TopPublicTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.publicLinks.topViewedPrices;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Топ публичных ссылок</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Просмотров публичных ссылок пока нет" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Просмотры</th><th>Уникальные</th><th>Повторные</th><th>Последний просмотр</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.managerName || '—'}</td><td>{row.views}</td><td>{row.uniqueVisitors}</td><td>{row.repeatViews}</td><td>{formatDate(row.lastViewAt)}</td><td><button type="button" onClick={() => routerPush(priceEditHref(row))}>Редактировать</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function TopPdfTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.pdf.topDownloadedPrices;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Топ прайсов по PDF</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Скачивания PDF пока не зафиксированы" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>PDF</th><th>Уникальные</th><th>Просмотры</th><th>Последний download</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.managerName || '—'}</td><td>{row.downloads}</td><td>{row.uniqueDownloaders}</td><td>{row.views}</td><td>{formatDate(row.lastDownloadAt)}</td><td><button type="button" onClick={() => routerPush(priceEditHref(row))}>Редактировать</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ManagersPdfTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.pdf.managersByDownloads;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Менеджеры по PDF скачиваниям</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Скачивания PDF пока не зафиксированы" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Менеджер</th><th>Прайсов с PDF</th><th>Всего скачиваний</th><th>Уникальные</th><th>Последний download</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.managerId ?? row.managerName}><td>{row.managerName}</td><td>{row.pricesWithDownloads}</td><td>{row.downloads}</td><td>{row.uniqueDownloaders}</td><td>{formatDate(row.lastDownloadAt)}</td><td>{row.managerId ? <button type="button" onClick={() => routerPush(managerAnalyticsHref(row.managerId!))}>Аналитика</button> : '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function TopExcelTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.excel.topDownloadedPrices;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Топ прайсов по Excel</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Скачивания Excel пока не зафиксированы" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Excel</th><th>Уникальные</th><th>Просмотры</th><th>Последний download</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.managerName || '—'}</td><td>{row.downloads}</td><td>{row.uniqueDownloaders}</td><td>{row.views}</td><td>{formatDate(row.lastDownloadAt)}</td><td><button type="button" onClick={() => routerPush(priceEditHref(row))}>Редактировать</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ManagersExcelTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.excel.managersByDownloads;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Менеджеры по Excel скачиваниям</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Скачивания Excel пока не зафиксированы" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Менеджер</th><th>Прайсов с Excel</th><th>Всего скачиваний</th><th>Уникальные</th><th>Последний download</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.managerId ?? row.managerName}><td>{row.managerName}</td><td>{row.pricesWithDownloads}</td><td>{row.downloads}</td><td>{row.uniqueDownloaders}</td><td>{formatDate(row.lastDownloadAt)}</td><td>{row.managerId ? <button type="button" onClick={() => routerPush(managerAnalyticsHref(row.managerId!))}>Аналитика</button> : '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function eventDetailKeyLabel(key: string) {
  return eventDetailLabels[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

export function eventDetailValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (Array.isArray(value)) return value.map(eventDetailValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function parseEventDetails(details: string | null | undefined) {
  const raw = details?.trim() ?? '';
  if (!raw) return { entries: [] as Array<{ label: string; value: string }>, raw: '' };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => ({ label: eventDetailKeyLabel(key), value: eventDetailValue(value) }));

      return { entries, raw: entries.length ? '' : raw };
    }

    return { entries: [] as Array<{ label: string; value: string }>, raw: eventDetailValue(parsed) };
  } catch {
    return { entries: [] as Array<{ label: string; value: string }>, raw };
  }
}

export function isHttpUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function EventField({
  label,
  value,
  href,
  span,
  wide,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  href?: string;
  span?: 2 | 3;
  wide?: boolean;
  mono?: boolean;
}) {
  const className = [
    styles.analyticsEventField,
    span === 2 ? styles.analyticsEventFieldSpan2 : '',
    span === 3 || wide ? styles.analyticsEventFieldWide : '',
    mono ? styles.analyticsEventFieldMono : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <span>{label}</span>
      <strong>
        {href && value ? (
          <a className={styles.analyticsEventLink} href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : value || '—'}
      </strong>
    </div>
  );
}

export function EventCard({ event }: { event: AnalyticsEvent }) {
  const details = parseEventDetails(event.details);
  const refererHref = isHttpUrl(event.referer) ? event.referer : undefined;

  return (
    <article className={styles.analyticsEventCard}>
      <div className={styles.analyticsEventCardHeader}>
        <div>
          <span>{formatDate(event.createdAt)}</span>
          <strong>{event.eventLabelOverride ?? eventLabels[event.eventType] ?? event.eventType}</strong>
        </div>
        <em>{actorLabels[event.actorType] ?? event.actorType}</em>
      </div>
      <div className={styles.analyticsEventGrid}>
        <EventField label="Менеджер" value={event.managerName} />
        <EventField label="Прайс" value={event.priceTitle} />
        <EventField label="Клиент" value={event.clientName} />
        <EventField label="Referer" value={event.referer} href={refererHref} span={2} mono />
        <div className={styles.analyticsEventDetails}>
          <span>Детали</span>
          {details.entries.length > 0 ? (
            <dl className={styles.analyticsEventDetailsGrid}>
              {details.entries.map((entry) => (
                <div key={`${event.id}-${entry.label}`}>
                  <dt>{entry.label}</dt>
                  <dd>{entry.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>{details.raw || '—'}</p>
          )}
        </div>
      </div>
    </article>
  );
}

export function EventsTable({ title, events, empty, inline }: { title: string; events: AnalyticsEvent[]; empty: string; inline?: boolean }) {
  const content = events.length === 0 ? <EmptyState text={empty} /> : (
    <div className={styles.analyticsEventsList}>
      {events.map((event) => <EventCard key={event.id} event={event} />)}
    </div>
  );

  if (inline) return content;
  return <article className={styles.analyticsPanel}><div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{events.length}</span></div>{content}</article>;
}
