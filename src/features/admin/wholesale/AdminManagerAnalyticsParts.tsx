'use client';

import styles from '@/app/admin/admin.module.scss';

import type { AnalyticsClient, AnalyticsEvent, AttentionPrice, ClientHistory, ManagerAnalytics, PeriodComparison, PriorityClient, Problem, ProblemPrice, ReactionNeeded, StatusFunnel } from './AdminManagerAnalyticsTypes';

const problemLabels: Record<Problem, string> = {
  EMPTY: 'Пустой',
  NO_CLIENT: 'Без клиента',
  NO_EXPIRATION: 'Без срока',
  EXPIRED: 'Просрочен',
  EXPIRING_SOON: 'Скоро истекает',
  STALE: 'Не обновлялся',
  NO_VIEWS: 'Без просмотров',
};

export const eventLabels: Record<string, string> = {
  manager_login: 'Вход менеджера',
  price_created: 'Создан прайс',
  price_updated: 'Изменён прайс',
  price_deleted: 'Удалён прайс',
  price_activated: 'Прайс включён',
  price_deactivated: 'Прайс отключён',
  price_client_changed: 'Изменён клиент',
  price_expiration_changed: 'Изменён срок действия',
  price_items_added: 'Добавлены позиции',
  price_items_removed: 'Удалены позиции',
  price_status_changed: 'Изменён статус прайса',
  price_public_link_created: 'Создана публичная ссылка',
  price_public_link_copied: 'Скопирована публичная ссылка',
  public_price_opened: 'Клиент открыл прайс',
  public_price_reopened: 'Клиент повторно открыл прайс',
  public_price_pdf_downloaded: 'Клиент скачал PDF',
  public_price_excel_downloaded: 'Клиент скачал Excel',
  public_price_phone_clicked: 'Клиент нажал телефон',
  public_price_email_clicked: 'Клиент нажал email',
  public_price_product_opened: 'Клиент открыл товар',
  public_price_search_used: 'Клиент использовал поиск',
  public_price_filter_used: 'Клиент использовал фильтр',
  public_price_request_started: 'Клиент начал заявку',
  public_price_quantity_changed: 'Клиент выбрал количество',
  public_price_request_abandoned: 'Клиент бросил заявку',
  public_price_request_sent: 'Клиент отправил заявку',
};

