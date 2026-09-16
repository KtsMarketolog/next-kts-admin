import { useState } from 'react';

import { DashboardFrame, SharedDashboardFrame, formatDashboardDate, isSnapshotExpired, SnapshotStatus } from './ManagerDashboardParts';
import type { ManagerDashboardOverview, ManagerDashboardSupportShared } from './types';
import styles from './ManagerDashboard.module.scss';

type ViewerOverview = Extract<ManagerDashboardOverview, { mode: 'view' }>;

export function managerDashboardViewIdentity(overview: Pick<ViewerOverview, 'email' | 'bindingStatus' | 'audience'>) {
  return JSON.stringify([overview.audience, overview.email, overview.bindingStatus]);
}

type ViewerProps = {
  overview: ViewerOverview;
  loading: boolean;
  onReload: (report?: 'personal' | 'shared') => Promise<boolean>;
};

export function ManagerDashboardViewer({ overview, loading, onReload }: ViewerProps) {
  return (
    <div className={styles.stack}>
      <PersonalDashboardViewer key={managerDashboardViewIdentity(overview)} overview={overview} loading={loading} onReload={onReload} />
      {overview.audience === 'support' ? <SharedDashboardViewer shared={overview.supportShared} loading={loading} onReload={onReload} /> : null}
    </div>
  );
}

function PersonalDashboardViewer({ overview, loading, onReload }: ViewerProps) {
  const [historicalId, setHistoricalId] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const hasBinding = overview.bindingStatus === 'matched';
  const history = hasBinding ? overview.history : [];
  const selected = !hasBinding ? null : historicalId
    ? history.find((snapshot) => snapshot.id === historicalId) ?? overview.snapshot
    : overview.snapshot;
  const isHistorical = Boolean(selected && overview.snapshot && selected.id !== overview.snapshot.id);
  const expired = Boolean(selected && isSnapshotExpired(selected.expires));
  const email = overview.email?.trim();

  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <h2>{isHistorical ? 'Архивный снимок' : 'Ваши данные'}</h2>
            {hasBinding && email ? <p>Файл для {email} подставляется автоматически.</p>
              : <p>Email нужен только для привязки личного файла, а не для просмотра HTML дашборда.</p>}
          </div>
          {hasBinding ? <SnapshotStatus snapshot={selected} status={isHistorical ? undefined : overview.snapshotStatus} expectedIssuedAfter={overview.expectedIssuedAfter} />
            : <span className={styles.badge} data-status="missing">Нужна привязка файла</span>}
        </div>
        {overview.bindingStatus === 'missing_email' ? (
          <p className={styles.warning}>В профиле не указан email для назначения личного файла. {overview.htmlVersion ? 'Опубликованный HTML доступен ниже. ' : ''}Для автоматического получения снимков администратору нужно указать email менеджера.</p>
        ) : overview.bindingStatus === 'ambiguous_email' ? (
          <p className={styles.warning}>Этот email указан у нескольких менеджеров. Личный файл не подставляется, пока администратор не устранит неоднозначную привязку. {overview.htmlVersion ? 'Опубликованный HTML доступен ниже.' : ''}</p>
        ) : null}
        {selected ? (
          <>
            <dl className={styles.metadata}>
              <div><dt>Файл</dt><dd>{selected.originalName}</dd></div>
              <div><dt>Подготовлен, МСК</dt><dd>{formatDashboardDate(selected.issued)}</dd></div>
              <div><dt>Доступ до, МСК</dt><dd>{formatDashboardDate(selected.expires)}</dd></div>
            </dl>
            {!expired ? <p className={styles.notice}>Для открытия зашифрованного отчёта введите пароль от файла внутри дашборда. Это пароль снимка, который вы получили вместе с ним.</p> : null}
            {isHistorical ? <p className={styles.warning}>Открыт архивный файл. Он не заменяет текущие данные.</p> : null}
          </>
        ) : hasBinding ? <p className={styles.empty}>Ваш файл ещё не поступил. После импорта он появится здесь автоматически. {overview.htmlVersion ? 'Опубликованный HTML уже доступен ниже.' : ''}</p> : null}
        {history.length > 0 ? (
          <div className={styles.actions}>
            <label className={styles.inlineLabel} htmlFor="manager-dashboard-history">Версия данных</label>
            <select id="manager-dashboard-history" value={historicalId ?? ''} onChange={(event) => setHistoricalId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">Текущий файл</option>
              {history.filter((snapshot) => snapshot.id !== overview.snapshot?.id).map((snapshot) => (
                <option key={snapshot.id} value={snapshot.id}>{formatDashboardDate(snapshot.issued)} — {snapshot.originalName}</option>
              ))}
            </select>
          </div>
        ) : null}
      </section>

      {!overview.htmlVersion ? (
        <section className={styles.panel}><h2>Личный дашборд</h2><p className={styles.empty}>HTML дашборда ещё не опубликован.</p></section>
      ) : (
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <h2>Личный дашборд</h2>
            <button className={styles.secondary} type="button" disabled={loading} onClick={async () => {
              if (await onReload('personal')) setRevision((value) => value + 1);
            }}>{loading ? 'Обновляем…' : 'Перезагрузить отчёт'}</button>
          </div>
          {expired ? <p className={styles.warning}>Срок доступа к этому снимку истёк. HTML дашборда доступен, а для открытия личных данных нужен свежий файл.</p> : null}
          <DashboardFrame audience={overview.audience} versionId={overview.htmlVersion.id} snapshotId={selected?.id} revision={revision} />
        </section>
      )}
    </div>
  );
}

