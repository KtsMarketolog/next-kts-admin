'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';

type Period = '7d' | '30d' | 'all';
type Problem = 'EMPTY' | 'NO_CLIENT' | 'NO_EXPIRATION' | 'EXPIRED';

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
  validUntil: string | null;
  problems: Problem[];
};

type ManagerAnalytics = {
  manager: {
    id: number;
    name: string;
    login: string;
    email: string;
    role: string;
    lastLoginAt: string | null;
  };
  summary: {
    totalPrices: number;
    activePrices: number;
    expiredPrices: number;
    pricesLast7Days: number;
    pricesLast30Days: number;
    periodPrices: number;
    averageItemsPerPrice: number;
    emptyPrices: number;
    pricesWithoutClient: number;
    pricesWithoutExpiration: number;
  };
  lastCreatedPrice: {
    id: number;
    title: string;
    createdAt: string;
  } | null;
  lastChange: AnalyticsChange | null;
  problemPrices: ProblemPrice[];
  recentChanges: AnalyticsChange[];
  publicViews: {
    total: number;
    last7Days: number;
    last30Days: number;
    periodViews: number;
    lastViewAt: string | null;
    topPrices: Array<{
      priceId: number;
      title: string;
      views: number;
      lastViewAt: string | null;
    }>;
  };
};

type AdminManagerAnalyticsProps = {
  managerId: number;
};

const periods: Array<{ value: Period; label: string }> = [
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: 'all', label: 'Всё время' },
];

const problemLabels: Record<Problem, string> = {
  EMPTY: 'Пустой',
  NO_CLIENT: 'Без клиента',
  NO_EXPIRATION: 'Без срока',
  EXPIRED: 'Просрочен',
};

const actionLabels: Record<string, string> = {
  create: 'Создан',
  edit: 'Изменён',
  enable: 'Включён',
  disable: 'Отключён',
  delete: 'Удалён',
};

