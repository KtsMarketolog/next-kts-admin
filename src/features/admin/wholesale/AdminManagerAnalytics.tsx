'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';

type Period = '7d' | '30d' | 'all';
type Tab = 'overview' | 'prices' | 'clients' | 'links' | 'pdf' | 'events';
type Problem = 'EMPTY' | 'NO_CLIENT' | 'NO_EXPIRATION' | 'EXPIRED' | 'EXPIRING_SOON' | 'STALE' | 'NO_VIEWS';

type AnalyticsEvent = {
  id: number;
  eventType: string;
  actorType: string;
  priceId: number | null;
  priceTitle: string;
  clientId: string;
  clientName: string;
  managerName: string;
  createdAt: string;
  details: string;
  sessionId: string;
  referer: string;
};

type AnalyticsChange = {
  id: number;
  priceId: number | null;
  priceTitle: string;
  action: string;
  changedBy: string;
  createdAt: string;
  details: string;
};

type ProblemPrice = {
  id: number;
  title: string;
  clientName: string;
  createdAt: string;
  updatedAt?: string;
  validUntil: string | null;
  views?: number;
  pdfDownloads?: number;
  problems: Problem[];
};

type AnalyticsClient = {
  clientId: string;
  clientName: string;
  priceId: number | null;
  priceTitle: string;
  priceCount: number;
  viewsLast24Hours: number;
  viewsLast7Days: number;
  views: number;
  uniqueVisitors: number;
  pdfDownloads: number;
  lastActivityAt: string | null;
  lastPriceCreatedAt: string | null;
  status: string;
};

type StatusFunnelStep = {
  key: string;
  label: string;
  count: number;
  dropFromPrevious: number;
  conversionFromPrevious: number;
  conversionFromTotal: number;
};

type StatusFunnel = {
  steps: StatusFunnelStep[];
  biggestDrop: StatusFunnelStep | null;
  averageTimeToOpenHours: number | null;
  averageTimeToPdfHours: number | null;
  averageTimeToRequestHours: number | null;
};

type AttentionPrice = {
  id: number;
  title: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  workflowStatus: string;
  workflowStatusLabel: string;
  reason: string;
  daysInStage: number;
  views: number;
  pdfDownloads: number;
  requestsSent: number;
  lastClientActivityAt: string | null;
  lastManagerActivityAt: string | null;
};

type ReactionNeeded = {
  priceId: number;
  priceTitle: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  lastClientEventType: string;
  lastClientActivityAt: string;
  lastManagerActivityAt: string | null;
  hoursWithoutReaction: number;
  workflowStatus: string;
  workflowStatusLabel: string;
};

type PriorityClient = {
  clientId: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  priceId: number;
  priceTitle: string;
  score: number;
  reasons: string[];
  viewsLast24Hours: number;
  viewsLast7Days: number;
  repeatViews: number;
  pdfDownloads: number;
  requestsSent: number;
  lastActivityAt: string | null;
  workflowStatus: string;
  workflowStatusLabel: string;
};

type ClientHistory = {
  clientId: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  priceCount: number;
  activePrices: number;
  activeActualPrices: number;
  expiredPrices: number;
  statuses: string[];
  views: number;
  pdfDownloads: number;
  requestsSent: number;
  lastPriceCreatedAt: string | null;
  lastViewAt: string | null;
  lastActivityAt: string | null;
  hasActiveActualPrice: boolean;
};

type ProductInterest = {
  productId: string | null;
  productTitle: string;
  opens: number;
  quantityChanges: number;
  requests: number;
  lastActivityAt: string | null;
};

type PeriodComparison = {
  label: string;
  current: number;
  previous: number;
  changePercent: number | null;
};

