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
  const personalSelection = useReportSelection(managerDashboardViewIdentity(overview));
  return (
    <div className={styles.stack}>
      <PersonalDashboardViewer key={personalSelection.identity} overview={overview} loading={loading} onReload={onReload} selection={personalSelection} />
      <DashboardDataHistory overview={overview} personalSelection={personalSelection} />
    </div>
  );
}

export function RoutePlannerViewer({ shared, loading, onReload }: Omit<SharedViewerProps, 'selection'>) {
  const version = shared?.htmlVersions.find((item) => item.id === shared.activeHtmlVersionId);
  const selection = useReportSelection(JSON.stringify(['route-planner', shared?.activeHtmlVersionId, version?.format]));
  return <div className={styles.stack}>
    <SharedDashboardViewer key={selection.identity} shared={shared} loading={loading} onReload={onReload} selection={selection} />
    <SharedDataHistory shared={shared} selection={selection} />
  </div>;
}

// Reset synchronously on identity changes so stale personal data cannot appear
// for another recipient, even for one render.
function useReportSelection(identity: string) {
  const empty = { identity, historicalId: null as number | null, revision: 0 };
  const [stored, setStored] = useState(empty);
  const state = stored.identity === identity ? stored : empty;
  if (stored.identity !== identity) setStored(empty);
  return {
    ...state,
    setHistoricalId: (historicalId: number | null) => setStored((previous) => ({ ...(previous.identity === identity ? previous : empty), historicalId })),
    reload: () => setStored((previous) => ({ ...(previous.identity === identity ? previous : empty), revision: (previous.identity === identity ? previous.revision : 0) + 1 })),
  };
}

type ReportSelection = ReturnType<typeof useReportSelection>;

function PersonalDashboardViewer({ overview, loading, onReload, selection }: ViewerProps & { selection: ReportSelection }) {
  const { historicalId, revision } = selection;
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
      </section>

      {!overview.htmlVersion ? (
        <section className={styles.panel}><h2>Личный дашборд</h2><p className={styles.empty}>HTML дашборда ещё не опубликован.</p></section>
      ) : (
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <h2>Личный дашборд</h2>
            <button className={styles.secondary} type="button" disabled={loading} onClick={async () => {
              if (await onReload('personal')) selection.reload();
            }}>{loading ? 'Обновляем…' : 'Перезагрузить отчёт'}</button>
          </div>
          {expired ? <p className={styles.warning}>Срок доступа к этому снимку истёк. HTML дашборда доступен, а для открытия личных данных нужен свежий файл.</p> : null}
          <DashboardFrame audience={overview.audience} versionId={overview.htmlVersion.id} snapshotId={selected?.id} revision={revision} />
        </section>
      )}
    </div>
  );
}

type SharedViewerProps = {
  shared?: ManagerDashboardSupportShared | null;
  loading: boolean;
  onReload: (report?: 'personal' | 'shared') => Promise<boolean>;
  selection: ReportSelection;
};

function SharedDashboardViewer(props: SharedViewerProps) {
  const version = props.shared?.htmlVersions.find((item) => item.id === props.shared?.activeHtmlVersionId);
  return version?.format === 'route-planner-v1'
    ? <SharedJsonDashboardViewer {...props} versionId={version.id} />
    : <SharedKtspDashboardViewer {...props} />;
}

function SharedJsonDashboardViewer({ shared, loading, onReload, versionId, selection }: SharedViewerProps & { versionId: number }) {
  const { historicalId, revision } = selection;
  const history = shared?.jsonHistory?.filter((item) => item.htmlVersionId === versionId) ?? [];
  const current = shared?.jsonSnapshot?.htmlVersionId === versionId ? shared.jsonSnapshot : null;
  const selected = historicalId ? history.find((snapshot) => snapshot.id === historicalId) ?? current : current;
  const isHistorical = Boolean(selected && current && selected.id !== current.id);
  return (
    <section className={styles.panel} aria-labelledby="manager-dashboard-shared-heading">
      <div className={styles.sectionHeading}>
        <div><h2 id="manager-dashboard-shared-heading">Компоновщик рейсов</h2><p>Общий отчёт для сотрудников с доступом. Опубликованный JSON загружается автоматически, без email и пароля.</p></div>
        <button className={styles.secondary} type="button" disabled={loading} onClick={async () => {
          if (await onReload('shared')) selection.reload();
        }}>{loading ? 'Обновляем…' : 'Перезагрузить общий отчёт'}</button>
      </div>
      <span className={styles.badge} data-status={selected ? 'current' : 'missing'}>{selected ? 'Данные получены' : 'Данные ещё не поступили'}</span>
      {selected ? <>
        <dl className={styles.metadata}>
          <div><dt>Общий файл</dt><dd>{selected.originalName}</dd></div>
          <div><dt>Подготовлен, МСК</dt><dd>{formatDashboardDate(selected.savedAt)}</dd></div>
          <div><dt>Загружен, МСК</dt><dd>{formatDashboardDate(selected.receivedAt)}</dd></div>
        </dl>
        <p className={styles.notice}>Изменения и расчёты внутри компоновщика не меняют опубликованный файл для других менеджеров.</p>
        {isHistorical ? <p className={styles.warning}>Открыт архивный общий файл. Он не заменяет текущие данные.</p> : null}
      </> : <p className={styles.empty}>JSON для этой версии общего HTML ещё не загружен администратором.</p>}
      <div className={styles.preview}><SharedDashboardFrame versionId={versionId} snapshotId={selected?.id} revision={revision} /></div>
    </section>
  );
}

