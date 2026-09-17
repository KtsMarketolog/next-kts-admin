import { useEffect, useRef, useState, type FormEvent } from 'react';

import { PERSONAL_DASHBOARD_AUDIENCE_LABELS, type PersonalDashboardAudience } from '@/shared/lib/managerDashboardAudience';

import { DashboardFrame, SharedDashboardFrame, formatDashboardDate, ImportResults, SnapshotStatus } from './ManagerDashboardParts';
import { ManagerDashboardImportJournal } from './ManagerDashboardImportJournal';
import { prepareSharedJsonUpload } from './sharedJsonUpload';
import type { ManagerDashboardImport, ManagerDashboardMutationResult, ManagerDashboardOverview } from './types';
import styles from './ManagerDashboard.module.scss';

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_SELECTION_FILE_BYTES = 63 * 1024 * 1024;
// Each request stays comfortably below the reverse proxy's 25 MiB body limit.
const MAX_REQUEST_FILE_BYTES = 16 * 1024 * 1024;
const AUDIENCES: PersonalDashboardAudience[] = ['development', 'support'];

type ManagementProps = {
  overview: Extract<ManagerDashboardOverview, { mode: 'manage' }>;
  busy: boolean;
  mutate: (path: string, init: RequestInit, successMessage: string) => Promise<ManagerDashboardMutationResult | null>;
  onAccessDenied?: () => void;
};

