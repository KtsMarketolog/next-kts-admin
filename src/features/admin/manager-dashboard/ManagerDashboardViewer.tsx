import { useState } from 'react';

import { DashboardFrame, formatDashboardDate, isSnapshotExpired, SnapshotStatus } from './ManagerDashboardParts';
import type { ManagerDashboardOverview } from './types';
import styles from './ManagerDashboard.module.scss';

export function ManagerDashboardViewer({ overview, loading, onReload }: {
  overview: Extract<ManagerDashboardOverview, { mode: 'view' }>;
  loading: boolean;
  onReload: () => Promise<boolean>;
}) {
  const [historicalId, setHistoricalId] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const selected = historicalId
    ? overview.history.find((snapshot) => snapshot.id === historicalId) ?? overview.snapshot
    : overview.snapshot;
  const isHistorical = Boolean(selected && overview.snapshot && selected.id !== overview.snapshot.id);
  const expired = Boolean(selected && isSnapshotExpired(selected.expires));

  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <h2>{isHistorical ? 'Архивный снимок' : 'Ваши данные'}</h2>
            <p>Файл для {overview.email} подставляется автоматически.</p>
          </div>
          <SnapshotStatus snapshot={selected} status={isHistorical ? undefined : overview.snapshotStatus} expectedIssuedAfter={overview.expectedIssuedAfter} />
        </div>
        {selected ? (
          <>
            <dl className={styles.metadata}>
              <div><dt>Файл</dt><dd>{selected.originalName}</dd></div>
              <div><dt>Подготовлен, МСК</dt><dd>{formatDashboardDate(selected.issued)}</dd></div>
              <div><dt>Доступ до, МСК</dt><dd>{formatDashboardDate(selected.expires)}</dd></div>
            </dl>
            <p className={styles.notice}>Для открытия зашифрованного отчёта введите пароль от файла внутри дашборда. Это пароль снимка, который вы получили вместе с ним.</p>
            {isHistorical ? <p className={styles.warning}>Открыт архивный файл. Он не заменяет текущие данные.</p> : null}
          </>
        ) : <p className={styles.empty}>Ваш файл ещё не поступил. После импорта он появится здесь автоматически.</p>}
        {overview.expectedBy ? <p className={styles.muted}>Ежедневное обновление — к {overview.expectedBy}.</p> : null}
        {overview.history.length > 0 ? (
          <div className={styles.actions}>
            <label className={styles.inlineLabel} htmlFor="manager-dashboard-history">Версия данных</label>
            <select id="manager-dashboard-history" value={historicalId ?? ''} onChange={(event) => setHistoricalId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">Текущий файл</option>
              {overview.history.filter((snapshot) => snapshot.id !== overview.snapshot?.id).map((snapshot) => (
                <option key={snapshot.id} value={snapshot.id}>{formatDashboardDate(snapshot.issued)} — {snapshot.originalName}</option>
              ))}
            </select>
          </div>
        ) : null}
      </section>

      {!overview.htmlVersion ? (
        <section className={styles.panel}><p className={styles.empty}>HTML дашборда ещё не опубликован.</p></section>
      ) : selected ? (
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <h2>Личный дашборд</h2>
            <button className={styles.secondary} type="button" disabled={loading} onClick={async () => {
              if (await onReload()) setRevision((value) => value + 1);
            }}>{loading ? 'Обновляем…' : 'Перезагрузить отчёт'}</button>
          </div>
          {expired ? <p className={styles.warning}>Срок доступа к этому снимку истёк. Для открытия отчёта нужен свежий файл.</p>
            : <DashboardFrame versionId={overview.htmlVersion.id} snapshotId={selected.id} revision={revision} />}
        </section>
      ) : null}
    </div>
  );
}
