import { useRef, useState, type FormEvent } from 'react';

import { DashboardFrame, formatDashboardDate, ImportResults, SnapshotStatus } from './ManagerDashboardParts';
import type { ManagerDashboardImport, ManagerDashboardMutationResult, ManagerDashboardOverview } from './types';
import styles from './ManagerDashboard.module.scss';

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
// Leave room for multipart headers inside the server's 64 MiB request limit.
const MAX_BATCH_FILE_BYTES = 63 * 1024 * 1024;

type ManagementProps = {
  overview: Extract<ManagerDashboardOverview, { mode: 'manage' }>;
  busy: boolean;
  mutate: (path: string, init: RequestInit, successMessage: string) => Promise<ManagerDashboardMutationResult | null>;
};

export function ManagerDashboardManagement({ overview, busy, mutate }: ManagementProps) {
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [fileError, setFileError] = useState('');
  const [results, setResults] = useState<ManagerDashboardImport[]>([]);
  const htmlInput = useRef<HTMLInputElement>(null);
  const snapshotInput = useRef<HTMLInputElement>(null);
  const preview = overview.htmlVersions.find((version) => version.id === previewId);

  async function uploadHtml(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = htmlInput.current?.files?.[0];
    if (!file) return;
    setFileError('');
    if (!/\.html?$/i.test(file.name) || file.size === 0 || file.size > MAX_HTML_BYTES) {
      setFileError('Выберите непустой HTML-файл размером до 5 МБ.');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    const result = await mutate('/html', { method: 'POST', body: form }, 'HTML загружен как черновик. Проверьте предпросмотр перед публикацией.');
    if (result) {
      if (htmlInput.current) htmlInput.current.value = '';
      if (result.version) setPreviewId(result.version.id);
    }
  }

  async function publish(versionId: number) {
    const version = overview.htmlVersions.find((item) => item.id === versionId);
    if (!version) return;
    const isRollback = versionId === overview.previousHtmlVersionId;
    if (!window.confirm(`${isRollback ? 'Вернуть' : 'Опубликовать'} HTML «${version.originalName}», версия #${versionId}, для всех менеджеров по развитию?\n\nЛичные файлы данных менеджеров сохранятся.`)) return;
    await mutate('/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId, expectedActiveVersionId: overview.activeHtmlVersionId }),
    }, isRollback ? 'Предыдущая HTML-версия снова опубликована для менеджеров.' : 'HTML опубликован для всех менеджеров по развитию.');
  }

  async function uploadSnapshots(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    setResults([]);
    const result = await mutate('/check-email', { method: 'POST' }, 'Проверка почты завершена.');
    if (result) setResults(result.results ?? []);
  }

  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div><h2>Общий HTML дашборда</h2><p>Одна опубликованная версия для всех менеджеров по развитию. Данные обновляются отдельно.</p></div>
          <span className={styles.badge}>{overview.activeHtmlVersionId ? `Опубликована версия #${overview.activeHtmlVersionId}` : 'Пока не опубликован'}</span>
        </div>
        <form className={styles.uploadForm} onSubmit={(event) => void uploadHtml(event)}>
          <label htmlFor="manager-dashboard-html">Новая версия HTML · до 5 МБ</label>
          <div className={styles.actions}>
            <input ref={htmlInput} id="manager-dashboard-html" type="file" accept=".html,.htm,text/html" required disabled={busy} />
            <button className={styles.primary} type="submit" disabled={busy}>Загрузить черновик</button>
          </div>
          {fileError ? <p className={styles.warning} role="alert">{fileError}</p> : null}
        </form>
        {overview.htmlVersions.length === 0 ? <p className={styles.empty}>Загрузите HTML, откройте предпросмотр и опубликуйте проверенную версию.</p> : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead><tr><th scope="col">Версия</th><th scope="col">Загружена, МСК</th><th scope="col">Состояние</th><th scope="col">Действия</th></tr></thead>
              <tbody>{overview.htmlVersions.map((version) => (
                <tr key={version.id}>
                  <td><strong>{version.originalName}</strong><small>#{version.id} · {Math.ceil(version.fileSize / 1024)} КБ</small></td>
                  <td>{formatDashboardDate(version.createdAt)}</td>
                  <td>{version.id === overview.activeHtmlVersionId ? 'Опубликована' : version.id === overview.previousHtmlVersionId ? 'Предыдущая' : version.firstPublishedAt ? 'Архив' : 'Черновик'}</td>
                  <td><div className={styles.actions}>
                    <button className={styles.secondary} type="button" disabled={busy} onClick={() => setPreviewId(version.id)}>Предпросмотр</button>
                    {version.id !== overview.activeHtmlVersionId ? (
                      <button className={styles.primary} type="button" disabled={busy || previewId !== version.id} title={previewId !== version.id ? 'Сначала откройте предпросмотр этой версии' : undefined} onClick={() => void publish(version.id)}>{version.id === overview.previousHtmlVersionId ? 'Вернуть всем' : 'Опубликовать всем'}</button>
                    ) : null}
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {preview ? <div className={styles.preview}>
          <div className={styles.sectionHeading}><div><h3>Предпросмотр: {preview.originalName}</h3><p>В предпросмотре HTML личные данные менеджеров не загружаются.</p></div><button className={styles.secondary} type="button" onClick={() => setPreviewId(null)}>Закрыть</button></div>
          <DashboardFrame versionId={preview.id} preview />
        </div> : null}
      </section>

      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div><h2>Файлы менеджеров</h2><p>Загрузите несколько .ktsp за один раз. Получатель определяется автоматически по email, указанному при создании файла.</p></div>
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
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead><tr><th scope="col">Менеджер по развитию</th><th scope="col">Email для сопоставления</th><th scope="col">Данные</th><th scope="col">Подготовлены / доступны до, МСК</th></tr></thead>
            <tbody>{overview.managers.map((manager) => (
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
          {overview.managers.length === 0 ? <p className={styles.empty}>Менеджеры по развитию ещё не добавлены.</p> : null}
        </div>
      </section>

      <section className={styles.panel}>
        <h2>Журнал импорта</h2>
        {overview.imports.length === 0 ? <p className={styles.empty}>Загрузок пока не было.</p> : <ImportResults results={overview.imports} title="Последние файлы" />}
      </section>
    </div>
  );
}
