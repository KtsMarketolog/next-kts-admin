import styles from '@/app/admin/admin.module.scss';

import type { AnalyticsEvent, AttentionPrice, ClientHistory, ManagerRow, PeriodComparison, PriorityClient, Problem, PublicActivityTab, ReactionNeeded, StatusFunnel } from './AdminWholesaleAnalyticsTypes';

export const publicActivityTabs: Array<{ value: PublicActivityTab; label: string }> = [
  { value: 'public', label: 'Публичные ссылки' },
  { value: 'pdf', label: 'PDF' },
  { value: 'excel', label: 'EXCEL' },
];

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

export const EVENT_PAGE_SIZE = 20;

export const actorLabels: Record<string, string> = {
  admin: 'Админ',
  manager: 'Менеджер',
  client: 'Клиент',
  system: 'Система',
  wholesale_admin: 'Админ прайсов',
};

export const eventDetailLabels: Record<string, string> = {
  title: 'Прайс',
  clientName: 'Клиент',
  clientId: 'ID клиента',
  managerName: 'Менеджер',
  productTitle: 'Товар',
  productId: 'ID товара',
  quantity: 'Количество',
  from: 'Было',
  to: 'Стало',
  added: 'Добавлено',
  removed: 'Удалено',
  search: 'Поиск',
  query: 'Запрос',
  category: 'Категория',
  priceGroup: 'Ценовая группа',
  details: 'Детали',
};

export function formatTimes(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'раз' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'раза' : 'раз';
  return `${count} ${word}`;
}

export function eventRepeatKey(event: AnalyticsEvent, group: string) {
  return [
    group,
    event.priceId ?? event.priceTitle ?? '',
    event.clientId || event.clientName || '',
    event.sessionId || '',
    event.referer || '',
  ].join('|');
}

