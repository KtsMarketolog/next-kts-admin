import { useEffect, useRef, useState, type FormEvent } from 'react';

import { PERSONAL_DASHBOARD_AUDIENCE_LABELS, type PersonalDashboardAudience } from '@/shared/lib/managerDashboardAudience';

import { DashboardFrame, formatDashboardDate, ImportResults, SnapshotStatus } from './ManagerDashboardParts';
import { ManagerDashboardImportJournal } from './ManagerDashboardImportJournal';
import type { ManagerDashboardImport, ManagerDashboardMutationResult, ManagerDashboardOverview } from './types';
import styles from './ManagerDashboard.module.scss';

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
// Leave room for multipart headers inside the server's 64 MiB request limit.
const MAX_BATCH_FILE_BYTES = 63 * 1024 * 1024;
const AUDIENCES: PersonalDashboardAudience[] = ['development', 'support'];

type ManagementProps = {
  overview: Extract<ManagerDashboardOverview, { mode: 'manage' }>;
  busy: boolean;
  mutate: (path: string, init: RequestInit, successMessage: string) => Promise<ManagerDashboardMutationResult | null>;
  onAccessDenied?: () => void;
};

export function ManagerDashboardManagement({ overview, busy: externalBusy, mutate: performMutation, onAccessDenied }: ManagementProps) {
  const [pending, setPending] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<{ audience: PersonalDashboardAudience; versionId: number } | null>(null);
  const [fileErrors, setFileErrors] = useState<Partial<Record<PersonalDashboardAudience, string>>>({});
  const [results, setResults] = useState<ManagerDashboardImport[]>([]);
  const developmentHtmlInput = useRef<HTMLInputElement>(null);
  const supportHtmlInput = useRef<HTMLInputElement>(null);
  const htmlInputs = { development: developmentHtmlInput, support: supportHtmlInput };
  const snapshotInput = useRef<HTMLInputElement>(null);
  const previewPanel = useRef<HTMLElement>(null);
  const audienceGrid = useRef<HTMLDivElement>(null);
  const mutationRef = useRef(false);
  const busy = externalBusy || pending;
  const previewGroup = overview.groups.find((item) => item.audience === previewSelection?.audience);
  const preview = previewGroup?.htmlVersions.find((version) => version.id === previewSelection?.versionId);

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
    const result = await mutate(`/html?audience=${audience}`, { method: 'POST', body: form }, `HTML для группы «${label}» загружен как черновик. Проверьте предпросмотр перед публикацией.`);
    if (result) {
      // Never clear the other group's selection or infer a recipient from it.
      if (input) input.value = '';
      if (result.version?.audience === audience) setPreviewSelection({ audience, versionId: result.version.id });
    }
  }

  async function publish(audience: PersonalDashboardAudience, versionId: number) {
    const group = overview.groups.find((item) => item.audience === audience);
    if (busy || mutationRef.current || !group) return;
    if (previewSelection?.audience !== audience || previewSelection.versionId !== versionId) return;
    const version = group.htmlVersions.find((item) => item.id === versionId);
    if (!version) return;
    const label = PERSONAL_DASHBOARD_AUDIENCE_LABELS[audience];
    const isRollback = versionId === group.previousHtmlVersionId;
    if (!window.confirm(`${isRollback ? 'Вернуть' : 'Опубликовать'} HTML «${version.originalName}», версия #${versionId}, для группы «${label}»?\n\nHTML другой группы и личные файлы данных менеджеров сохранятся.`)) return;
    await mutate('/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience, versionId, expectedActiveVersionId: group.activeHtmlVersionId }),
    }, `HTML ${isRollback ? 'восстановлен' : 'опубликован'} для группы «${label}».`);
  }

  async function uploadSnapshots(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || mutationRef.current) return;
    const files = Array.from(snapshotInput.current?.files ?? []);
    if (files.length === 0) return;
    const rejected: ManagerDashboardImport[] = [];
    const form = new FormData();
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
    if (accepted.length > 32 || accepted.reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_FILE_BYTES) {
      setResults([...rejected, { originalName: 'Пакет файлов', status: 'rejected', message: 'Выберите не более 32 подходящих файлов и до 63 МБ суммарно. Разделите большую загрузку на несколько пакетов.' }]);
      return;
    }
    accepted.forEach((file) => form.append('files', file));
    const result = await mutate('/snapshots', { method: 'POST', body: form }, 'Обработка файлов завершена. Результат каждого файла указан ниже.');
    if (result) {
      setResults([...rejected, ...(result.results ?? [])]);
      if (snapshotInput.current) snapshotInput.current.value = '';
    }
  }

  async function checkEmail() {
    if (busy || mutationRef.current) return;
    setResults([]);
    const result = await mutate('/check-email', { method: 'POST' }, 'Проверка почты завершена.');
    if (result) setResults(result.results ?? []);
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
                    <div><h3>HTML дашборда</h3><p>Собственный HTML этой группы. Публикация не меняет дашборд другой группы.</p></div>
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
                  {group.htmlVersions.length === 0 ? <p className={styles.empty}>Для этой группы HTML ещё не загружен. Загрузите HTML, откройте предпросмотр и опубликуйте проверенную версию.</p> : (
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
                                  <button className={styles.primary} type="button" disabled={busy || !previewed} title={!previewed ? 'Сначала откройте предпросмотр этой версии' : undefined} onClick={() => void publish(audience, version.id)}>{version.id === group.previousHtmlVersionId ? 'Вернуть группе' : 'Опубликовать группе'}</button>
                                ) : null}
                              </div></td>
                            </tr>
                          );
                        })}</tbody>
                      </table>
                    </div>
                  )}
                  </div>
                </section>

                <section id={`manager-dashboard-files-${audience}`} className={styles.panel} aria-label={`Личные файлы: ${label}`}>
                  <div className={styles.sectionHeading}><div><h3>Личные файлы группы</h3><p>Снимки назначаются автоматически из общей почты или ручной загрузки ниже.</p></div><span className={styles.badge}>Менеджеров: {group.managers.length}</span></div>
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

      {preview && previewGroup ? <section id="manager-dashboard-html-preview" ref={previewPanel} className={`${styles.panel} ${styles.fullWidthPreview}`} aria-labelledby="manager-dashboard-preview-heading" tabIndex={-1}>
        <div className={styles.sectionHeading}><div><h2 id="manager-dashboard-preview-heading">Предпросмотр: {PERSONAL_DASHBOARD_AUDIENCE_LABELS[previewGroup.audience]}</h2><p>{preview.originalName} · версия #{preview.id}. Личные данные менеджеров не загружаются.</p></div><button className={styles.secondary} type="button" disabled={busy} onClick={() => {
          if (busy || mutationRef.current) return;
          setPreviewSelection(null);
          htmlInputs[previewGroup.audience].current?.focus();
        }}>Закрыть</button></div>
        <DashboardFrame key={`${previewGroup.audience}:${preview.id}`} audience={previewGroup.audience} versionId={preview.id} preview />
      </section> : null}

      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div><h2>Общая загрузка личных файлов</h2><p>Почта и ручная загрузка общие для обеих групп. В одном письме или пакете можно смешивать .ktsp менеджеров по развитию и сопровождению: получатель определяется по email, указанному при создании файла, а группа — по его роли в системе.</p></div>
          <button className={styles.secondary} type="button" disabled={busy || !overview.mail.enabled || !overview.mail.configured} onClick={() => void checkEmail()}>Проверить почту сейчас</button>
        </div>
        <p className={styles.muted}>{!overview.mail.configured ? 'Почтовый импорт ещё не настроен.' : !overview.mail.enabled ? 'Почтовый импорт выключен.' : 'Почтовый импорт включён.'}{overview.expectedBy ? ` Ежедневное обновление — к ${overview.expectedBy}.` : ''}</p>
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
