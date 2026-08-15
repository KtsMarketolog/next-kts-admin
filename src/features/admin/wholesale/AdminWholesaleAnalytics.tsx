'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';
import {
  ClientsTab,
  EmptyState,
  EventsTab,
  ManagerRatingsTab,
  OverviewTab,
  PricesTab,
  PublicActivitySection,
  publicActivityTabs,
} from './AdminWholesaleAnalyticsParts';

import type {
  AdminWholesaleAnalyticsTab,
  Analytics,
  ExportFormat,
  Period,
  PublicActivityTab,
  Tab,
} from './AdminWholesaleAnalyticsTypes';
export type {
  AdminWholesaleAnalyticsTab,
  Analytics,
  AnalyticsEvent,
  AttentionPrice,
  ClientHistory,
  ClientRow,
  ExportFormat,
  ManagerRow,
  Period,
  PeriodComparison,
  PriorityClient,
  Problem,
  ProblemPrice,
  PublicActivityTab,
  ReactionNeeded,
  StatusFunnel,
  StatusFunnelStep,
  Tab,
} from './AdminWholesaleAnalyticsTypes';

const periods: Array<{ value: Period; label: string }> = [
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: 'all', label: 'Всё время' },
];

const tabs: Array<{ value: Tab; label: string; description: string }> = [
  { value: 'overview', label: 'Обзор', description: 'Главные KPI, воронка и риски' },
  { value: 'managers', label: 'Менеджеры', description: 'Добавление, управление и статистика' },
  { value: 'managerRatings', label: 'Рейтинг менеджеров', description: 'Рейтинг и качество воронки' },
  { value: 'prices', label: 'Статистика прайсов', description: 'Проблемы, сроки и карточки' },
  { value: 'clients', label: 'Клиенты', description: 'Активность, приоритет и история' },
  { value: 'publicActivity', label: 'Публичная активность', description: 'Ссылки, PDF и Excel' },
  { value: 'events', label: 'Журнал событий', description: 'Действия и фильтры' },
];