function formatDate(value: string | null) {
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

function formatDateOnly(value: string | null) {
  if (!value) return '—';
  const datePart = value.slice(0, 10);
  const [year, month, day] = datePart.split('-');
  if (year && month && day) return `${day}.${month}.${year}`;
  return value;
}

function problemClass(problem: Problem) {
  if (problem === 'EXPIRED' || problem === 'NO_CLIENT') return styles.analyticsBadgeDanger;
  if (problem === 'NO_EXPIRATION') return styles.analyticsBadgeWarning;
  return styles.analyticsBadgeOrange;
}

function actionLabel(action: string) {
  return actionLabels[action] ?? action;
}

export function AdminManagerAnalytics({ managerId }: AdminManagerAnalyticsProps) {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>('30d');
  const [analytics, setAnalytics] = useState<ManagerAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
        if (!active) return;
        setAnalytics(data);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить аналитику');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [managerId, period]);

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

  const kpis = [
    {
      title: 'Всего прайсов',
      value: analytics.summary.totalPrices,
      text: 'Все прайсы, закреплённые за менеджером',
      tone: styles.analyticsToneBlue,
    },
    {
      title: 'Активные прайсы',
      value: analytics.summary.activePrices,
      text: 'Сейчас доступны по публичной ссылке',
      tone: styles.analyticsToneGreen,
    },
    {
      title: 'Просроченные',
      value: analytics.summary.expiredPrices,
      text: 'Срок действия уже прошёл',
      tone: styles.analyticsToneRed,
    },
    {
      title: 'За 30 дней',
      value: analytics.summary.pricesLast30Days,
      text: 'Создано за последние 30 дней',
      tone: styles.analyticsToneViolet,
    },
  ];

  return (
    <section className={`${styles.section} ${styles.analyticsSection}`}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Индивидуальные прайсы</p>
          <h2>Аналитика менеджера</h2>
          <div className={styles.analyticsManagerMeta}>
            <span>{analytics.manager.name}</span>
            {analytics.manager.email ? <span>{analytics.manager.email}</span> : null}
            <span>{analytics.manager.role}</span>
            <span>Последний вход: {formatDate(analytics.manager.lastLoginAt)}</span>
          </div>
        </div>
        <div className={styles.topbarActions}>
          <button
            className={styles.secondary}
            type="button"
            onClick={() => router.push(`/admin/wholesale/admin/managers/${managerId}`)}
          >
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

      <div className={styles.analyticsKpiGrid}>
        {kpis.map((item) => (
          <article className={`${styles.analyticsKpiCard} ${item.tone}`} key={item.title}>
            <span>{item.title}</span>
            <strong>{item.value}</strong>
            <p>{item.text}</p>
          </article>
        ))}
      </div>

      <div className={styles.analyticsSplit}>
        <article className={styles.analyticsPanel}>
          <div className={styles.analyticsPanelHeader}>
            <h3>Активность</h3>
            <span>{loading ? 'Обновляем...' : 'Актуальные данные'}</span>
          </div>
          <dl className={styles.analyticsList}>
            <div>
              <dt>Прайсов за 7 дней</dt>
              <dd>{analytics.summary.pricesLast7Days}</dd>
            </div>
            <div>
              <dt>Прайсов за 30 дней</dt>
              <dd>{analytics.summary.pricesLast30Days}</dd>
            </div>
            <div>
              <dt>Создано за выбранный период</dt>
              <dd>{analytics.summary.periodPrices}</dd>
            </div>
            <div>
              <dt>Последний созданный прайс</dt>
              <dd>
                {analytics.lastCreatedPrice
                  ? `${analytics.lastCreatedPrice.title} · ${formatDate(analytics.lastCreatedPrice.createdAt)}`
                  : 'У менеджера пока нет созданных прайсов'}
              </dd>
            </div>
            <div>
              <dt>Последнее изменение</dt>
              <dd>
                {analytics.lastChange
                  ? `${actionLabel(analytics.lastChange.action)} · ${analytics.lastChange.priceTitle} · ${formatDate(
                      analytics.lastChange.createdAt,
                    )} · ${analytics.lastChange.changedBy}`
                  : 'Пока нет записей об изменениях'}
              </dd>
            </div>
            <div>
              <dt>Последний вход менеджера</dt>
              <dd>{formatDate(analytics.manager.lastLoginAt)}</dd>
            </div>
          </dl>
        </article>

        <article className={styles.analyticsPanel}>
          <div className={styles.analyticsPanelHeader}>
            <h3>Качество прайсов</h3>
            <span>Проблемы подсвечены</span>
          </div>
          <div className={styles.analyticsQualityGrid}>
            <div>
              <span>Среднее позиций</span>
              <strong>{analytics.summary.averageItemsPerPrice}</strong>
            </div>
            <div>
              <span>Пустые</span>
              <strong>{analytics.summary.emptyPrices}</strong>
            </div>
            <div>
              <span>Без клиента</span>
              <strong>{analytics.summary.pricesWithoutClient}</strong>
            </div>
            <div>
              <span>Без срока</span>
              <strong>{analytics.summary.pricesWithoutExpiration}</strong>
            </div>
          </div>
          <div className={styles.analyticsBadgesRow}>
            {analytics.summary.emptyPrices ? <span className={styles.analyticsBadgeOrange}>Пустые прайсы</span> : null}
            {analytics.summary.pricesWithoutClient ? (
              <span className={styles.analyticsBadgeDanger}>Без клиента</span>
            ) : null}
            {analytics.summary.pricesWithoutExpiration ? (
              <span className={styles.analyticsBadgeWarning}>Без срока действия</span>
            ) : null}
            {analytics.summary.expiredPrices ? <span className={styles.analyticsBadgeDanger}>Просроченные</span> : null}
          </div>
        </article>
      </div>

      <article className={styles.analyticsPanel}>
        <div className={styles.analyticsPanelHeader}>
          <h3>Публичные ссылки</h3>
          <span>Просмотры страниц /price/[token]</span>
        </div>
        {analytics.publicViews.total === 0 ? (
          <p className={styles.mutedText}>Публичные ссылки пока не открывали</p>
        ) : (
          <>
            <div className={styles.analyticsPublicGrid}>
              <div>
                <span>Всего открытий</span>
                <strong>{analytics.publicViews.total}</strong>
              </div>
              <div>
                <span>За 7 дней</span>
                <strong>{analytics.publicViews.last7Days}</strong>
              </div>
              <div>
                <span>За 30 дней</span>
                <strong>{analytics.publicViews.last30Days}</strong>
              </div>
              <div>
                <span>Последний просмотр</span>
                <strong>{formatDate(analytics.publicViews.lastViewAt)}</strong>
              </div>
            </div>
            <div className={styles.analyticsTopList}>
              {analytics.publicViews.topPrices.map((item) => (
                <div className={styles.analyticsTopItem} key={item.priceId}>
                  <span>{item.title}</span>
                  <span className={styles.analyticsTopViewedAt}>
                    Последний просмотр: {formatDate(item.lastViewAt)}
                  </span>
                  <strong>{item.views}</strong>
                </div>
              ))}
            </div>
          </>
        )}
      </article>

      <article className={styles.analyticsPanel}>
        <div className={styles.analyticsPanelHeader}>
          <h3>Проблемные прайсы</h3>
          <span>{analytics.problemPrices.length ? `${analytics.problemPrices.length} требуют внимания` : 'Нет проблем'}</span>
        </div>
        {analytics.problemPrices.length === 0 ? (
          <p className={styles.mutedText}>Проблемных прайсов нет</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.adminTable}>
              <thead>
                <tr>
                  <th>Название прайса</th>
                  <th>Клиент</th>
                  <th>Проблема</th>
                  <th>Дата создания</th>
                  <th>Срок действия</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {analytics.problemPrices.map((price) => (
                  <tr key={price.id}>
                    <td>{price.title}</td>
                    <td>{price.clientName || '—'}</td>
                    <td>
                      <div className={styles.analyticsBadgesRow}>
                        {price.problems.map((problem) => (
                          <span className={problemClass(problem)} key={problem}>
                            {problemLabels[problem]}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{formatDate(price.createdAt)}</td>
                    <td>{formatDateOnly(price.validUntil)}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => router.push(`/admin/wholesale/${price.id}/edit?analyticsManagerId=${managerId}`)}
                      >
                        Редактировать
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      <article className={styles.analyticsPanel}>
        <div className={styles.analyticsPanelHeader}>
          <h3>Последние действия</h3>
          <span>Журнал изменений прайсов</span>
        </div>
        {analytics.recentChanges.length === 0 ? (
          <p className={styles.mutedText}>Пока нет записей об изменениях</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.adminTable}>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Действие</th>
                  <th>Прайс</th>
                  <th>Кто изменил</th>
                  <th>Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {analytics.recentChanges.map((change) => (
                  <tr key={change.id}>
                    <td>{formatDate(change.createdAt)}</td>
                    <td>{actionLabel(change.action)}</td>
                    <td>{change.priceId ? change.priceTitle : `${change.priceTitle} (удалён)`}</td>
                    <td>{change.changedBy}</td>
                    <td>{change.details || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </section>
  );
}
