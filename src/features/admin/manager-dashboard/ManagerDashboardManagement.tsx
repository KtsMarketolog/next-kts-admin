import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { PERSONAL_DASHBOARD_AUDIENCE_LABELS, type PersonalDashboardAudience } from '@/shared/lib/managerDashboardAudience';

import { DashboardFrame, formatDashboardDate, ImportResults, SnapshotStatus } from './ManagerDashboardParts';
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
};

export function ManagerDashboardManagement({ overview, busy: externalBusy, mutate: performMutation }: ManagementProps) {
  const [audience, setAudience] = useState<PersonalDashboardAudience>('development');
  const [pending, setPending] = useState(false);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [fileError, setFileError] = useState('');
  const [results, setResults] = useState<ManagerDashboardImport[]>([]);
  const htmlInput = useRef<HTMLInputElement>(null);
  const snapshotInput = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Partial<Record<PersonalDashboardAudience, HTMLButtonElement | null>>>({});
  const mutationRef = useRef(false);
  const busy = externalBusy || pending;
  const group = overview.groups.find((item) => item.audience === audience);
  const label = PERSONAL_DASHBOARD_AUDIENCE_LABELS[audience];
  const preview = group?.htmlVersions.find((version) => version.id === previewId);

  async function mutate(path: string, init: RequestInit, successMessage: string) {
    // The ref closes the event-to-render gap: a fast tab click must not move an
    // in-flight upload/preview callback into a different audience.
    if (busy || mutationRef.current) return null;
    mutationRef.current = true;
    setPending(true);
    try { return await performMutation(path, init, successMessage); }
    finally { mutationRef.current = false; setPending(false); }
  }

  function selectAudience(next: PersonalDashboardAudience) {
    if (busy || mutationRef.current || next === audience) return;
    setAudience(next);
    setPreviewId(null);
    setFileError('');
    if (htmlInput.current) htmlInput.current.value = '';
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, current: PersonalDashboardAudience) {
    if (busy || mutationRef.current) return;
    const index = AUDIENCES.indexOf(current);
    const next = event.key === 'Home' ? AUDIENCES[0] : event.key === 'End' ? AUDIENCES[AUDIENCES.length - 1]
      : event.key === 'ArrowRight' ? AUDIENCES[(index + 1) % AUDIENCES.length]
        : event.key === 'ArrowLeft' ? AUDIENCES[(index + AUDIENCES.length - 1) % AUDIENCES.length] : null;
    if (!next) return;
    event.preventDefault();
    selectAudience(next);
    tabRefs.current[next]?.focus();
  }

  async function uploadHtml(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || mutationRef.current || !group) return;
    const file = htmlInput.current?.files?.[0];
    if (!file) return;
    setFileError('');
    if (!/\.html?$/i.test(file.name) || file.size === 0 || file.size > MAX_HTML_BYTES) {
      setFileError('Выберите непустой HTML-файл размером до 5 МБ.');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    const result = await mutate(`/html?audience=${audience}`, { method: 'POST', body: form }, `HTML для группы «${label}» загружен как черновик. Проверьте предпросмотр перед публикацией.`);
    if (result) {
      if (htmlInput.current) htmlInput.current.value = '';
      if (result.version?.audience === audience) setPreviewId(result.version.id);
    }
  }

  async function publish(versionId: number) {
    if (busy || mutationRef.current || !group) return;
    const version = group.htmlVersions.find((item) => item.id === versionId);
    if (!version) return;
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
      <div className={styles.audienceTabs} role="tablist" aria-label="Группа менеджеров" aria-orientation="horizontal">
        {AUDIENCES.map((item) => <button
          key={item}
          ref={(node) => { tabRefs.current[item] = node; }}
          id={`manager-dashboard-tab-${item}`}
          className={styles.audienceTab}
          type="button"
          role="tab"
          aria-selected={audience === item}
          aria-controls="manager-dashboard-audience-panel"
          tabIndex={audience === item ? 0 : -1}
          disabled={busy}
          onClick={() => selectAudience(item)}
          onKeyDown={(event) => moveTab(event, item)}
        >{PERSONAL_DASHBOARD_AUDIENCE_LABELS[item]}</button>)}
      </div>
      <div id="manager-dashboard-audience-panel" className={styles.stack} role="tabpanel" aria-labelledby={`manager-dashboard-tab-${audience}`} tabIndex={0}>
      {!group ? <section className={styles.panel}><p className={styles.empty}>Не удалось получить настройки этой группы. Обновите страницу.</p></section> : <>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div><h2>HTML дашборда группы</h2><p>{label}: собственная опубликованная версия. HTML другой группы и личные данные обновляются отдельно.</p></div>
          <span className={styles.badge}>{group.activeHtmlVersionId ? `Опубликована версия #${group.activeHtmlVersionId}` : 'Пока не опубликован'}</span>
        </div>
        <form className={styles.uploadForm} onSubmit={(event) => void uploadHtml(event)}>
          <label htmlFor={`manager-dashboard-html-${audience}`}>Новая версия HTML · до 5 МБ</label>
          <div className={styles.actions}>
            <input key={audience} ref={htmlInput} id={`manager-dashboard-html-${audience}`} type="file" accept=".html,.htm,text/html" required disabled={busy} />
            <button className={styles.primary} type="submit" disabled={busy}>Загрузить черновик</button>
          </div>
          {fileError ? <p className={styles.warning} role="alert">{fileError}</p> : null}
        </form>
        {group.htmlVersions.length === 0 ? <p className={styles.empty}>Для этой группы HTML ещё не загружен. Загрузите HTML, откройте предпросмотр и опубликуйте проверенную версию.</p> : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead><tr><th scope="col">Версия</th><th scope="col">Загружена, МСК</th><th scope="col">Состояние</th><th scope="col">Действия</th></tr></thead>
              <tbody>{group.htmlVersions.map((version) => (
                <tr key={version.id}>
                  <td><strong>{version.originalName}</strong><small>#{version.id} · {Math.ceil(version.fileSize / 1024)} КБ</small></td>
                  <td>{formatDashboardDate(version.createdAt)}</td>
                  <td>{version.id === group.activeHtmlVersionId ? 'Опубликована' : version.id === group.previousHtmlVersionId ? 'Предыдущая' : version.firstPublishedAt ? 'Архив' : 'Черновик'}</td>
                  <td><div className={styles.actions}>
                    <button className={styles.secondary} type="button" disabled={busy} onClick={() => setPreviewId(version.id)}>Предпросмотр</button>
                    {version.id !== group.activeHtmlVersionId ? (
                      <button className={styles.primary} type="button" disabled={busy || previewId !== version.id} title={previewId !== version.id ? 'Сначала откройте предпросмотр этой версии' : undefined} onClick={() => void publish(version.id)}>{version.id === group.previousHtmlVersionId ? 'Вернуть группе' : 'Опубликовать группе'}</button>
                    ) : null}
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {preview ? <div className={styles.preview}>
          <div className={styles.sectionHeading}><div><h3>Предпросмотр: {preview.originalName}</h3><p>{label}. В предпросмотре HTML личные данные менеджеров не загружаются.</p></div><button className={styles.secondary} type="button" disabled={busy} onClick={() => setPreviewId(null)}>Закрыть</button></div>
          <DashboardFrame audience={audience} versionId={preview.id} preview />
        </div> : null}
      </section>

      <section className={styles.panel}>
        <div className={styles.sectionHeading}><div><h2>Личные файлы группы</h2><p>{label}. Снимки назначаются автоматически из общей почты или ручной загрузки ниже.</p></div></div>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead><tr><th scope="col">Менеджер</th><th scope="col">Email для сопоставления</th><th scope="col">Данные</th><th scope="col">Подготовлены / доступны до, МСК</th></tr></thead>
            <tbody>{group.managers.map((manager) => (
              <tr key={manager.id}>
                <td><strong>{manager.name}</strong>{manager.isActive === false ? <small>Учётная запись отключена</small> : null}</td>
                <td>{manager.email || 'Email не указан'}{manager.bindingStatus === 'ambiguous'
                  ? <p className={styles.warning}>Email совпадает у нескольких менеджеров. Исправьте его в карточках, чтобы назначать файлы автоматически.</p>
                  : manager.isActive !== false && (manager.bindingStatus === 'unknown' || !manager.email)
                    ? <p className={styles.warning}>Для назначения файла нужен уникальный email в карточке менеджера.</p> : null}</td>
                <td><SnapshotStatus snapshot={manager.snapshot} status={manager.snapshotStatus} expectedIssuedAfter={overview.expectedIssuedAfter} />{manager.snapshot ? <small>{manager.snapshot.originalName}</small> : null}</td>
                <td>{manager.snapshot ? <>{formatDashboardDate(manager.snapshot.issued)}<small>до {formatDashboardDate(manager.snapshot.expires)}</small></> : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
          {group.managers.length === 0 ? <p className={styles.empty}>В этой группе менеджеры ещё не добавлены.</p> : null}
        </div>
      </section>
      </>}
      </div>

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

      <section className={styles.panel}>
        <h2>Журнал импорта</h2>
        {overview.imports.length === 0 ? <p className={styles.empty}>Загрузок пока не было.</p> : <ImportResults results={overview.imports} title="Последние файлы" />}
      </section>
    </div>
  );
}
