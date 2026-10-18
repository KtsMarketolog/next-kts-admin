'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { CurrencyDashboardHtmlState } from '@/shared/lib/db/currencyDashboardHtmlRepo';
import { adminRequest, ADMIN_UPLOAD_TIMEOUT_MS, runWithRequestTimeout } from '@/features/admin/shared/adminRequest';

import styles from './CurrencyHtmlManagement.module.scss';

const ENDPOINT = '/api/admin/currency-dashboard/html';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const dates = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });
type Operation = 'load' | 'upload' | 'publish' | 'rollback';
type RequestDetails = { file?: File; versionId?: number; revision?: number };

function fileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.ceil(bytes / 1024))} КБ`;
}

export function CurrencyHtmlManagement({ onPublished, renderPreview }: {
  onPublished: () => void | Promise<void>;
  renderPreview: (versionId: number) => ReactNode;
}) {
  const [data, setData] = useState<CurrencyDashboardHtmlState | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [previewChecked, setPreviewChecked] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [visibleCount, setVisibleCount] = useState(10);
  const activeRequest = useRef<AbortController | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const publicationCallback = useRef(onPublished);
  useEffect(() => { publicationCallback.current = onPublished; }, [onPublished]);

  const request = useCallback(async (operation: Operation, details: RequestDetails = {}) => {
    // A ref also blocks a second click before React has rendered disabled buttons.
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const current = () => activeRequest.current === controller;
    setBusy(operation);
    setError('');
    setNotice('');
    let confirmed = false;
    try {
      const body = operation === 'upload' ? new FormData() : undefined;
      if (body && details.file) body.append('file', details.file);
      const response = await adminRequest(ENDPOINT, {
        method: operation === 'load' ? 'GET' : operation === 'upload' ? 'POST' : 'PATCH',
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(operation === 'publish' || operation === 'rollback' ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: operation, expectedRevision: details.revision, ...(operation === 'publish' ? { versionId: details.versionId } : {}) }),
        } : { body }),
      }, { timeoutMs: operation === 'upload' ? ADMIN_UPLOAD_TIMEOUT_MS : undefined });
      const result = await response.json();
      if (!current()) return;
      if (response.status === 401 || response.status === 403) {
        setForbidden(true);
        setData(null);
        setPreviewId(null);
        setError('Управление версиями недоступно. Проверьте вход и права администратора.');
        return;
      }
      if (response.status === 409 && result.code === 'CURRENCY_HTML_CONFLICT') {
        setPreviewChecked(false);
        setConfirmRollback(false);
        setUncertain(true);
        const fresh = await adminRequest(ENDPOINT, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!current()) return;
        if (fresh.status === 401 || fresh.status === 403) {
          setForbidden(true);
          setData(null);
          setPreviewId(null);
          setError('Управление версиями недоступно. Проверьте вход и права администратора.');
          return;
        }
        if (fresh.ok) {
          const overview = await fresh.json();
          if (!current()) return;
          setData(overview);
          setUncertain(false);
          setError('Версию уже изменил другой администратор. Список обновлён. Проверьте актуальную версию и повторно подтвердите публикацию.');
        } else {
          setError('Версию уже изменил другой администратор. Не удалось обновить список — нажмите «Обновить версии» перед повторной попыткой.');
        }
        return;
      }
      if (!response.ok) {
        confirmed = response.status < 500;
        throw new Error(typeof result.error === 'string' ? result.error : 'Не удалось выполнить запрос.');
      }
      if (!Array.isArray(result.versions) || !Number.isSafeInteger(result.revision)) {
        throw new Error('Сервер вернул неполный ответ.');
      }
      confirmed = true;
      setData(result);
      setUncertain(false);
      setForbidden(false);
      setConfirmRollback(false);
      if (operation === 'load') setPreviewChecked(false);
      if (operation === 'upload') {
        setFile(null);
        if (uploadInput.current) uploadInput.current.value = '';
        setPreviewId(Number.isSafeInteger(result.version?.id) ? result.version.id : null);
        setPreviewChecked(false);
        setNotice('Черновик загружен. Проверьте его ниже и подтвердите публикацию. Действующий дашборд пока не изменён.');
      } else if (operation !== 'load') {
        setPreviewId(null);
        setPreviewChecked(false);
        const success = operation === 'publish' ? 'Новая HTML-версия опубликована.' : 'Предыдущая HTML-версия восстановлена.';
        setNotice(`${success} Общие данные дашборда сохранены.`);
        // Do not call a failed screen refresh a failed publication or encourage a retry.
        try { await runWithRequestTimeout(async () => publicationCallback.current(), { signal: controller.signal }); }
        catch { if (current()) setNotice(`${success} Не удалось обновить просмотр. Перезагрузите страницу; повторная публикация не нужна.`); }
      }
    } catch (cause) {
      if (!current()) return;
      if (operation !== 'load' && !confirmed) {
        setUncertain(true);
        setPreviewChecked(false);
        setConfirmRollback(false);
        setError('Не удалось подтвердить результат запроса: соединение прервано или сервер не ответил. Изменение могло сохраниться. Обновите список версий перед повторной отправкой.');
      } else {
        setError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : 'Не удалось загрузить версии. Проверьте соединение и повторите попытку.');
      }
    } finally {
      if (current()) {
        activeRequest.current = null;
        setBusy(null);
      }
    }
  }, []);

  useEffect(() => {
    void request('load');
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [request]);

  const active = data?.versions.find((version) => version.id === data.activeVersionId);
  const previous = data?.versions.find((version) => version.id === data.previousVersionId);
  const preview = data?.versions.find((version) => version.id === previewId);
  const canChange = Boolean(data) && !busy && !uncertain && !forbidden;
  const selectPreview = (id: number) => { setPreviewId(id); setPreviewChecked(false); setConfirmRollback(false); };
  const upload = () => {
    if (!file || !canChange) return;
    if (!/\.html?$/i.test(file.name)) { setError('Выберите HTML-файл с расширением .html или .htm.'); return; }
    if (!file.size || file.size > MAX_FILE_BYTES) { setError('HTML-файл должен быть непустым и не больше 2 МБ.'); return; }
    void request('upload', { file });
  };

  return <section className={styles.root} aria-label="Управление HTML-версиями курсов валют" aria-busy={Boolean(busy)}>
    <div className={styles.heading}>
      <div><span className={styles.eyebrow}>Обновление дашборда</span><h2>HTML-версии курсов валют</h2></div>
      <button type="button" disabled={Boolean(busy) || forbidden} onClick={() => void request('load')}>{busy === 'load' ? 'Обновляем…' : 'Обновить версии'}</button>
    </div>
    <p className={styles.description}>Загрузите новый HTML, проверьте предпросмотр и опубликуйте его. Сотрудники продолжат видеть действующую версию до публикации. Общие данные и права доступа не заменяются.</p>
    {active && <p className={styles.current}><span className={styles.activeBadge}>Опубликована</span> <strong>{active.originalName}</strong>{active.sourceVersion && <span>{active.sourceVersion}</span>}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {!forbidden && <>
      <div className={styles.upload}>
        <label className={styles.file}><span>Новый HTML-файл</span><input ref={uploadInput} type="file" accept=".html,.htm,text/html" disabled={!canChange} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(''); }} /></label>
        <button className={styles.primary} type="button" disabled={!canChange || !file} onClick={upload}>{busy === 'upload' ? 'Загружаем…' : 'Загрузить черновик'}</button>
        {busy === 'upload' && <button type="button" onClick={() => activeRequest.current?.abort()}>Прервать загрузку</button>}
      </div>
      <p className={styles.hint}>До 2 МБ. Новый файл проходит проверку совместимости. Ошибка в HTML, недоступный внешний источник или неподдерживаемая функция могут потребовать исправления самого файла; предпросмотр не изменяет общие данные.</p>
      {preview && <section className={styles.preview} aria-label="Предпросмотр HTML-версии">
        <div className={styles.heading}><div><h3>Предпросмотр: {preview.originalName}</h3><p className={styles.hint}>Проверьте внешний вид, вкладки, расчёты и обновление данных. Сохранение общих данных в предпросмотре отключено.</p></div><button type="button" disabled={Boolean(busy)} onClick={() => { setPreviewId(null); setPreviewChecked(false); }}>Закрыть предпросмотр</button></div>
        <div className={styles.previewFrame} key={preview.id}>{renderPreview(preview.id)}</div>
        {preview.id !== data?.activeVersionId && <div className={styles.publish}>
          <label className={styles.confirm}><input type="checkbox" checked={previewChecked} disabled={!canChange} onChange={(event) => setPreviewChecked(event.target.checked)} /><span>Проверил предпросмотр и хочу показать эту версию сотрудникам</span></label>
          <button className={styles.primary} type="button" disabled={!canChange || !previewChecked} onClick={() => void request('publish', { versionId: preview.id, revision: data?.revision })}>{busy === 'publish' ? 'Публикуем…' : 'Опубликовать эту версию'}</button>
        </div>}
      </section>}
      {data && <div className={styles.history}>
        <div className={styles.heading}><h3>История HTML-версий</h3>{previous && <button type="button" disabled={!canChange} onClick={() => setConfirmRollback(true)}>Вернуть предыдущую версию</button>}</div>
        {confirmRollback && previous && <div className={styles.rollback}>
          <p>Восстановить <strong>{previous.originalName}</strong> для всех сотрудников? Текущая HTML-версия останется в истории. Это не откат общих данных.</p>
          <div className={styles.actions}><button type="button" className={styles.primary} disabled={!canChange} onClick={() => void request('rollback', { revision: data.revision })}>{busy === 'rollback' ? 'Восстанавливаем…' : 'Подтвердить восстановление'}</button><button type="button" disabled={Boolean(busy)} onClick={() => setConfirmRollback(false)}>Отмена</button></div>
        </div>}
        <ul className={styles.versions}>{data.versions.slice(0, visibleCount).map((version) => <li key={version.id}>
          <div className={styles.versionInfo}><strong>{version.originalName}</strong><span>{version.sourceVersion} · {fileSize(version.fileSize)} · {Number.isFinite(Date.parse(version.createdAt)) ? `${dates.format(new Date(version.createdAt))} МСК` : 'Дата не указана'}{version.createdBy ? ` · ${version.createdBy}` : ''}</span></div>
          <span className={version.id === data.activeVersionId ? styles.activeBadge : styles.badge}>{version.id === data.activeVersionId ? 'Опубликована' : version.id === data.previousVersionId ? 'Предыдущая' : 'Сохранена'}</span>
          <button type="button" disabled={Boolean(busy) || uncertain} onClick={() => selectPreview(version.id)}>{previewId === version.id ? 'Предпросмотр открыт' : 'Предпросмотр'}</button>
        </li>)}</ul>
        {data.versions.length > visibleCount && <button type="button" onClick={() => setVisibleCount((count) => count + 10)}>Показать ещё версии</button>}
        {!data.versions.length && <p className={styles.hint}>Загруженных HTML-версий пока нет.</p>}
      </div>}
    </>}
  </section>;
}