function SharedKtspDashboardViewer({ shared, loading, onReload, selection }: SharedViewerProps) {
  const { historicalId, revision } = selection;
  const selected = historicalId ? shared?.history.find((snapshot) => snapshot.id === historicalId) ?? shared?.snapshot : shared?.snapshot;
  const isHistorical = Boolean(selected && shared?.snapshot && selected.id !== shared.snapshot.id);
  const expired = Boolean(selected && isSnapshotExpired(selected.expires));
  const version = shared?.htmlVersions.find((item) => item.id === shared.activeHtmlVersionId);
  return (
    <section className={styles.panel} aria-labelledby="manager-dashboard-shared-heading">
      <div className={styles.sectionHeading}>
        <div><h2 id="manager-dashboard-shared-heading">Компоновщик рейсов</h2><p>Общий отчёт для сотрудников с доступом.</p></div>
        <button className={styles.secondary} type="button" disabled={loading} onClick={async () => {
          if (await onReload('shared')) selection.reload();
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
      {version ? <div className={styles.preview}><SharedDashboardFrame versionId={version.id} snapshotId={selected?.id} revision={revision} /></div>
        : <p className={styles.empty}>Общий HTML дашборда ещё не опубликован.</p>}
    </section>
  );
}

function DashboardDataHistory({ overview, personalSelection }: {
  overview: ViewerOverview; personalSelection: ReportSelection;
}) {
  const personalHistory = overview.bindingStatus === 'matched' ? overview.history.filter((snapshot) => snapshot.id !== overview.snapshot?.id) : [];
  if (!personalHistory.length) return null;
  return (
    <section id="manager-dashboard-data-history" className={styles.panel} aria-labelledby="manager-dashboard-data-history-heading">
      <div className={styles.sectionHeading}><div><h2 id="manager-dashboard-data-history-heading">История данных</h2><p>Хранятся текущий и один предыдущий рабочий снимок. Выбор предыдущего файла меняет только этот отчёт.</p></div></div>
      <div className={styles.actions}>
        <label className={styles.inlineLabel} htmlFor="manager-dashboard-history">Версия данных</label>
        <select id="manager-dashboard-history" value={personalHistory.some((snapshot) => snapshot.id === personalSelection.historicalId) ? personalSelection.historicalId! : ''} onChange={(event) => personalSelection.setHistoricalId(event.target.value ? Number(event.target.value) : null)}>
          <option value="">Текущий файл</option>
          {personalHistory.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{formatDashboardDate(snapshot.issued)} — {snapshot.originalName}</option>)}
        </select>
      </div>
    </section>
  );
}

function SharedDataHistory({ shared, selection }: Pick<SharedViewerProps, 'shared' | 'selection'>) {
  const sharedVersion = shared?.htmlVersions.find((item) => item.id === shared.activeHtmlVersionId);
  const sharedUsesJson = sharedVersion?.format === 'route-planner-v1';
  const currentSharedId = sharedUsesJson ? shared?.jsonSnapshot?.htmlVersionId === sharedVersion.id ? shared.jsonSnapshot.id : null : shared?.snapshot?.id;
  const sharedHistory = sharedUsesJson
    ? (shared?.jsonHistory ?? []).filter((snapshot) => snapshot.htmlVersionId === sharedVersion.id && snapshot.id !== currentSharedId).map((snapshot) => ({ ...snapshot, date: snapshot.savedAt }))
    : (shared?.history ?? []).filter((snapshot) => snapshot.id !== currentSharedId).map((snapshot) => ({ ...snapshot, date: snapshot.issued }));
  if (!sharedHistory.length) return null;
  return (
    <section id="manager-dashboard-data-history" className={styles.panel} aria-labelledby="manager-dashboard-data-history-heading">
      <div className={styles.sectionHeading}><div><h2 id="manager-dashboard-data-history-heading">История данных</h2><p>Хранятся текущий и один предыдущий рабочий снимок. Выбор предыдущего файла меняет только соответствующий отчёт.</p></div></div>
      <div className={styles.stack}>
        {sharedHistory.length ? <div className={styles.actions}>
          <label className={styles.inlineLabel} htmlFor="manager-dashboard-shared-history">Версия общих данных</label>
          <select id="manager-dashboard-shared-history" value={sharedHistory.some((snapshot) => snapshot.id === selection.historicalId) ? selection.historicalId! : ''} onChange={(event) => selection.setHistoricalId(event.target.value ? Number(event.target.value) : null)}>
            <option value="">Текущий общий файл</option>
            {sharedHistory.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{formatDashboardDate(snapshot.date)} — {snapshot.originalName}</option>)}
          </select>
        </div> : null}
      </div>
    </section>
  );
}