export function aggregateRepeatedEvents(events: AnalyticsEvent[], options: { group: string; label: (count: number) => string }) {
  const groups = new Map<string, { event: AnalyticsEvent; count: number }>();

  for (const event of events) {
    const key = eventRepeatKey(event, options.group);
    const current = groups.get(key);

    if (!current) {
      groups.set(key, { event: { ...event }, count: 1 });
      continue;
    }

    current.count += 1;
  }

  return Array.from(groups.values())
    .map(({ event, count }) => ({
      ...event,
      eventLabelOverride: options.label(count),
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export const problemLabels: Record<Problem, string> = {
  EMPTY: 'Пустой',
  NO_CLIENT: 'Без клиента',
  NO_EXPIRATION: 'Без срока',
  EXPIRED: 'Просрочен',
  EXPIRING_SOON: 'Скоро истекает',
  STALE: 'Не обновлялся',
  NO_VIEWS: 'Без просмотров',
};

export function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDateOnly(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU');
}

export function qualityLabel(score: number) {
  if (score >= 90) return 'Отлично';
  if (score >= 70) return 'Хорошо';
  if (score >= 50) return 'Требует внимания';
  return 'Плохо';
}

export function problemClass(problem: Problem) {
  if (problem === 'EXPIRED' || problem === 'NO_CLIENT') return styles.analyticsBadgeDanger;
  if (problem === 'NO_EXPIRATION' || problem === 'EXPIRING_SOON' || problem === 'NO_VIEWS') return styles.analyticsBadgeWarning;
  return styles.analyticsBadgeOrange;
}

export function managerHref(managerId: number) {
  return `/admin/wholesale/admin/managers/${managerId}`;
}

export function managerAnalyticsHref(managerId: number) {
  return `/admin/wholesale/admin/managers/${managerId}/analytics`;
}

export function priceEditHref(price: { id?: number; priceId?: number; managerId?: number | null }) {
  const id = price.id ?? price.priceId;
  const suffix = price.managerId ? `?analyticsManagerId=${price.managerId}` : '';
  return `/admin/wholesale/${id}/edit${suffix}`;
}

export function KpiCard({ title, value, text, tone }: { title: string; value: string | number; text: string; tone?: string }) {
  return (
    <article className={`${styles.analyticsKpiCard} ${tone ?? styles.analyticsToneBlue}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{text}</p>
    </article>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <p className={styles.mutedText}>{text}</p>;
}

export function Badge({ children, tone }: { children: string; tone?: 'danger' | 'warning' | 'orange' }) {
  const className = tone === 'danger' ? styles.analyticsBadgeDanger : tone === 'warning' ? styles.analyticsBadgeWarning : styles.analyticsBadgeOrange;
  return <span className={className}>{children}</span>;
}

export function formatHours(value: number | null | undefined) {
  return value === null || value === undefined ? 'Нет данных' : `${value} ч`;
}

export function formatChange(value: number | null) {
  if (value === null) return 'новый рост';
  if (value > 0) return `+${value}%`;
  return `${value}%`;
}

export function StatusFunnelPanel({ funnel }: { funnel: StatusFunnel }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}>
        <h3>Воронка по статусам</h3>
        <span>{funnel.biggestDrop ? `Провал: ${funnel.biggestDrop.label}` : 'По всем прайсам'}</span>
      </div>
      <div className={styles.analyticsTopList}>
        {funnel.steps.map((step) => (
          <div className={styles.analyticsTopItem} key={step.key}>
            <span>{step.label}</span>
            <span className={styles.analyticsTopViewedAt}>
              {step.conversionFromTotal}% от всех • {step.conversionFromPrevious}% от прошлого
            </span>
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

export function PeriodComparisonPanel({ rows }: { rows: PeriodComparison[] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}>
        <h3>Сравнение периодов</h3>
        <span>Текущий период против прошлого</span>
      </div>
      {rows.length === 0 ? <EmptyState text="Для всего времени сравнение не считается" /> : (
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

export function AttentionPricesTable({ title, rows, routerPush, empty }: { title: string; rows: AttentionPrice[]; routerPush: (href: string) => void; empty: string }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text={empty} /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Причина</th><th>Статус</th><th>Дней</th><th>Активность клиента</th><th>Просмотры</th><th>PDF</th><th>Заявки</th><th>Действие</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${title}-${row.id}-${row.reason}`}>
                  <td><strong>{row.title}</strong></td>
                  <td>{row.clientName || '—'}</td>
                  <td>{row.managerName || '—'}</td>
                  <td><Badge tone="danger">{row.reason}</Badge></td>
                  <td>{row.workflowStatusLabel}</td>
                  <td>{row.daysInStage}</td>
                  <td>{formatDate(row.lastClientActivityAt)}</td>
                  <td>{row.views}</td>
                  <td>{row.pdfDownloads}</td>
                  <td>{row.requestsSent}</td>
                  <td><button type="button" onClick={() => routerPush(priceEditHref({ priceId: row.id, managerId: row.managerId }))}>Редактировать</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ReactionNeededTable({ rows, routerPush }: { rows: ReactionNeeded[]; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Клиент проявил интерес, реакции нет</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Неотработанных клиентских действий нет" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Прайс</th><th>Менеджер</th><th>Действие клиента</th><th>Без реакции</th><th>Статус</th><th>Последнее действие менеджера</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.priceId}-${row.lastClientActivityAt}`}><td>{row.clientName || '—'}</td><td>{row.priceTitle}</td><td>{row.managerName || '—'}</td><td>{eventLabels[row.lastClientEventType] ?? row.lastClientEventType}<br /><span>{formatDate(row.lastClientActivityAt)}</span></td><td>{formatHours(row.hoursWithoutReaction)}</td><td>{row.workflowStatusLabel}</td><td>{formatDate(row.lastManagerActivityAt)}</td><td><button type="button" onClick={() => routerPush(priceEditHref({ priceId: row.priceId, managerId: row.managerId }))}>Открыть</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function PriorityClientsTable({ rows, routerPush }: { rows: PriorityClient[]; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Клиенты, с которыми связаться сегодня</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Приоритетных клиентов пока нет" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Прайс</th><th>Менеджер</th><th>Приоритет</th><th>Причины</th><th>24 часа</th><th>7 дней</th><th>PDF</th><th>Заявки</th><th>Последняя активность</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.clientId}-${row.priceId}`}><td>{row.clientName}</td><td>{row.priceTitle}</td><td>{row.managerName || '—'}</td><td><strong>{row.score}</strong></td><td><div className={styles.analyticsBadgesRow}>{row.reasons.map((reason) => <Badge key={reason} tone="orange">{reason}</Badge>)}</div></td><td>{row.viewsLast24Hours}</td><td>{row.viewsLast7Days}</td><td>{row.pdfDownloads}</td><td>{row.requestsSent}</td><td>{formatDate(row.lastActivityAt)}</td><td><button type="button" onClick={() => routerPush(priceEditHref({ priceId: row.priceId, managerId: row.managerId }))}>Открыть</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ClientHistoryTable({ rows, routerPush }: { rows: ClientHistory[]; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>История клиентов</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="История клиентов пока пустая" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Менеджер</th><th>Прайсов</th><th>Активных</th><th>Актуальных</th><th>Просроченных</th><th>Статусы</th><th>Просмотры</th><th>PDF</th><th>Заявки</th><th>Последняя активность</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.clientId}><td>{row.clientName}</td><td>{row.managerName || '—'}</td><td>{row.priceCount}</td><td>{row.activePrices}</td><td>{row.activeActualPrices}</td><td>{row.expiredPrices}</td><td><div className={styles.analyticsBadgesRow}>{row.statuses.map((status) => <Badge key={status} tone={row.hasActiveActualPrice ? 'orange' : 'warning'}>{status}</Badge>)}</div></td><td>{row.views}</td><td>{row.pdfDownloads}</td><td>{row.requestsSent}</td><td>{formatDate(row.lastActivityAt)}</td><td>{row.managerId ? <button type="button" onClick={() => routerPush(managerAnalyticsHref(row.managerId!))}>Аналитика</button> : '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ManagerFunnelQualityTable({ rows, routerPush }: { rows: ManagerRow[]; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Качество воронки менеджеров</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Нет данных" /> : null}
      <div className={styles.analyticsManagerFunnelList}>
        {rows.map((manager) => {
          const metrics = [
            { label: 'Просмотров / активный', value: manager.viewsPerActivePrice ?? 0 },
            { label: 'PDF / активный', value: manager.pdfPerActivePrice ?? 0 },
            { label: 'Заявок / активный', value: manager.requestsPerActivePrice ?? 0 },
            { label: 'Отправлен → открыт', value: `${manager.sentToOpenedConversion ?? 0}%` },
            { label: 'Открыт → PDF', value: `${manager.openedToPdfConversion ?? 0}%` },
            { label: 'Открыт → заявка', value: `${manager.openedToRequestConversion ?? 0}%` },
            { label: 'Застряли', value: `${manager.stuckPriceRate ?? 0}%` },
            { label: 'Подтверждены', value: `${manager.confirmedPriceRate ?? 0}%` },
            { label: 'Средняя реакция', value: formatHours(manager.averageReactionHours) },
          ];

          return (
            <div className={styles.analyticsManagerFunnelCard} key={manager.id}>
              <div className={styles.analyticsManagerFunnelTop}>
                <strong>{manager.name}</strong>
                <button type="button" onClick={() => routerPush(managerAnalyticsHref(manager.id))}>Аналитика</button>
              </div>
              <div className={styles.analyticsManagerFunnelStats}>
                {metrics.map((metric) => (
                  <div key={metric.label}>
                    <span>{metric.label}</span>
                    <strong>{metric.value}</strong>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}