type ManagerAnalytics = {
  manager: {
    id: number;
    name: string;
    login: string;
    email: string;
    phone: string;
    role: string;
    lastLoginAt: string | null;
  };
  summary: {
    totalPrices: number;
    activePrices: number;
    expiredPrices: number;
    expiringSoon7Days?: number;
    expiringSoon30Days?: number;
    pricesLast7Days: number;
    pricesLast30Days: number;
    periodPrices: number;
    averageItemsPerPrice: number;
    medianItemsPerPrice?: number;
    emptyPrices: number;
    pricesWithoutClient: number;
    pricesWithoutExpiration: number;
    stalePrices30Days?: number;
    pricesWithoutViews?: number;
    qualityScore?: number;
    disabledPrices?: number;
    pricesWithoutPdfDownloads?: number;
  };
  managerActivity?: {
    loginsLast7Days: number;
    loginsLast30Days: number;
    loginsInSelectedPeriod: number;
    activeDaysInSelectedPeriod: number;
    actionsLast7Days: number;
    actionsLast30Days: number;
    actionsInSelectedPeriod: number;
    lastAction: { eventType: string; priceTitle: string; clientName: string; createdAt: string } | null;
    createdPrices: number;
    updatedPrices: number;
    activatedPrices: number;
    deactivatedPrices: number;
    deletedPrices: number;
  };
  lastCreatedPrice: { id: number; title: string; createdAt: string } | null;
  lastChange: AnalyticsChange | null;
  problemPrices: ProblemPrice[];
  recentChanges: AnalyticsChange[];
  publicViews: {
    total: number;
    uniqueVisitors?: number;
    last7Days: number;
    last30Days: number;
    periodViews: number;
    repeatViews?: number;
    lastViewAt: string | null;
    pricesWithoutViews?: number;
    averageViewsPerPrice?: number;
    topPrices: Array<{
      priceId: number;
      title: string;
      clientName?: string;
      views: number;
      uniqueVisitors?: number;
      lastViewAt: string | null;
    }>;
    recentViews?: AnalyticsEvent[];
    pricesWithoutViewsList?: ProblemPrice[];
  };
  pdf?: {
    totalDownloads: number;
    downloadsLast7Days: number;
    downloadsLast30Days: number;
    downloadsInSelectedPeriod: number;
    uniqueDownloaders: number;
    lastDownloadAt: string | null;
    pricesWithDownloads: number;
    pricesWithoutDownloads: number;
    topDownloadedPrices: Array<{
      priceId: number;
      title: string;
      clientName: string;
      downloads: number;
      uniqueDownloaders: number;
      views: number;
      lastDownloadAt: string | null;
    }>;
    recentDownloads: AnalyticsEvent[];
    clientsWithPdfDownloads: Array<{
      clientId: string;
      clientName: string;
      priceId: number;
      priceTitle: string;
      downloads: number;
      lastDownloadAt: string | null;
    }>;
  };
  clients?: {
    totalClients: number;
    clientsWithPrices: number;
    clientsWithViews: number;
    clientsWithoutViews: number;
    clientsWithPdfDownloads: number;
    hotClients: AnalyticsClient[];
    topClientsByViews: AnalyticsClient[];
    clientsWithoutRecentActivity: AnalyticsClient[];
  };
  funnel?: {
    createdPrices: number;
    activePublicLinks: number;
    openedPrices: number;
    pricesWithRepeatViews: number;
    pdfDownloadedPrices: number;
    requestsSent?: number;
    contactClicks: number;
  };
  priceInsights?: {
    expiringSoon: ProblemPrice[];
    pricesWithoutViews: ProblemPrice[];
    topViewedPrices: Array<{
      priceId: number;
      title: string;
      clientName: string;
      views: number;
      uniqueVisitors: number;
      pdfDownloads: number;
      lastViewAt: string | null;
    }>;
    mostChangedPrices: Array<{
      priceId: number;
      title: string;
      clientName: string;
      changes: number;
      lastChangedAt: string | null;
      lastChangedBy: string;
    }>;
    largestPrice: { id: number; title: string; itemCount: number } | null;
    smallestNonEmptyPrice: { id: number; title: string; itemCount: number } | null;
  };
  attention?: {
    statusFunnel: StatusFunnel;
    stuckPrices: AttentionPrice[];
    managerReactionNeeded: ReactionNeeded[];
    priorityClients: PriorityClient[];
    clientHistory: ClientHistory[];
    productInterest: ProductInterest[];
    comparison: PeriodComparison[];
  };
  recentEvents?: AnalyticsEvent[];
};

type AdminManagerAnalyticsProps = {
  managerId: number;
};

const periods: Array<{ value: Period; label: string }> = [
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: 'all', label: 'Всё время' },
];