export function ManagerDashboardManagement({ overview, busy: externalBusy, mutate: performMutation, onAccessDenied }: ManagementProps) {
  const [pending, setPending] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<{ audience: PersonalDashboardAudience | 'support-shared'; versionId: number } | null>(null);
  const [fileErrors, setFileErrors] = useState<Partial<Record<PersonalDashboardAudience, string>>>({});
  const [results, setResults] = useState<ManagerDashboardImport[]>([]);
  const [sharedError, setSharedError] = useState('');
  const [sharedJsonProgress, setSharedJsonProgress] = useState('');
  const developmentHtmlInput = useRef<HTMLInputElement>(null);
  const supportHtmlInput = useRef<HTMLInputElement>(null);
  const htmlInputs = { development: developmentHtmlInput, support: supportHtmlInput };
  const snapshotInput = useRef<HTMLInputElement>(null);
  const sharedHtmlInput = useRef<HTMLInputElement>(null);
  const sharedSnapshotInput = useRef<HTMLInputElement>(null);
  const sharedEmailInput = useRef<HTMLInputElement>(null);
  const sharedJsonInput = useRef<HTMLInputElement>(null);
  const previewPanel = useRef<HTMLElement>(null);
  const audienceGrid = useRef<HTMLDivElement>(null);
  const mutationRef = useRef(false);
  const busy = externalBusy || pending;
  const previewGroup = overview.groups.find((item) => item.audience === previewSelection?.audience);
  const shared = overview.supportShared;
  const sharedActiveHtml = shared?.htmlVersions.find((version) => version.id === shared.activeHtmlVersionId);
  const sharedUsesJson = sharedActiveHtml?.format === 'route-planner-v1';
  const sharedPreview = previewSelection?.audience === 'support-shared';
  const preview = (sharedPreview ? shared : previewGroup)?.htmlVersions.find((version) => version.id === previewSelection?.versionId);
  const sharedJsonPreview = sharedPreview && preview?.format === 'route-planner-v1';
  // Reload an open JSON preview when its data changes, including the first upload.
  // The server resolves the snapshot for this HTML; revision only refreshes the iframe.
  const sharedPreviewRevision = sharedJsonPreview && shared?.jsonSnapshot?.htmlVersionId === preview?.id
    ? shared.jsonSnapshot.id : 0;

  useEffect(() => {
    const grid = audienceGrid.current;
    if (!grid) return;
    // Measure only natural content, never the cards whose minimum height we set.
    // This also works in our supported browsers predating CSS subgrid.
    const contents = Array.from(grid.querySelectorAll<HTMLElement>('[data-dashboard-equal-row]'));
    const desktop = window.matchMedia('(min-width: 1101px)');
    const update = () => {
      for (const row of ['heading', 'html']) {
        const property = `--dashboard-${row}-height`;
        if (!desktop.matches) { grid.style.removeProperty(property); continue; }
        const heights = contents.filter((node) => node.dataset.dashboardEqualRow === row).map((node) => {
          const style = window.getComputedStyle(node.parentElement!);
          return node.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
            + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        });
        if (heights.length) grid.style.setProperty(property, `${Math.ceil(Math.max(...heights))}px`);
      }
    };
    const observer = new ResizeObserver(update);
    contents.forEach((node) => observer.observe(node));
    desktop.addEventListener('change', update);
    update();
    return () => { observer.disconnect(); desktop.removeEventListener('change', update); };
  }, [overview.groups]);

  useEffect(() => {
    if (!previewSelection) return;
    previewPanel.current?.focus({ preventScroll: true });
    previewPanel.current?.scrollIntoView({ block: 'start' });
  }, [previewSelection, preview?.id]);

  async function mutate(path: string, init: RequestInit, successMessage: string) {
    // One shared guard covers both visible groups and the common file controls,
    // including a second click before React has rendered the disabled buttons.
    if (busy || mutationRef.current) return null;
    mutationRef.current = true;
    setPending(true);
    try { return await performMutation(path, init, successMessage); }
    finally { mutationRef.current = false; setPending(false); }
  }

  function showPreview(audience: PersonalDashboardAudience, versionId: number) {
    if (busy || mutationRef.current) return;
    const group = overview.groups.find((item) => item.audience === audience);
    if (group?.htmlVersions.some((version) => version.id === versionId)) setPreviewSelection({ audience, versionId });
  }

  async function uploadHtml(event: FormEvent<HTMLFormElement>, audience: PersonalDashboardAudience) {
    event.preventDefault();
    const group = overview.groups.find((item) => item.audience === audience);
    if (busy || mutationRef.current || !group) return;
    const input = htmlInputs[audience].current;
    const file = input?.files?.[0];
    if (!file) return;
    const label = PERSONAL_DASHBOARD_AUDIENCE_LABELS[audience];
    setFileErrors((previous) => ({ ...previous, [audience]: '' }));
    if (!/\.html?$/i.test(file.name) || file.size === 0 || file.size > MAX_HTML_BYTES) {
      setFileErrors((previous) => ({ ...previous, [audience]: 'Выберите непустой HTML-файл размером до 5 МБ.' }));
      return;
    }
    const form = new FormData();
    form.append('file', file);
    const result = await mutate(`/html?audience=${audience}`, { method: 'POST', body: form }, `HTML для группы «${label}» загружен как черновик. Можно опубликовать его сразу или сначала открыть предпросмотр.`);
    if (result) {
      // Never clear the other group's selection or infer a recipient from it.
      if (input) input.value = '';
      if (result.version?.audience === audience) setPreviewSelection({ audience, versionId: result.version.id });
    }
  }

  async function publish(audience: PersonalDashboardAudience, versionId: number) {
    const group = overview.groups.find((item) => item.audience === audience);
    if (busy || mutationRef.current || !group) return;
    const version = group.htmlVersions.find((item) => item.id === versionId);
    if (!version || versionId === group.activeHtmlVersionId) return;
    const label = PERSONAL_DASHBOARD_AUDIENCE_LABELS[audience];
    const isRollback = versionId === group.previousHtmlVersionId;
    if (!window.confirm(`${isRollback ? 'Вернуть' : 'Опубликовать'} HTML «${version.originalName}», версия #${versionId}, для группы «${label}»?\n\nHTML другой группы и личные файлы данных менеджеров сохранятся.`)) return;
    await mutate('/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience, versionId, expectedActiveVersionId: group.activeHtmlVersionId }),
    }, `HTML ${isRollback ? 'восстановлен' : 'опубликован'} для группы «${label}».`);
  }

  async function deleteHtml(audience: PersonalDashboardAudience, versionId: number) {
    const group = overview.groups.find((item) => item.audience === audience);
    if (busy || mutationRef.current || !group || versionId === group.activeHtmlVersionId) return;
    const version = group.htmlVersions.find((item) => item.id === versionId);
    if (!version) return;
    const label = PERSONAL_DASHBOARD_AUDIENCE_LABELS[audience];
    if (!window.confirm(`Удалить HTML «${version.originalName}», версия #${versionId}, из группы «${label}»?\n\nУдаление необратимо: вернуть эту версию можно будет только повторной загрузкой исходного файла.\n\nДействующий HTML, другая группа и личные снимки менеджеров сохранятся.`)) return;
    const result = await mutate(`/html?audience=${audience}&id=${versionId}`, { method: 'DELETE' }, `HTML «${version.originalName}», версия #${versionId}, удалён из группы «${label}».`);
    if (result) {
      setPreviewSelection((current) => current?.audience === audience && current.versionId === versionId ? null : current);
    }
  }

  async function uploadSnapshots(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || mutationRef.current) return;
    const files = Array.from(snapshotInput.current?.files ?? []);
    if (files.length === 0) return;
    const rejected: ManagerDashboardImport[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      if (!/\.ktsp$/i.test(file.name) || file.size === 0 || file.size > MAX_SNAPSHOT_BYTES) {
        rejected.push({ originalName: file.name, status: 'rejected', message: 'Нужен непустой файл .ktsp размером до 8 МБ.' });
      } else {
        accepted.push(file);
      }
    }
    setResults(rejected);
    if (accepted.length === 0) return;
    if (accepted.length > 32 || accepted.reduce((sum, file) => sum + file.size, 0) > MAX_SELECTION_FILE_BYTES) {
      setResults([...rejected, { originalName: 'Пакет файлов', status: 'rejected', message: 'Выберите не более 32 подходящих файлов и до 63 МБ суммарно. Разделите большую загрузку на несколько пакетов.' }]);
      return;
    }
    const batches: File[][] = [];
    let batch: File[] = [];
    let batchBytes = 0;
    for (const file of accepted) {
      if (batchBytes + file.size > MAX_REQUEST_FILE_BYTES) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(file);
      batchBytes += file.size;
    }
    if (batch.length) batches.push(batch);

    // Hold one guard across every request and clear the input once: retries must
    // be a new explicit selection, never a replay of already processed files.
    mutationRef.current = true;
    setPending(true);
    if (snapshotInput.current) snapshotInput.current.value = '';
    const completed = [...rejected];
    try {
      for (const [index, files] of batches.entries()) {
        const form = new FormData();
        files.forEach((file) => form.append('files', file));
        let result: ManagerDashboardMutationResult | null;
        try {
          result = await performMutation('/snapshots', { method: 'POST', body: form }, index === batches.length - 1
            ? 'Обработка файлов завершена. Результат каждого файла указан ниже.'
            : `Обработана часть ${index + 1} из ${batches.length}. Продолжаем загрузку файлов.`);
        } catch {
          result = null;
        }
        if (!result) {
          setResults([...completed,
            ...files.map((file) => ({ originalName: file.name, status: 'error', message: 'Не удалось подтвердить результат загрузки. Проверьте журнал импорта перед повторной загрузкой этого файла.' })),
            ...batches.slice(index + 1).flat().map((file) => ({ originalName: file.name, status: 'skipped', message: 'Файл не отправлен: загрузка остановлена после ошибки запроса. Выберите этот файл для новой загрузки.' })),
          ]);
          return;
        }
        completed.push(...(result.results ?? []));
        setResults([...completed]);
      }
    } finally {
      mutationRef.current = false;
      setPending(false);
    }
  }

  function showSharedPreview(versionId: number) {
    if (busy || mutationRef.current || !shared?.htmlVersions.some((version) => version.id === versionId)) return;
    setPreviewSelection({ audience: 'support-shared', versionId });
  }

  async function uploadSharedHtml(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || mutationRef.current) return;
    const file = sharedHtmlInput.current?.files?.[0];
    if (!file) return;
    setSharedError('');
    if (!/\.html?$/i.test(file.name) || file.size === 0 || file.size > MAX_HTML_BYTES) {
      setSharedError('Выберите непустой HTML-файл размером до 5 МБ.');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    const result = await mutate('/shared/html', { method: 'POST', body: form }, 'Общий HTML загружен как черновик. Можно опубликовать его сразу или сначала открыть предпросмотр.');
    if (result) {
      if (sharedHtmlInput.current) sharedHtmlInput.current.value = '';
      if (result.version) setPreviewSelection({ audience: 'support-shared', versionId: result.version.id });
    }
  }

  async function publishShared(versionId: number) {
    if (busy || mutationRef.current || !shared) return;
    const version = shared.htmlVersions.find((item) => item.id === versionId);
    if (!version || versionId === shared.activeHtmlVersionId) return;
    const rollback = versionId === shared.previousHtmlVersionId;
    if (!window.confirm(`${rollback ? 'Вернуть' : 'Опубликовать'} общий HTML «${version.originalName}», версия #${versionId}, для всех менеджеров по сопровождению?${version.format === 'route-planner-v1' ? '\n\nДля этой версии используется отдельный JSON-снимок. После публикации загрузите его ниже, если он ещё не загружен.' : ''}\n\nЛичные дашборды и личные файлы менеджеров сохранятся.`)) return;
    await mutate('/shared/publish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId, expectedActiveVersionId: shared.activeHtmlVersionId }),
    }, `Общий HTML ${rollback ? 'восстановлен' : 'опубликован'} для всех менеджеров по сопровождению.`);
  }

  async function deleteSharedHtml(versionId: number) {
    if (busy || mutationRef.current || !shared || versionId === shared.activeHtmlVersionId) return;
    const version = shared.htmlVersions.find((item) => item.id === versionId);
    if (!version) return;
    const consequence = version.format === 'route-planner-v1'
      ? 'Вместе с этим HTML будут удалены все привязанные к нему JSON-снимки, включая архивные. Удаление необратимо: для восстановления потребуются повторная загрузка исходного HTML и его JSON. Действующий общий HTML и его текущий JSON, а также личные дашборды сохранятся.'
      : 'Удаление необратимо: вернуть версию можно только повторной загрузкой исходного файла. Действующий общий HTML, общий файл данных и личные дашборды сохранятся.';
    if (!window.confirm(`Удалить общий HTML «${version.originalName}», версия #${versionId}?\n\n${consequence}`)) return;
    const result = await mutate(`/shared/html?id=${versionId}`, { method: 'DELETE' }, `Общий HTML «${version.originalName}» удалён.`);
    if (result) setPreviewSelection((current) => current?.audience === 'support-shared' && current.versionId === versionId ? null : current);
  }

  async function uploadSharedSnapshot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || mutationRef.current) return;
    const file = sharedSnapshotInput.current?.files?.[0];
    if (!file) return;
    const email = sharedEmailInput.current?.value.trim() ?? '';
    setSharedError('');
    if (!/\.ktsp$/i.test(file.name) || file.size === 0 || file.size > MAX_SNAPSHOT_BYTES) {
      setSharedError('Нужен непустой общий файл .ktsp размером до 8 МБ.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setSharedError('Укажите email получателя, использованный при создании общего файла.');
      return;
    }
    if (!window.confirm(`Опубликовать общий файл «${file.name}» для ВСЕХ менеджеров по сопровождению?\n\nОн заменит текущий общий файл данных. Личные дашборды и личные файлы всех менеджеров сохранятся.`)) return;
    const form = new FormData();
    form.append('file', file);
    form.append('email', email);
    form.append('expectedActiveSnapshotId', String(shared?.snapshot?.id ?? null));
    form.append('confirmShared', 'true');
    const result = await mutate('/shared/snapshots', { method: 'POST', body: form }, 'Общий файл опубликован для всех менеджеров по сопровождению.');
    if (result && sharedSnapshotInput.current) sharedSnapshotInput.current.value = '';
  }

  async function uploadSharedJson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || mutationRef.current || !sharedUsesJson || !sharedActiveHtml) return;
    const file = sharedJsonInput.current?.files?.[0];
    if (!file) return;
    setSharedError('');
    if (!window.confirm(`Опубликовать JSON «${file.name}» для ВСЕХ менеджеров по сопровождению?\n\nHTML: «${sharedActiveHtml.originalName}», версия #${sharedActiveHtml.id}.\nОн заменит текущий общий JSON этой версии. Предыдущий файл сохранится, личные дашборды не изменятся.`)) return;
    // Hold the same guard while compressing, not only while the request runs.
    mutationRef.current = true;
    setPending(true);
    try {
      setSharedJsonProgress('Подготавливаем JSON к загрузке…');
      const body = await prepareSharedJsonUpload(file);
      setSharedJsonProgress('Загружаем и проверяем JSON… Не закрывайте страницу.');
      const result = await performMutation('/shared/json', {
        method: 'POST', body,
        headers: {
          'Content-Type': 'application/gzip',
          'X-KTS-Shared-Version': String(sharedActiveHtml.id),
          'X-KTS-Shared-Expected-Snapshot': String(shared?.jsonSnapshot?.id ?? null),
          'X-KTS-Shared-Filename': encodeURIComponent(file.name),
          'X-KTS-Shared-Confirm': 'true',
        },
      }, 'Общий JSON опубликован для всех менеджеров по сопровождению. При открытии общего дашборда он загрузится автоматически.');
      if (result && sharedJsonInput.current) sharedJsonInput.current.value = '';
    } catch (cause) {
      setSharedError(cause instanceof Error ? cause.message : 'Не удалось подготовить или загрузить JSON. Проверьте текущую версию перед повторной попыткой.');
    } finally {
      mutationRef.current = false;
      setPending(false);
      setSharedJsonProgress('');
    }
  }

  return (
    <div className={styles.stack}>
      <div ref={audienceGrid} className={styles.audienceGrid}>
        {AUDIENCES.map((audience) => {
          const group = overview.groups.find((item) => item.audience === audience);
          const label = PERSONAL_DASHBOARD_AUDIENCE_LABELS[audience];
          return (
            <section key={audience} id={`manager-dashboard-group-${audience}`} className={styles.audienceColumn} aria-labelledby={`manager-dashboard-heading-${audience}`}>
              <h2 id={`manager-dashboard-heading-${audience}`} className={styles.audienceHeading}><span className={styles.equalHeightContent} data-dashboard-equal-row="heading">{label}</span></h2>
              {!group ? <div className={styles.panel}><p className={styles.empty}>Не удалось получить настройки этой группы. Обновите страницу.</p></div> : <>
                <section id={`manager-dashboard-html-panel-${audience}`} className={`${styles.panel} ${styles.htmlPanel}`} aria-label={`HTML: ${label}`}>
                  <div className={styles.equalHeightContent} data-dashboard-equal-row="html">
                  <div className={styles.sectionHeading}>
                    <div><h3>Личный HTML дашборда</h3><p>HTML для личных отчётов этой группы. Каждый менеджер открывает свой файл данных.</p></div>
                    <span className={styles.badge}>{group.activeHtmlVersionId ? `Опубликована версия #${group.activeHtmlVersionId}` : 'Пока не опубликован'}</span>
                  </div>
                  <form className={styles.uploadForm} onSubmit={(event) => void uploadHtml(event, audience)}>
                    <label htmlFor={`manager-dashboard-html-${audience}`}>Новая версия HTML · до 5 МБ</label>
                    <div className={styles.actions}>
                      <input ref={htmlInputs[audience]} id={`manager-dashboard-html-${audience}`} type="file" accept=".html,.htm,text/html" required disabled={busy} aria-invalid={!!fileErrors[audience]} aria-describedby={fileErrors[audience] ? `manager-dashboard-html-error-${audience}` : undefined} />
                      <button className={styles.primary} type="submit" disabled={busy}>Загрузить черновик</button>
                    </div>
                    {fileErrors[audience] ? <p id={`manager-dashboard-html-error-${audience}`} className={styles.warning} role="alert">{fileErrors[audience]}</p> : null}
                  </form>
                  {group.htmlVersions.length === 0 ? <p className={styles.empty}>Для этой группы HTML ещё не загружен. Загрузите HTML и опубликуйте версию. Предпросмотр доступен по желанию.</p> : (
                    <div className={styles.tableScroll}>
                      <table className={`${styles.table} ${styles.groupTable} ${styles.versionsTable}`}>
                        <thead><tr><th scope="col">Версия / загружена, МСК</th><th scope="col">Состояние</th><th scope="col">Действия</th></tr></thead>
                        <tbody>{group.htmlVersions.map((version) => {
                          const previewed = previewSelection?.audience === audience && previewSelection.versionId === version.id;
                          return (
                            <tr key={version.id}>
                              <td><strong>{version.originalName}</strong><small>#{version.id} · {Math.ceil(version.fileSize / 1024)} КБ</small><small>{formatDashboardDate(version.createdAt)}</small></td>
                              <td>{version.id === group.activeHtmlVersionId ? 'Опубликована' : version.id === group.previousHtmlVersionId ? 'Предыдущая' : version.firstPublishedAt ? 'Архив' : 'Черновик'}</td>
                              <td><div className={styles.actions}>
                                <button className={styles.secondary} type="button" disabled={busy} aria-controls="manager-dashboard-html-preview" aria-expanded={previewed} onClick={() => showPreview(audience, version.id)}>Предпросмотр</button>
                                {version.id !== group.activeHtmlVersionId ? (
                                  <button className={styles.primary} type="button" disabled={busy} onClick={() => void publish(audience, version.id)}>{version.id === group.previousHtmlVersionId ? 'Вернуть группе' : 'Опубликовать группе'}</button>
                                ) : null}
                                <button className={styles.danger} type="button" disabled={busy || version.id === group.activeHtmlVersionId}
                                  aria-label={`Удалить HTML «${version.originalName}», версия #${version.id}, ${label}`}
                                  title={version.id === group.activeHtmlVersionId ? 'Сначала опубликуйте другую HTML-версию этой группы' : undefined}
                                  onClick={() => void deleteHtml(audience, version.id)}>Удалить</button>
                              </div></td>
                            </tr>
                          );
                        })}</tbody>
                      </table>
                      <p className={styles.muted}>Действующую HTML-версию удалить нельзя — сначала опубликуйте другую. Удаление остальных версий не затрагивает личные снимки.</p>
                    </div>
                  )}
                  </div>
                </section>

                <section id={`manager-dashboard-files-${audience}`} className={styles.panel} aria-label={`Личные файлы: ${label}`}>
                  <div className={styles.sectionHeading}><div><h3>Личные файлы группы</h3><p>Загружайте снимки вручную ниже. Файлы назначаются менеджерам по email получателя.</p></div><span className={styles.badge}>Менеджеров: {group.managers.length}</span></div>
                  <div className={styles.tableScroll}>
                    <table className={`${styles.table} ${styles.groupTable}`}>
                      <thead><tr><th scope="col">Менеджер / email для сопоставления</th><th scope="col">Личный снимок</th></tr></thead>
                      <tbody>{group.managers.map((manager) => (
                        <tr key={manager.id}>
                          <td><strong>{manager.name}</strong><small>{manager.email || 'Email не указан'}</small>{manager.isActive === false ? <small>Учётная запись отключена</small> : null}{manager.bindingStatus === 'ambiguous'
                            ? <p className={styles.warning}>Email совпадает у нескольких менеджеров. Исправьте его в карточках, чтобы назначать файлы автоматически.</p>
                            : manager.isActive !== false && (manager.bindingStatus === 'unknown' || !manager.email)
                              ? <p className={styles.warning}>Для назначения файла нужен уникальный email в карточке менеджера.</p> : null}</td>
                          <td><SnapshotStatus snapshot={manager.snapshot} status={manager.snapshotStatus} expectedIssuedAfter={overview.expectedIssuedAfter} />{manager.snapshot ? <><small>{manager.snapshot.originalName}</small><small>Подготовлен: {formatDashboardDate(manager.snapshot.issued)} · до {formatDashboardDate(manager.snapshot.expires)} (МСК)</small></> : null}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                    {group.managers.length === 0 ? <p className={styles.empty}>В этой группе менеджеры ещё не добавлены.</p> : null}
                  </div>
                </section>
              </>}
            </section>
          );
        })}
      </div>

      <section id="manager-dashboard-shared-support" className={styles.panel} aria-labelledby="manager-dashboard-shared-management-heading">
        <div className={styles.sectionHeading}>
          <div><h2 id="manager-dashboard-shared-management-heading">Общий HTML дашборда</h2><p>Дополнительный отчёт для всех менеджеров по сопровождению: отдельный HTML и один общий файл данных.</p></div>
          <span className={styles.badge}>{shared?.activeHtmlVersionId ? `Опубликована версия #${shared.activeHtmlVersionId}` : 'Пока не опубликован'}</span>
        </div>
        <form className={styles.uploadForm} onSubmit={(event) => void uploadSharedHtml(event)}>
          <label htmlFor="manager-dashboard-shared-html">Новая версия общего HTML · до 5 МБ</label>
          <div className={styles.actions}>
            <input ref={sharedHtmlInput} id="manager-dashboard-shared-html" type="file" accept=".html,.htm,text/html" required disabled={busy} />
            <button className={styles.primary} type="submit" disabled={busy}>Загрузить общий HTML</button>
          </div>
          <p className={styles.muted}>Поддерживаются HTML компоновщика рейсов с JSON-снимком и прежний формат с .ktsp. Сначала опубликуйте HTML, затем загрузите соответствующий файл данных ниже.</p>
        </form>
        {(shared?.htmlVersions.length ?? 0) > 0 ? <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead><tr><th scope="col">Версия / загружена, МСК</th><th scope="col">Состояние</th><th scope="col">Действия</th></tr></thead>
            <tbody>{shared!.htmlVersions.map((version) => {
              const previewed = sharedPreview && previewSelection.versionId === version.id;
              return <tr key={version.id}>
                <td><strong>{version.originalName}</strong><small>#{version.id} · {Math.ceil(version.fileSize / 1024)} КБ · {version.format === 'route-planner-v1' ? 'Компоновщик · JSON' : 'Парольный .ktsp'}</small><small>{formatDashboardDate(version.createdAt)}</small></td>
                <td>{version.id === shared?.activeHtmlVersionId ? 'Опубликована' : version.id === shared?.previousHtmlVersionId ? 'Предыдущая' : version.firstPublishedAt ? 'Архив' : 'Черновик'}</td>
                <td><div className={styles.actions}>
                  <button className={styles.secondary} type="button" disabled={busy} aria-controls="manager-dashboard-html-preview" aria-expanded={previewed} onClick={() => showSharedPreview(version.id)}>Предпросмотр общего HTML</button>
                  {version.id !== shared?.activeHtmlVersionId ? <button className={styles.primary} type="button" disabled={busy} onClick={() => void publishShared(version.id)}>{version.id === shared?.previousHtmlVersionId ? 'Вернуть общий HTML' : 'Опубликовать общий HTML'}</button> : null}
                  <button className={styles.danger} type="button" disabled={busy || version.id === shared?.activeHtmlVersionId}
                    aria-label={`Удалить общий HTML «${version.originalName}», версия #${version.id}`}
                    title={version.id === shared?.activeHtmlVersionId ? 'Сначала опубликуйте другую версию общего HTML' : undefined}
                    onClick={() => void deleteSharedHtml(version.id)}>Удалить</button>
                </div></td>
              </tr>;
            })}</tbody>
          </table>
          <p className={styles.muted}>Действующую версию общего HTML удалить нельзя — сначала опубликуйте другую.{shared?.htmlVersions.some((version) => version.format === 'route-planner-v1') ? ' При удалении неактивного HTML компоновщика удаляются и все JSON-снимки, привязанные к этой версии.' : ''}</p>
        </div> : <p className={styles.empty}>Общий HTML ещё не загружен. Загрузите файл и опубликуйте версию. Предпросмотр доступен по желанию.</p>}
        {sharedUsesJson ? <div className={styles.preview}>
          <div className={styles.sectionHeading}><div><h3>Общий файл данных JSON</h3><p>Один снимок компоновщика автоматически открывается у всех менеджеров по сопровождению. Email и пароль не нужны. Личные .ktsp не изменяются.</p></div><span className={styles.badge} data-status={shared?.jsonSnapshot ? 'current' : 'missing'}>{shared?.jsonSnapshot ? 'Данные получены' : 'Данные ещё не поступили'}</span></div>
          {shared?.jsonSnapshot ? <dl className={styles.metadata}>
            <div><dt>Текущий общий файл</dt><dd>{shared.jsonSnapshot.originalName}</dd></div>
            <div><dt>Подготовлен, МСК</dt><dd>{formatDashboardDate(shared.jsonSnapshot.savedAt)}</dd></div>
            <div><dt>Загружен, МСК</dt><dd>{formatDashboardDate(shared.jsonSnapshot.receivedAt)}</dd></div>
          </dl> : null}
          <form className={styles.uploadForm} onSubmit={(event) => void uploadSharedJson(event)}>
            <label htmlFor="manager-dashboard-shared-json">JSON-снимок компоновщика · до 100 МБ</label>
            <div className={styles.actions}>
              <input ref={sharedJsonInput} id="manager-dashboard-shared-json" type="file" accept=".json,application/json" required disabled={busy} aria-describedby="manager-dashboard-shared-json-help" />
              <button className={styles.primary} type="submit" disabled={busy}>Опубликовать общий JSON</button>
            </div>
            <p id="manager-dashboard-shared-json-help" className={styles.muted}>Для HTML «{sharedActiveHtml.originalName}», версия #{sharedActiveHtml.id}. Файл сжимается перед отправкой: до 16 МБ после сжатия. Публикация происходит только после проверки; предыдущая версия данных сохраняется.</p>
            {sharedJsonProgress ? <p className={styles.notice} role="status">{sharedJsonProgress}</p> : null}
          </form>
        </div> : <div className={styles.preview}>
          <div className={styles.sectionHeading}><div><h3>Общий файл данных .ktsp</h3><p>Один файл открывается у всех менеджеров по сопровождению. Личные файлы остаются в личных дашбордах.</p></div><SnapshotStatus snapshot={shared?.snapshot ?? null} /></div>
          {shared?.snapshot ? <dl className={styles.metadata}>
            <div><dt>Текущий общий файл</dt><dd>{shared.snapshot.originalName}</dd></div>
            <div><dt>Подготовлен, МСК</dt><dd>{formatDashboardDate(shared.snapshot.issued)}</dd></div>
            <div><dt>Доступ до, МСК</dt><dd>{formatDashboardDate(shared.snapshot.expires)}</dd></div>
          </dl> : null}
          <form className={styles.uploadForm} onSubmit={(event) => void uploadSharedSnapshot(event)}>
            <label htmlFor="manager-dashboard-shared-email">Email получателя общего файла</label>
            <input ref={sharedEmailInput} id="manager-dashboard-shared-email" type="email" autoComplete="off" required disabled={busy} defaultValue={shared?.snapshot?.email ?? ''} aria-describedby="manager-dashboard-shared-email-help" />
            <p id="manager-dashboard-shared-email-help" className={styles.muted}>Укажите email, использованный при создании этого .ktsp. Пароль от файла вводится только внутри дашборда при просмотре.</p>
            <label htmlFor="manager-dashboard-shared-snapshot">Общий файл .ktsp · до 8 МБ</label>
            <div className={styles.actions}>
              <input ref={sharedSnapshotInput} id="manager-dashboard-shared-snapshot" type="file" accept=".ktsp" required disabled={busy} />
              <button className={styles.primary} type="submit" disabled={busy}>Опубликовать общий файл</button>
            </div>
          </form>
        </div>}
        {sharedError ? <p className={styles.warning} role="alert">{sharedError}</p> : null}
      </section>

      {preview && (previewGroup || sharedPreview) ? <section id="manager-dashboard-html-preview" ref={previewPanel} className={`${styles.panel} ${styles.fullWidthPreview}`} aria-labelledby="manager-dashboard-preview-heading" tabIndex={-1}>
        <div className={styles.sectionHeading}><div><h2 id="manager-dashboard-preview-heading">Предпросмотр: {sharedPreview ? 'Общий дашборд сопровождения' : PERSONAL_DASHBOARD_AUDIENCE_LABELS[previewGroup!.audience]}</h2><p>{preview.originalName} · версия #{preview.id}. {sharedJsonPreview ? 'Общий JSON, привязанный к этой версии HTML, загружается автоматически, если он опубликован. Личные данные менеджеров не загружаются.' : sharedPreview ? 'Общие и личные данные не загружаются.' : 'Личные данные менеджеров не загружаются.'}</p></div><button className={styles.secondary} type="button" disabled={busy} onClick={() => {
          if (busy || mutationRef.current) return;
          setPreviewSelection(null);
          (sharedPreview ? sharedHtmlInput : htmlInputs[previewGroup!.audience]).current?.focus();
        }}>Закрыть</button></div>
        {sharedPreview ? <SharedDashboardFrame key={`shared:${preview.id}`} versionId={preview.id} revision={sharedPreviewRevision} preview />
          : <DashboardFrame key={`${previewGroup!.audience}:${preview.id}`} audience={previewGroup!.audience} versionId={preview.id} preview />}
      </section> : null}

      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div><h2>Общая загрузка личных файлов</h2><p>Ручная загрузка личных файлов для обеих групп. В одном пакете можно смешивать .ktsp менеджеров по развитию и сопровождению: получатель определяется по email, указанному при создании файла, а группа — по его роли в системе.</p></div>
        </div>
        <form className={styles.uploadForm} onSubmit={(event) => void uploadSnapshots(event)}>
          <label htmlFor="manager-dashboard-snapshots">Ручная загрузка · до 32 файлов, 8 МБ на файл и 63 МБ суммарно</label>
          <div className={styles.actions}>
            <input ref={snapshotInput} id="manager-dashboard-snapshots" type="file" accept=".ktsp" multiple required disabled={busy} />
            <button className={styles.primary} type="submit" disabled={busy}>Загрузить файлы</button>
          </div>
        </form>
        <ImportResults results={results} title="Результат последней операции" />
      </section>

      <ManagerDashboardImportJournal key={JSON.stringify([overview.imports, overview.importsNextCursor])}
        imports={overview.imports} nextCursor={overview.importsNextCursor} busy={busy} onAccessDenied={onAccessDenied} />
    </div>
  );
}