function SharedDashboardViewer({ shared, loading, onReload }: {
  shared?: ManagerDashboardSupportShared | null;
  loading: boolean;
  onReload: (report?: 'personal' | 'shared') => Promise<boolean>;
}) {
  const [historicalId, setHistoricalId] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const selected = historicalId ? shared?.history.find((snapshot) => snapshot.id === historicalId) ?? shared?.snapshot : shared?.snapshot;
  const isHistorical = Boolean(selected && shared?.snapshot && selected.id !== shared.snapshot.id);
  const expired = Boolean(selected && isSnapshotExpired(selected.expires));
  const version = shared?.htmlVersions.find((item) => item.id === shared.activeHtmlVersionId);
  return (
    <section className={styles.panel} aria-labelledby="manager-dashboard-shared-heading">
      <div className={styles.sectionHeading}>
        <div><h2 id="manager-dashboard-shared-heading">Общий дашборд</h2><p>Один отчёт для всех менеджеров по сопровождению.</p></div>
        <button className={styles.secondary} type="button" disabled={loading} onClick={async () => {
          if (await onReload('shared')) setRevision((value) => value + 1);
        }}>{loading ? 'Обновляем…' : 'Перезагрузить общий отчёт'}</button>
      </div>
      <SnapshotStatus snapshot={selected ?? null} />
      {selected ? <>
        <dl className={styles.metadata}>
          <div><dt>Общий файл</dt><dd>{selected.originalName}</dd></div>
          <div><dt>Подготовлен, МСК</dt><dd>{formatDashboardDate(selected.issued)}</dd></div>
          <div><dt>Доступ до, МСК</dt><dd>{formatDashboardDate(selected.expires)}</dd></div>
        </dl>
        {!expired ? <p className={styles.notice}>Для открытия общего зашифрованного отчёта введите пароль от общего файла внутри дашборда.</p>
          : <p className={styles.warning}>Срок доступа к общему снимку истёк. Для открытия общих данных нужен свежий файл.</p>}
        {isHistorical ? <p className={styles.warning}>Открыт архивный общий файл. Он не заменяет текущие данные.</p> : null}
      </> : <p className={styles.empty}>Общий файл ещё не загружен администратором.</p>}
      {(shared?.history.length ?? 0) > 0 ? <div className={styles.actions}>
        <label className={styles.inlineLabel} htmlFor="manager-dashboard-shared-history">Версия общих данных</label>
        <select id="manager-dashboard-shared-history" value={historicalId ?? ''} onChange={(event) => setHistoricalId(event.target.value ? Number(event.target.value) : null)}>
          <option value="">Текущий общий файл</option>
          {shared!.history.filter((snapshot) => snapshot.id !== shared?.snapshot?.id).map((snapshot) => (
            <option key={snapshot.id} value={snapshot.id}>{formatDashboardDate(snapshot.issued)} — {snapshot.originalName}</option>
          ))}
        </select>
      </div> : null}
      {version ? <div className={styles.preview}><SharedDashboardFrame versionId={version.id} snapshotId={selected?.id} revision={revision} /></div>
        : <p className={styles.empty}>Общий HTML дашборда ещё не опубликован.</p>}
    </section>
  );
}