const tabs: Array<{ value: Tab; label: string }> = [
  { value: 'overview', label: 'Обзор' },
  { value: 'prices', label: 'Прайсы' },
  { value: 'clients', label: 'Клиенты' },
  { value: 'links', label: 'Публичные ссылки' },
  { value: 'pdf', label: 'PDF' },
  { value: 'events', label: 'Журнал событий' },
];

const problemLabels: Record<Problem, string> = {
  EMPTY: 'Пустой',
  NO_CLIENT: 'Без клиента',
  NO_EXPIRATION: 'Без срока',
  EXPIRED: 'Просрочен',
  EXPIRING_SOON: 'Скоро истекает',
  STALE: 'Не обновлялся',
  NO_VIEWS: 'Без просмотров',
};

const eventLabels: Record<string, string> = {
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

function formatDate(value: string | null | undefined) {
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

function eventLabel(value: string) {
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

function qualityLabel(score: number) {
  if (score >= 90) return 'Отлично';
  if (score >= 70) return 'Хорошо';
  if (score >= 50) return 'Требует внимания';
  return 'Плохо';
}

function KpiCard({ title, value, text, tone }: { title: string; value: number | string; text: string; tone?: string }) {
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

function ManagerStatusFunnelPanel({ funnel }: { funnel: StatusFunnel }) {
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

function ManagerPeriodComparisonPanel({ rows }: { rows: PeriodComparison[] }) {
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

function ManagerAttentionPricesTable({ rows, managerId, routerPush }: { rows: AttentionPrice[]; managerId: number; routerPush: (href: string) => void }) {
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

function ManagerReactionNeededTable({ rows, managerId, routerPush }: { rows: ReactionNeeded[]; managerId: number; routerPush: (href: string) => void }) {
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

function ManagerPriorityClientsTable({ rows, managerId, routerPush }: { rows: PriorityClient[]; managerId: number; routerPush: (href: string) => void }) {
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

function ManagerClientHistoryTable({ rows }: { rows: ClientHistory[] }) {
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

function ManagerProductInterestTable({ rows }: { rows: ProductInterest[] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Товарный интерес</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Интерес к товарам пока не зафиксирован</EmptyState> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Товар</th><th>Открывали</th><th>Меняли количество</th><th>В заявках</th><th>Последняя активность</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.productId ?? row.productTitle}><td>{row.productTitle}</td><td>{row.opens}</td><td>{row.quantityChanges}</td><td>{row.requests}</td><td>{formatDate(row.lastActivityAt)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function AdminManagerAnalytics({ managerId }: AdminManagerAnalyticsProps) {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>('30d');
  const [tab, setTab] = useState<Tab>('overview');
  const [analytics, setAnalytics] = useState<ManagerAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');

    fetch(`/api/admin/wholesale/managers/${managerId}/analytics?period=${period}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Не удалось загрузить аналитику');
        return (await res.json()) as ManagerAnalytics;
      })
      .then((data) => {
        if (active) setAnalytics(data);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить аналитику');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [managerId, period]);

  const filteredEvents = useMemo(() => {
    const events = analytics?.recentEvents ?? [];
    return events.filter((event) => {
      if (eventTypeFilter && event.eventType !== eventTypeFilter) return false;
      if (actorFilter && event.actorType !== actorFilter) return false;
      return true;
    });
  }, [actorFilter, analytics?.recentEvents, eventTypeFilter]);

  if (loading && !analytics) {
    return (
      <section className={styles.section}>
        <p className={styles.mutedText}>Загружаем аналитику менеджера...</p>
      </section>
    );
  }

  if (error && !analytics) {
    return (
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <p>Индивидуальные прайсы</p>
            <h2>Аналитика менеджера</h2>
          </div>
          <button className={styles.secondary} onClick={() => router.push('/admin/wholesale/admin')}>
            Вернуться к менеджерам
          </button>
        </div>
        <p className={styles.mutedText}>{error}</p>
      </section>
    );
  }

  if (!analytics) return null;

  const activity = analytics.managerActivity;
  const pdf = analytics.pdf;
  const clients = analytics.clients;
  const funnel = analytics.funnel;
  const priceInsights = analytics.priceInsights;
  const attention = analytics.attention;
  const qualityScore = analytics.summary.qualityScore ?? 0;

  return (
    <section className={`${styles.section} ${styles.analyticsSection}`}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Индивидуальные прайсы</p>
          <h2>Аналитика менеджера</h2>
          <div className={styles.analyticsManagerMeta}>
            <span>{analytics.manager.name}</span>
            {analytics.manager.email ? <span>{analytics.manager.email}</span> : null}
            {analytics.manager.phone ? <span>{analytics.manager.phone}</span> : null}
            <span>{analytics.manager.role}</span>
            <span>Последний вход: {formatDate(analytics.manager.lastLoginAt)}</span>
          </div>
        </div>
        <div className={styles.topbarActions}>
          <button className={styles.secondary} type="button" onClick={() => router.push(`/admin/wholesale/admin/managers/${managerId}`)}>
            Прайсы менеджера
          </button>
          <button className={styles.secondary} type="button" onClick={() => router.push('/admin/wholesale/admin')}>
            Вернуться к менеджерам
          </button>
        </div>
      </div>

      <div className={styles.analyticsToolbar}>
        <span>Период</span>
        <div className={styles.analyticsPeriod}>
          {periods.map((item) => (
            <button
              key={item.value}
              className={period === item.value ? styles.analyticsPeriodActive : styles.secondary}
              type="button"
              onClick={() => setPeriod(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.analyticsTabs}>
        {tabs.map((item) => (
          <button
            key={item.value}
            className={tab === item.value ? styles.analyticsTabActive : styles.analyticsTab}
            type="button"
            onClick={() => setTab(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <>
          <div className={styles.analyticsKpiGrid}>
            <KpiCard title="Всего прайсов" value={analytics.summary.totalPrices} text="Все прайсы менеджера" tone={styles.analyticsToneBlue} />
            <KpiCard title="Активные" value={analytics.summary.activePrices} text="Доступны по публичной ссылке" tone={styles.analyticsToneGreen} />
            <KpiCard title="Проблемные" value={analytics.problemPrices.length} text="Требуют внимания" tone={styles.analyticsToneRed} />
            <KpiCard title="Качество" value={`${qualityScore}`} text={qualityLabel(qualityScore)} tone={styles.analyticsToneViolet} />
            <KpiCard title="Просмотры" value={analytics.publicViews.total} text="Открытия публичных ссылок" tone={styles.analyticsToneBlue} />
            <KpiCard title="Уникальные" value={analytics.publicViews.uniqueVisitors ?? 0} text="Уникальные посетители" tone={styles.analyticsToneGreen} />
            <KpiCard title="PDF" value={pdf?.totalDownloads ?? 0} text="Скачивания прайсов" tone={styles.analyticsToneViolet} />
            <KpiCard title="Клиенты" value={clients?.clientsWithViews ?? 0} text="Клиенты с активностью" tone={styles.analyticsToneGreen} />
          </div>

          {attention ? (
            <>
              <div className={styles.analyticsKpiGrid}>
                <KpiCard title="Требуют внимания" value={attention.stuckPrices.length} text="Прайсы застряли по статусу" tone={styles.analyticsToneRed} />
                <KpiCard title="Нет реакции" value={attention.managerReactionNeeded.length} text="Клиент активен, менеджер не ответил действием" tone={styles.analyticsToneRed} />
                <KpiCard title="Приоритетные клиенты" value={attention.priorityClients.length} text="С кем связаться сегодня" tone={styles.analyticsToneGreen} />
                <KpiCard title="Главный провал" value={attention.statusFunnel.biggestDrop?.dropFromPrevious ?? 0} text={attention.statusFunnel.biggestDrop?.label ?? 'Нет данных'} tone={styles.analyticsToneViolet} />
              </div>
              <div className={styles.analyticsSplit}>
                <ManagerStatusFunnelPanel funnel={attention.statusFunnel} />
                <ManagerPeriodComparisonPanel rows={attention.comparison} />
              </div>
              <ManagerAttentionPricesTable rows={attention.stuckPrices.slice(0, 10)} managerId={managerId} routerPush={router.push} />
              <ManagerReactionNeededTable rows={attention.managerReactionNeeded.slice(0, 10)} managerId={managerId} routerPush={router.push} />
              <ManagerPriorityClientsTable rows={attention.priorityClients.slice(0, 10)} managerId={managerId} routerPush={router.push} />
            </>
          ) : null}

          <div className={styles.analyticsSplit}>
            <article className={styles.analyticsPanel}>
              <div className={styles.analyticsPanelHeader}>
                <h3>Активность менеджера</h3>
                <span>{loading ? 'Обновляем...' : 'Актуальные данные'}</span>
              </div>
              <dl className={styles.analyticsList}>
                <div><dt>Входов за период</dt><dd>{activity?.loginsInSelectedPeriod ?? 0}</dd></div>
                <div><dt>Активных дней</dt><dd>{activity?.activeDaysInSelectedPeriod ?? 0}</dd></div>
                <div><dt>Действий за 7 дней</dt><dd>{activity?.actionsLast7Days ?? 0}</dd></div>
                <div><dt>Действий за 30 дней</dt><dd>{activity?.actionsLast30Days ?? 0}</dd></div>
                <div><dt>Создано / изменено</dt><dd>{activity?.createdPrices ?? 0} / {activity?.updatedPrices ?? 0}</dd></div>
                <div><dt>Последнее действие</dt><dd>{activity?.lastAction ? `${eventLabel(activity.lastAction.eventType)} · ${activity.lastAction.priceTitle} · ${formatDate(activity.lastAction.createdAt)}` : 'Нет данных'}</dd></div>
              </dl>
            </article>

            <article className={styles.analyticsPanel}>
              <div className={styles.analyticsPanelHeader}>
                <h3>Воронка</h3>
                <span>От создания до реакции клиента</span>
              </div>
              <div className={styles.analyticsTopList}>
                {[
                  ['Создано прайсов', funnel?.createdPrices ?? 0],
                  ['Активных публичных ссылок', funnel?.activePublicLinks ?? 0],
                  ['Прайсов открывали', funnel?.openedPrices ?? 0],
                  ['С повторными просмотрами', funnel?.pricesWithRepeatViews ?? 0],
                  ['Скачивали PDF', funnel?.pdfDownloadedPrices ?? 0],
                  ['Отправили заявку', funnel?.requestsSent ?? 0],
                  ['Клики по контактам', funnel?.contactClicks ?? 0],
                ].map(([label, value]) => (
                  <div className={styles.analyticsTopItem} key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </>
      ) : null}

      {tab === 'prices' ? (
        <>
          <div className={styles.analyticsKpiGrid}>
            <KpiCard title="Отключённые" value={analytics.summary.disabledPrices ?? 0} text="Сейчас скрыты" />
            <KpiCard title="Скоро истекают 7д" value={analytics.summary.expiringSoon7Days ?? 0} text="Нужно обновить сроки" tone={styles.analyticsToneRed} />
            <KpiCard title="Без просмотров" value={analytics.summary.pricesWithoutViews ?? 0} text="Клиенты не открывали" tone={styles.analyticsToneViolet} />
            <KpiCard title="Среднее позиций" value={analytics.summary.averageItemsPerPrice} text={`Медиана: ${analytics.summary.medianItemsPerPrice ?? 0}`} />
          </div>
          <PriceProblemsTable prices={analytics.problemPrices} managerId={managerId} routerPush={router.push} />
          {attention ? <ManagerAttentionPricesTable rows={attention.stuckPrices} managerId={managerId} routerPush={router.push} /> : null}
          <SimplePriceTable title="Скоро истекают" rows={priceInsights?.expiringSoon ?? []} empty="Прайсов с ближайшим окончанием срока нет" managerId={managerId} routerPush={router.push} />
          <SimplePriceTable title="Прайсы без просмотров" rows={priceInsights?.pricesWithoutViews ?? []} empty="Прайсов без просмотров нет" managerId={managerId} routerPush={router.push} />
          <TopViewedTable title="Самые просматриваемые прайсы" rows={priceInsights?.topViewedPrices ?? []} empty="Просмотров публичных ссылок пока нет" />
          <MostChangedTable rows={priceInsights?.mostChangedPrices ?? []} />
        </>
      ) : null}

      {tab === 'clients' ? (
        <>
          <div className={styles.analyticsKpiGrid}>
            <KpiCard title="Всего клиентов" value={clients?.totalClients ?? 0} text="Клиенты в прайсах менеджера" />
            <KpiCard title="Открывали" value={clients?.clientsWithViews ?? 0} text="Есть просмотры ссылок" tone={styles.analyticsToneGreen} />
            <KpiCard title="Не открывали" value={clients?.clientsWithoutViews ?? 0} text="Нет клиентской активности" tone={styles.analyticsToneRed} />
            <KpiCard title="Скачали PDF" value={clients?.clientsWithPdfDownloads ?? 0} text="Есть PDF-download" tone={styles.analyticsToneViolet} />
          </div>
          <ClientsTable title="Горячие клиенты" rows={clients?.hotClients ?? []} empty="Горячих клиентов пока нет" managerId={managerId} routerPush={router.push} />
          {attention ? <ManagerPriorityClientsTable rows={attention.priorityClients} managerId={managerId} routerPush={router.push} /> : null}
          {attention ? <ManagerClientHistoryTable rows={attention.clientHistory} /> : null}
          <ClientsTable title="Клиенты без просмотров" rows={clients?.clientsWithoutRecentActivity ?? []} empty="Клиентов без просмотров нет" managerId={managerId} routerPush={router.push} />
          <ClientsTable title="Топ клиентов по просмотрам" rows={clients?.topClientsByViews ?? []} empty="Просмотров клиентов пока нет" managerId={managerId} routerPush={router.push} />
        </>
      ) : null}

      {tab === 'links' ? (
        <>
          <div className={styles.analyticsKpiGrid}>
            <KpiCard title="Всего открытий" value={analytics.publicViews.total} text="Публичные /price/[token]" />
            <KpiCard title="Уникальные" value={analytics.publicViews.uniqueVisitors ?? 0} text="По sessionId" tone={styles.analyticsToneGreen} />
            <KpiCard title="Повторные" value={analytics.publicViews.repeatViews ?? 0} text="Вернулись к прайсу" tone={styles.analyticsToneViolet} />
            <KpiCard title="За период" value={analytics.publicViews.periodViews} text={`Последний: ${formatDate(analytics.publicViews.lastViewAt)}`} />
          </div>
          <TopViewedPublicTable rows={analytics.publicViews.topPrices} />
          {attention ? <ManagerProductInterestTable rows={attention.productInterest} /> : null}
          <EventsTable title="Последние просмотры" events={analytics.publicViews.recentViews ?? []} empty="Просмотров публичных ссылок пока нет" />
          <SimplePriceTable title="Прайсы без просмотров" rows={analytics.publicViews.pricesWithoutViewsList ?? []} empty="Прайсов без просмотров нет" managerId={managerId} routerPush={router.push} />
        </>
      ) : null}

      {tab === 'pdf' ? (
        <>
          <div className={styles.analyticsKpiGrid}>
            <KpiCard title="Всего PDF" value={pdf?.totalDownloads ?? 0} text="Скачивания прайсов" />
            <KpiCard title="За 7 дней" value={pdf?.downloadsLast7Days ?? 0} text="Недавние скачивания" tone={styles.analyticsToneGreen} />
            <KpiCard title="За период" value={pdf?.downloadsInSelectedPeriod ?? 0} text={`Последний: ${formatDate(pdf?.lastDownloadAt)}`} tone={styles.analyticsToneViolet} />
            <KpiCard title="Без PDF" value={pdf?.pricesWithoutDownloads ?? 0} text="Прайсы не скачивали" tone={styles.analyticsToneRed} />
          </div>
          <PdfTopTable rows={pdf?.topDownloadedPrices ?? []} />
          <EventsTable title="Последние скачивания PDF" events={pdf?.recentDownloads ?? []} empty="Скачивания PDF пока не зафиксированы" />
          <PdfClientsTable rows={pdf?.clientsWithPdfDownloads ?? []} />
        </>
      ) : null}

      {tab === 'events' ? (
        <article className={styles.analyticsPanel}>
          <div className={styles.analyticsPanelHeader}>
            <h3>Журнал событий</h3>
            <span>Последние 50 событий</span>
          </div>
          <div className={styles.analyticsFilters}>
            <select value={eventTypeFilter} onChange={(event) => setEventTypeFilter(event.target.value)}>
              <option value="">Все события</option>
              {Object.entries(eventLabels).map(([value, label]) => (
                <option value={value} key={value}>{label}</option>
              ))}
            </select>
            <select value={actorFilter} onChange={(event) => setActorFilter(event.target.value)}>
              <option value="">Все источники</option>
              <option value="manager">Менеджер</option>
              <option value="admin">Админ</option>
              <option value="client">Клиент</option>
              <option value="system">Система</option>
            </select>
          </div>
          <EventsTable title="" events={filteredEvents} empty="За выбранный период событий нет" />
        </article>
      ) : null}
    </section>
  );
}

function PriceProblemsTable({ prices, managerId, routerPush }: { prices: ProblemPrice[]; managerId: number; routerPush: (href: string) => void }) {
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

function SimplePriceTable({ title, rows, empty, managerId, routerPush }: { title: string; rows: ProblemPrice[]; empty: string; managerId: number; routerPush: (href: string) => void }) {
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

function TopViewedTable({ title, rows, empty }: { title: string; rows: NonNullable<ManagerAnalytics['priceInsights']>['topViewedPrices']; empty: string }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>{empty}</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Прайс</th><th>Клиент</th><th>Просмотры</th><th>Уникальные</th><th>PDF</th><th>Последний просмотр</th></tr></thead><tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.views}</td><td>{row.uniqueVisitors}</td><td>{row.pdfDownloads}</td><td>{formatDate(row.lastViewAt)}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

function MostChangedTable({ rows }: { rows: NonNullable<ManagerAnalytics['priceInsights']>['mostChangedPrices'] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Самые изменяемые прайсы</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Изменений пока нет</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Прайс</th><th>Клиент</th><th>Изменений</th><th>Последнее изменение</th><th>Кто изменил</th></tr></thead><tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.changes}</td><td>{formatDate(row.lastChangedAt)}</td><td>{row.lastChangedBy}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

function ClientsTable({ title, rows, empty, managerId, routerPush }: { title: string; rows: AnalyticsClient[]; empty: string; managerId: number; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>{empty}</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Клиент</th><th>Прайс</th><th>24 часа</th><th>7 дней</th><th>Всего</th><th>PDF</th><th>Последнее действие</th><th>Статус</th><th>Действие</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.clientId}-${row.priceId}`}><td>{row.clientName}</td><td>{row.priceTitle}</td><td>{row.viewsLast24Hours}</td><td>{row.viewsLast7Days}</td><td>{row.views}</td><td>{row.pdfDownloads}</td><td>{formatDate(row.lastActivityAt)}</td><td><span className={row.status === 'Горячий' ? styles.analyticsBadgeDanger : styles.analyticsBadgeWarning}>{row.status}</span></td><td>{row.priceId ? <button onClick={() => routerPush(`/admin/wholesale/${row.priceId}/edit?analyticsManagerId=${managerId}`)}>Редактировать</button> : '—'}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

function TopViewedPublicTable({ rows }: { rows: ManagerAnalytics['publicViews']['topPrices'] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Топ публичных ссылок</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Публичные ссылки пока не открывали</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Прайс</th><th>Клиент</th><th>Просмотры</th><th>Уникальные</th><th>Последний просмотр</th></tr></thead><tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.views}</td><td>{row.uniqueVisitors ?? 0}</td><td>{formatDate(row.lastViewAt)}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

function PdfTopTable({ rows }: { rows: NonNullable<ManagerAnalytics['pdf']>['topDownloadedPrices'] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Топ прайсов по PDF</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Скачивания PDF пока не зафиксированы</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Прайс</th><th>Клиент</th><th>PDF</th><th>Уникальные</th><th>Просмотры</th><th>Последний download</th></tr></thead><tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.downloads}</td><td>{row.uniqueDownloaders}</td><td>{row.views}</td><td>{formatDate(row.lastDownloadAt)}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

function PdfClientsTable({ rows }: { rows: NonNullable<ManagerAnalytics['pdf']>['clientsWithPdfDownloads'] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Клиенты, скачавшие PDF</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState>Скачивания PDF пока не зафиксированы</EmptyState> : (
        <div className={styles.tableWrap}><table className={styles.adminTable}><thead><tr><th>Клиент</th><th>Прайс</th><th>Скачиваний</th><th>Последний download</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.clientId}-${row.priceId}`}><td>{row.clientName}</td><td>{row.priceTitle}</td><td>{row.downloads}</td><td>{formatDate(row.lastDownloadAt)}</td></tr>)}</tbody></table></div>
      )}
    </article>
  );
}

function EventsTable({ title, events, empty }: { title: string; events: AnalyticsEvent[]; empty: string }) {
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
