'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';

import {
  ClientsTable,
  EventsTable,
  KpiCard,
  ManagerAttentionPricesTable,
  ManagerClientHistoryTable,
  ManagerPeriodComparisonPanel,
  ManagerPriorityClientsTable,
  ManagerReactionNeededTable,
  ManagerStatusFunnelPanel,
  MostChangedTable,
  PdfClientsTable,
  PdfTopTable,
  PriceProblemsTable,
  SimplePriceTable,
  TopViewedPublicTable,
  TopViewedTable,
  eventLabel,
  eventLabels,
  formatDate,
  qualityLabel,
} from './AdminManagerAnalyticsParts';

import type {
  AdminManagerAnalyticsProps,
  ManagerAnalytics,
  Period,
  Tab,
} from './AdminManagerAnalyticsTypes';
export type {
  AdminManagerAnalyticsProps,
  AnalyticsChange,
  AnalyticsClient,
  AnalyticsEvent,
  AttentionPrice,
  ClientHistory,
  ManagerAnalytics,
  Period,
  PeriodComparison,
  PriorityClient,
  Problem,
  ProblemPrice,
  ReactionNeeded,
  StatusFunnel,
  StatusFunnelStep,
  Tab,
} from './AdminManagerAnalyticsTypes';

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