function downloadFile(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function resolveTab(value: string | null): Tab {
  if (value === 'public' || value === 'pdf' || value === 'excel') return 'publicActivity';
  return tabs.some((item) => item.value === value) ? (value as Tab) : 'overview';
}

function resolvePublicActivityTab(value: string | null): PublicActivityTab {
  return publicActivityTabs.some((item) => item.value === value) ? (value as PublicActivityTab) : 'public';
}

export type AdminWholesaleAnalyticsProps = {
  onTabChange?: (tab: AdminWholesaleAnalyticsTab) => void;
  managerManagementContent?: ReactNode;
};

function AnalyticsExportPanel({
  analytics,
  period,
  managerId,
  format,
  email,
  status,
  busy,
  onManagerChange,
  onFormatChange,
  onEmailChange,
  onDownload,
  onSend,
  downloadDone,
  sendDone,
}: {
  analytics: Analytics;
  period: Period;
  managerId: string;
  format: ExportFormat;
  email: string;
  status: string;
  busy: boolean;
  onManagerChange: (value: string) => void;
  onFormatChange: (value: ExportFormat) => void;
  onEmailChange: (value: string) => void;
  onDownload: () => void;
  onSend: () => void;
  downloadDone: boolean;
  sendDone: boolean;
}) {
  return (
    <div className={styles.analyticsExportPanel}>
      <div className={styles.analyticsExportHeader}>
        <strong>Отчёт</strong>
        <span>Период: {periods.find((item) => item.value === period)?.label ?? '30 дней'}</span>
      </div>
      <div className={styles.analyticsExportGrid}>
        <select aria-label="Менеджер для отчёта" value={managerId} onChange={(event) => onManagerChange(event.target.value)}>
          <option value="all">Все менеджеры</option>
          {analytics.managers.map((manager) => (
            <option key={manager.id} value={manager.id}>{manager.name}</option>
          ))}
        </select>
        <select aria-label="Формат отчёта" value={format} onChange={(event) => onFormatChange(event.target.value === 'xls' ? 'xls' : 'pdf')}>
          <option value="pdf">PDF</option>
          <option value="xls">Excel</option>
        </select>
        <button className={downloadDone ? styles.analyticsExportSuccess : ''} type="button" onClick={onDownload}>
          {downloadDone ? 'Скачано' : 'Скачать'}
        </button>
      </div>
      <div className={styles.analyticsExportMail}>
        <input
          type="email"
          placeholder="Email для отчёта"
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
        />
        <button className={sendDone ? styles.analyticsExportSuccess : ''} type="button" disabled={busy} onClick={onSend}>
          {busy ? 'Отправка...' : sendDone ? 'Отправлено' : 'Отправить'}
        </button>
      </div>
      {status ? <p className={styles.analyticsExportStatus}>{status}</p> : null}
    </div>
  );
}

export function AdminWholesaleAnalytics({ onTabChange, managerManagementContent }: AdminWholesaleAnalyticsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [period, setPeriod] = useState<Period>('30d');
  const [tab, setTab] = useState<Tab>(() => resolveTab(searchParams.get('tab')));
  const [publicActivityTab, setPublicActivityTab] = useState<PublicActivityTab>(() =>
    resolvePublicActivityTab(searchParams.get('activity') ?? searchParams.get('tab')),
  );
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [managerFilter, setManagerFilter] = useState('');
  const [exportManagerId, setExportManagerId] = useState('all');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [exportEmail, setExportEmail] = useState('');
  const [exportStatus, setExportStatus] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportDownloadDone, setExportDownloadDone] = useState(false);
  const [exportSendDone, setExportSendDone] = useState(false);
  const [clearEventsBusy, setClearEventsBusy] = useState(false);
  const [clearEventsStatus, setClearEventsStatus] = useState('');

  const loadAnalytics = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`/api/admin/wholesale/analytics?period=${period}`, { cache: 'no-store', signal });
      if (!response.ok) throw new Error('Не удалось загрузить общую аналитику');
      const data = (await response.json()) as Analytics;
      if (!signal?.aborted) setAnalytics(data);
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить общую аналитику');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    const controller = new AbortController();
    void loadAnalytics(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadAnalytics]);

  useEffect(() => {
    const nextTab = resolveTab(searchParams.get('tab'));
    const nextPublicActivityTab = resolvePublicActivityTab(searchParams.get('activity') ?? searchParams.get('tab'));
    setTab((current) => (current === nextTab ? current : nextTab));
    setPublicActivityTab((current) => (current === nextPublicActivityTab ? current : nextPublicActivityTab));
    onTabChange?.(nextTab);
  }, [onTabChange, searchParams]);

  const filteredEvents = useMemo(() => {
    const events = analytics?.recentEvents ?? [];
    return events.filter((event) => {
      if (eventTypeFilter && event.eventType !== eventTypeFilter) return false;
      if (actorFilter && event.actorType !== actorFilter) return false;
      if (managerFilter && String(event.managerId ?? '') !== managerFilter) return false;
      return true;
    });
  }, [actorFilter, analytics?.recentEvents, eventTypeFilter, managerFilter]);

  const activeTab = tabs.find((item) => item.value === tab) ?? tabs[0];

  const clearEventLog = async () => {
    if (!analytics?.recentEvents.length || clearEventsBusy) return;
    if (!window.confirm('Очистить журнал событий? Все события будут удалены.')) return;

    setClearEventsBusy(true);
    setClearEventsStatus('');

    try {
      const response = await fetch('/api/admin/wholesale/analytics', { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : 'Не удалось очистить журнал');
      }

      setEventTypeFilter('');
      setActorFilter('');
      setManagerFilter('');
      setClearEventsStatus('Журнал очищен');
      await loadAnalytics();
    } catch (reason) {
      setClearEventsStatus(reason instanceof Error ? reason.message : 'Не удалось очистить журнал');
    } finally {
      setClearEventsBusy(false);
    }
  };

  const renderTabContent = () => {
    if (!analytics) return null;

    if (tab === 'overview') return <OverviewTab analytics={analytics} />;
    if (tab === 'managers') return managerManagementContent ?? null;
    if (tab === 'managerRatings') return <ManagerRatingsTab analytics={analytics} routerPush={router.push} />;
    if (tab === 'prices') return <PricesTab analytics={analytics} routerPush={router.push} />;
    if (tab === 'clients') return <ClientsTab analytics={analytics} routerPush={router.push} />;
    if (tab === 'publicActivity') {
      return (
        <PublicActivitySection
          activeTab={publicActivityTab}
          analytics={analytics}
          onTabChange={selectPublicActivityTab}
          routerPush={router.push}
        />
      );
    }

    return (
      <EventsTab
        analytics={analytics}
        events={filteredEvents}
        eventTypeFilter={eventTypeFilter}
        actorFilter={actorFilter}
        managerFilter={managerFilter}
        setEventTypeFilter={setEventTypeFilter}
        setActorFilter={setActorFilter}
        setManagerFilter={setManagerFilter}
        clearBusy={clearEventsBusy}
        clearStatus={clearEventsStatus}
        onClear={clearEventLog}
      />
    );
  };

  const selectTab = (nextTab: Tab) => {
    setTab(nextTab);
    onTabChange?.(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', nextTab);
    if (nextTab === 'publicActivity') {
      params.set('activity', publicActivityTab);
    } else {
      params.delete('activity');
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const selectPublicActivityTab = (nextTab: PublicActivityTab) => {
    setPublicActivityTab(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'publicActivity');
    params.set('activity', nextTab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const exportParams = () => {
    const params = new URLSearchParams({ period, format: exportFormat });
    if (exportManagerId !== 'all') params.set('managerId', exportManagerId);
    return params;
  };

  const downloadAnalytics = () => {
    setExportStatus('');
    setExportDownloadDone(true);
    window.setTimeout(() => setExportDownloadDone(false), 1800);
    downloadFile(`/api/admin/wholesale/analytics/export?${exportParams().toString()}`);
  };

  const downloadDiscountReport = () => {
    downloadFile('/api/admin/wholesale/discount-report');
  };

  const sendAnalyticsEmail = async () => {
    const email = exportEmail.trim();
    if (!email) {
      setExportStatus('Укажите email');
      return;
    }

    setExportBusy(true);
    setExportStatus('');
    setExportSendDone(false);
    try {
      const response = await fetch('/api/admin/wholesale/analytics/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period,
          format: exportFormat,
          managerId: exportManagerId,
          email,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Не удалось отправить отчёт');
      setExportStatus('Отчёт отправлен');
      setExportSendDone(true);
      window.setTimeout(() => setExportSendDone(false), 1800);
    } catch (reason) {
      setExportStatus(reason instanceof Error ? reason.message : 'Не удалось отправить отчёт');
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div className={`${styles.analyticsSection} ${styles.analyticsAdminSection ?? ''}`}>
      <div className={styles.analyticsPanel}>
        <div className={styles.analyticsReportTop}>
          <div className={styles.analyticsPanelHeader}>
            <div>
              <h3>Общая аналитика</h3>
              <span>Все менеджеры, индивидуальные прайсы, просмотры и PDF</span>
            </div>
            {loading ? <span>Обновление данных</span> : null}
          </div>

          {analytics ? (
            <AnalyticsExportPanel
              analytics={analytics}
              period={period}
              managerId={exportManagerId}
              format={exportFormat}
              email={exportEmail}
              status={exportStatus}
              busy={exportBusy}
              onManagerChange={setExportManagerId}
              onFormatChange={setExportFormat}
              onEmailChange={setExportEmail}
              onDownload={downloadAnalytics}
              onSend={sendAnalyticsEmail}
              downloadDone={exportDownloadDone}
              sendDone={exportSendDone}
            />
          ) : null}
        </div>

        <div className={styles.analyticsToolbar}>
          <span>Период</span>
          <div className={styles.analyticsPeriod}>
            {periods.map((item) => (
              <button
                className={period === item.value ? styles.analyticsPeriodActive : styles.secondary}
                key={item.value}
                type="button"
                onClick={() => setPeriod(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {error ? <p className={styles.status}>{error}</p> : null}
        {!analytics && loading ? <EmptyState text="Загружаю общую аналитику" /> : null}

        {analytics ? (
          <div className={styles.analyticsDashboardLayout}>
            <aside className={styles.analyticsSidebar} aria-label="Разделы общей аналитики">
              <div className={styles.analyticsSidebarHeader}>
                <span>Дашборд</span>
                <strong>Разделы</strong>
              </div>
              <nav className={styles.analyticsSideNav}>
                {tabs.map((item) => (
                  <button
                    className={tab === item.value ? styles.analyticsSideNavActive : styles.analyticsSideNavItem}
                    key={item.value}
                    type="button"
                    onClick={() => selectTab(item.value)}
                  >
                    <span>{item.label}</span>
                    <small>{item.description}</small>
                  </button>
                ))}
              </nav>
            </aside>

            <section className={styles.analyticsContent}>
              <div className={styles.analyticsContentHeader}>
                <div>
                  <span>Раздел</span>
                  <h4>{activeTab.label}</h4>
                  <p>{activeTab.description}</p>
                </div>
                {tab === 'prices' ? (
                  <button type="button" className={styles.secondary} onClick={downloadDiscountReport}>
                    Отчёт по скидкам
                  </button>
                ) : null}
                {tab === 'managers' || tab === 'managerRatings' ? <strong>{analytics.managers.length} менеджеров</strong> : null}
              </div>
              <div className={styles.analyticsContentBody}>{renderTabContent()}</div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