export function formatDate(value: string | null | undefined) {
  if (!value) return 'Нет данных';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateOnly(value: string | null | undefined) {
  if (!value) return '—';
  const datePart = value.slice(0, 10);
  const [year, month, day] = datePart.split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}

export function eventLabel(value: string) {
  return eventLabels[value] ?? value;
}

function isHttpUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function problemClass(problem: Problem) {
  if (problem === 'EXPIRED' || problem === 'NO_CLIENT') return styles.analyticsBadgeDanger;
  if (problem === 'NO_EXPIRATION' || problem === 'EXPIRING_SOON' || problem === 'NO_VIEWS') return styles.analyticsBadgeWarning;
  return styles.analyticsBadgeOrange;
}

export function qualityLabel(score: number) {
  if (score >= 90) return 'Отлично';
  if (score >= 70) return 'Хорошо';
  if (score >= 50) return 'Требует внимания';
  return 'Плохо';
}

export function KpiCard({ title, value, text, tone }: { title: string; value: number | string; text: string; tone?: string }) {
  return (
    <article className={`${styles.analyticsKpiCard} ${tone ?? styles.analyticsToneBlue}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{text}</p>
    </article>
  );
}

function EmptyState({ children }: { children: string }) {
  return <p className={styles.mutedText}>{children}</p>;
}

function formatHours(value: number | null | undefined) {
  return value === null || value === undefined ? 'Нет данных' : `${value} ч`;
}

function formatChange(value: number | null) {
  if (value === null) return 'новый рост';
  if (value > 0) return `+${value}%`;
  return `${value}%`;
}

export function ManagerStatusFunnelPanel({ funnel }: { funnel: StatusFunnel }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}>
        <h3>Воронка по статусам</h3>
        <span>{funnel.biggestDrop ? `Провал: ${funnel.biggestDrop.label}` : 'По прайсам менеджера'}</span>
      </div>
      <div className={styles.analyticsTopList}>
        {funnel.steps.map((step) => (
          <div className={styles.analyticsTopItem} key={step.key}>
            <span>{step.label}</span>
            <span className={styles.analyticsTopViewedAt}>{step.conversionFromTotal}% от всех • {step.conversionFromPrevious}% от прошлого</span>
            <strong>{step.count}</strong>
          </div>
        ))}
      </div>
      <dl className={styles.analyticsList}>
        <div><dt>Создание → открытие</dt><dd>{formatHours(funnel.averageTimeToOpenHours)}</dd></div>
        <div><dt>Открытие → PDF</dt><dd>{formatHours(funnel.averageTimeToPdfHours)}</dd></div>
        <div><dt>Открытие → заявка</dt><dd>{formatHours(funnel.averageTimeToRequestHours)}</dd></div>
      </dl>
    </article>
  );
}

export function ManagerPeriodComparisonPanel({ rows }: { rows: PeriodComparison[] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Сравнение периодов</h3><span>Текущий против прошлого</span></div>
      {rows.length === 0 ? <EmptyState>Для всего времени сравнение не считается</EmptyState> : (
        <div className={styles.analyticsTopList}>
          {rows.map((row) => (
            <div className={styles.analyticsTopItem} key={row.label}>
              <span>{row.label}</span>
              <span className={styles.analyticsTopViewedAt}>прошлый: {row.previous} • {formatChange(row.changePercent)}</span>
              <strong>{row.current}</strong>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function ManagerAttentionPricesTable({ rows, managerId, routerPush }: { rows: AttentionPrice[]; managerId: number; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Прайсы, которые застряли</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Застрявших прайсов нет</EmptyState> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Причина</th><th>Статус</th><th>Дней</th><th>Активность клиента</th><th>Просмотры</th><th>PDF</th><th>Заявки</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.id}-${row.reason}`}><td>{row.title}</td><td>{row.clientName || '—'}</td><td><span className={styles.analyticsBadgeDanger}>{row.reason}</span></td><td>{row.workflowStatusLabel}</td><td>{row.daysInStage}</td><td>{formatDate(row.lastClientActivityAt)}</td><td>{row.views}</td><td>{row.pdfDownloads}</td><td>{row.requestsSent}</td><td><button type="button" onClick={() => routerPush(`/admin/wholesale/${row.id}/edit?analyticsManagerId=${managerId}`)}>Открыть</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ManagerReactionNeededTable({ rows, managerId, routerPush }: { rows: ReactionNeeded[]; managerId: number; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Клиент проявил интерес, реакции нет</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Неотработанных клиентских действий нет</EmptyState> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Прайс</th><th>Действие клиента</th><th>Без реакции</th><th>Статус</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.priceId}-${row.lastClientActivityAt}`}><td>{row.clientName || '—'}</td><td>{row.priceTitle}</td><td>{eventLabel(row.lastClientEventType)}<br /><span>{formatDate(row.lastClientActivityAt)}</span></td><td>{formatHours(row.hoursWithoutReaction)}</td><td>{row.workflowStatusLabel}</td><td><button type="button" onClick={() => routerPush(`/admin/wholesale/${row.priceId}/edit?analyticsManagerId=${managerId}`)}>Открыть</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ManagerPriorityClientsTable({ rows, managerId, routerPush }: { rows: PriorityClient[]; managerId: number; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Клиенты, с которыми связаться сегодня</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Приоритетных клиентов пока нет</EmptyState> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Прайс</th><th>Приоритет</th><th>Причины</th><th>24 часа</th><th>7 дней</th><th>PDF</th><th>Заявки</th><th>Последняя активность</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.clientId}-${row.priceId}`}><td>{row.clientName}</td><td>{row.priceTitle}</td><td><strong>{row.score}</strong></td><td><div className={styles.analyticsBadgesRow}>{row.reasons.map((reason) => <span className={styles.analyticsBadgeOrange} key={reason}>{reason}</span>)}</div></td><td>{row.viewsLast24Hours}</td><td>{row.viewsLast7Days}</td><td>{row.pdfDownloads}</td><td>{row.requestsSent}</td><td>{formatDate(row.lastActivityAt)}</td><td><button type="button" onClick={() => routerPush(`/admin/wholesale/${row.priceId}/edit?analyticsManagerId=${managerId}`)}>Открыть</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ManagerClientHistoryTable({ rows }: { rows: ClientHistory[] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>История клиентов</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>История клиентов пока пустая</EmptyState> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Прайсов</th><th>Активных</th><th>Актуальных</th><th>Просроченных</th><th>Статусы</th><th>Просмотры</th><th>PDF</th><th>Заявки</th><th>Последняя активность</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.clientId}><td>{row.clientName}</td><td>{row.priceCount}</td><td>{row.activePrices}</td><td>{row.activeActualPrices}</td><td>{row.expiredPrices}</td><td><div className={styles.analyticsBadgesRow}>{row.statuses.map((status) => <span className={styles.analyticsBadgeOrange} key={status}>{status}</span>)}</div></td><td>{row.views}</td><td>{row.pdfDownloads}</td><td>{row.requestsSent}</td><td>{formatDate(row.lastActivityAt)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function PriceProblemsTable({ prices, managerId, routerPush }: { prices: ProblemPrice[]; managerId: number; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}>
        <h3>Проблемные прайсы</h3>
        <span>{prices.length ? `${prices.length} требуют внимания` : 'Нет проблем'}</span>
      </div>
      {prices.length === 0 ? <EmptyState>Проблемных прайсов нет</EmptyState> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Проблемы</th><th>Создан</th><th>Изменён</th><th>Срок</th><th>Просмотры</th><th>PDF</th><th>Действие</th></tr></thead>
            <tbody>
              {prices.map((price) => (
                <tr key={price.id}>
                  <td>{price.title}</td>
                  <td>{price.clientName || '—'}</td>
                  <td><div className={styles.analyticsBadgesRow}>{price.problems.map((problem) => <span className={problemClass(problem)} key={problem}>{problemLabels[problem]}</span>)}</div></td>
                  <td>{formatDate(price.createdAt)}</td>
                  <td>{formatDate(price.updatedAt)}</td>
                  <td>{formatDateOnly(price.validUntil)}</td>
                  <td>{price.views ?? 0}</td>
                  <td>{price.pdfDownloads ?? 0}</td>
                  <td><button type="button" onClick={() => routerPush(`/admin/wholesale/${price.id}/edit?analyticsManagerId=${managerId}`)}>Редактировать</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function SimplePriceTable({ title, rows, empty, managerId, routerPush }: { title: string; rows: ProblemPrice[]; empty: string; managerId: number; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>{empty}</EmptyState> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Создан</th><th>Срок</th><th>Просмотры</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.id}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{formatDate(row.createdAt)}</td><td>{formatDateOnly(row.validUntil)}</td><td>{row.views ?? 0}</td><td><button onClick={() => routerPush(`/admin/wholesale/${row.id}/edit?analyticsManagerId=${managerId}`)}>Редактировать</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function TopViewedTable({ title, rows, empty }: { title: string; rows: NonNullable<ManagerAnalytics['priceInsights']>['topViewedPrices']; empty: string }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>{empty}</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Прайс</th><th>Клиент</th><th>Просмотры</th><th>Уникальные</th><th>PDF</th><th>Последний просмотр</th></tr></thead><tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.views}</td><td>{row.uniqueVisitors}</td><td>{row.pdfDownloads}</td><td>{formatDate(row.lastViewAt)}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

export function MostChangedTable({ rows }: { rows: NonNullable<ManagerAnalytics['priceInsights']>['mostChangedPrices'] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Самые изменяемые прайсы</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Изменений пока нет</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Прайс</th><th>Клиент</th><th>Изменений</th><th>Последнее изменение</th><th>Кто изменил</th></tr></thead><tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.changes}</td><td>{formatDate(row.lastChangedAt)}</td><td>{row.lastChangedBy}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

export function ClientsTable({ title, rows, empty, managerId, routerPush }: { title: string; rows: AnalyticsClient[]; empty: string; managerId: number; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>{empty}</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Клиент</th><th>Прайс</th><th>24 часа</th><th>7 дней</th><th>Всего</th><th>PDF</th><th>Последнее действие</th><th>Статус</th><th>Действие</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.clientId}-${row.priceId}`}><td>{row.clientName}</td><td>{row.priceTitle}</td><td>{row.viewsLast24Hours}</td><td>{row.viewsLast7Days}</td><td>{row.views}</td><td>{row.pdfDownloads}</td><td>{formatDate(row.lastActivityAt)}</td><td><span className={row.status === 'Горячий' ? styles.analyticsBadgeDanger : styles.analyticsBadgeWarning}>{row.status}</span></td><td>{row.priceId ? <button onClick={() => routerPush(`/admin/wholesale/${row.priceId}/edit?analyticsManagerId=${managerId}`)}>Редактировать</button> : '—'}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

export function TopViewedPublicTable({ rows }: { rows: ManagerAnalytics['publicViews']['topPrices'] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Топ публичных ссылок</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Публичные ссылки пока не открывали</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Прайс</th><th>Клиент</th><th>Просмотры</th><th>Уникальные</th><th>Последний просмотр</th></tr></thead><tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.views}</td><td>{row.uniqueVisitors ?? 0}</td><td>{formatDate(row.lastViewAt)}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

export function PdfTopTable({ rows }: { rows: NonNullable<ManagerAnalytics['pdf']>['topDownloadedPrices'] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Топ прайсов по PDF</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Скачивания PDF пока не зафиксированы</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Прайс</th><th>Клиент</th><th>PDF</th><th>Уникальные</th><th>Просмотры</th><th>Последний download</th></tr></thead><tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.downloads}</td><td>{row.uniqueDownloaders}</td><td>{row.views}</td><td>{formatDate(row.lastDownloadAt)}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

export function PdfClientsTable({ rows }: { rows: NonNullable<ManagerAnalytics['pdf']>['clientsWithPdfDownloads'] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Клиенты, скачавшие PDF</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Скачивания PDF пока не зафиксированы</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Клиент</th><th>Прайс</th><th>Скачиваний</th><th>Последний download</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.clientId}-${row.priceId}`}><td>{row.clientName}</td><td>{row.priceTitle}</td><td>{row.downloads}</td><td>{formatDate(row.lastDownloadAt)}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

export function EventsTable({ title, events, empty }: { title: string; events: AnalyticsEvent[]; empty: string }) {
  const content = events.length === 0 ? <EmptyState>{empty}</EmptyState> : (
    <div className={styles.tableWrap}>
      <table className={styles.adminTable}>
        <thead><tr><th>Дата</th><th>Источник</th><th>Событие</th><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Referer</th></tr></thead>
        <tbody>
          {events.map((event) => {
            const refererHref = isHttpUrl(event.referer) ? event.referer : undefined;
            return (
              <tr key={event.id}>
                <td>{formatDate(event.createdAt)}</td>
                <td>{event.actorType}</td>
                <td>{eventLabel(event.eventType)}</td>
                <td>{event.priceTitle}</td>
                <td>{event.clientName || '—'}</td>
                <td>{event.managerName || '—'}</td>
                <td>
                  {refererHref ? (
                    <a className={styles.analyticsEventLink} href={refererHref} target="_blank" rel="noreferrer">
                      {event.referer}
                    </a>
                  ) : event.referer || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  if (!title) return content;
  return <article className={styles.analyticsPanel}><div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{events.length}</span></div>{content}</article>;
}
