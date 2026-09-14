'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { FIRMWARE_FILES, MAX_FIRMWARE_STORAGE_BYTES, type FirmwareKind, type FirmwareOverview, type FirmwareVersion } from '@/shared/lib/firmwareContract';

type Selection = { file: File; sha256: string | null; error: string | null };
type Pair = Record<FirmwareKind, Selection | null>;
type Props = { showStatus: (message: string) => void };

export function validateFirmwareFileSelection(file: Pick<File, 'name' | 'size'>, kind: FirmwareKind) {
  if (!file.name.toLowerCase().endsWith(`.${kind}`)) return `Выберите файл .${kind}`;
  if (file.size <= 0) return 'Файл пустой';
  if (file.size > FIRMWARE_FILES[kind].maxBytes) return kind === 'c23' ? 'Файл .c23 превышает 25 МиБ' : 'Файл .ver превышает 4 КиБ';
  return null;
}

export function firmwarePairReady(pair: Pair) {
  return (['c23', 'ver'] as const).every((kind) => {
    const selected = pair[kind];
    return selected && !selected.error && /^[a-f\d]{64}$/.test(selected.sha256 ?? '')
      && !validateFirmwareFileSelection(selected.file, kind);
  });
}

export function firmwarePublishForm(pair: Pair, expectedRevision: string) {
  if (!expectedRevision || !firmwarePairReady(pair)) throw new Error('Выберите и проверьте оба файла');
  const form = new FormData();
  form.append('action', 'publish');
  form.append('expectedRevision', expectedRevision);
  for (const kind of ['c23', 'ver'] as const) {
    form.append(kind, pair[kind]!.file);
    form.append(`${kind}Sha256`, pair[kind]!.sha256!);
  }
  return form;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} КиБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МиБ`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function FirmwareVersionDetails({ title, version }: { title: string; version: FirmwareVersion | null }) {
  return <div style={{ minWidth: 0 }}>
    <h3>{title}</h3>
    {!version ? <p>Нет сохранённой пары файлов</p> : <>
      <p>{version.versionLabel ? `Версия: ${version.versionLabel}` : 'Версия не указана'}
        {formatDate(version.createdAt) ? ` · ${formatDate(version.createdAt)}` : ''}</p>
      {(['c23', 'ver'] as const).map((kind) => <div key={kind} style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
        <span>{version.files[kind].fileName} · {formatFileSize(version.files[kind].size)}</span>
        <details><summary>SHA256</summary><code>{version.files[kind].sha256}</code></details>
      </div>)}
    </>}
  </div>;
}

function isOverview(data: unknown): data is FirmwareOverview {
  if (!data || typeof data !== 'object') return false;
  const item = data as FirmwareOverview;
  if (typeof item.revision !== 'string' || !item.revision || !Number.isFinite(item.storageBytes)) return false;
  return [item.current, item.previous].every((version) => version === null || (
    version && typeof version.id === 'string' && typeof version.createdAt === 'string'
    && (version.versionLabel === null || typeof version.versionLabel === 'string')
    && (['c23', 'ver'] as const).every((kind) => {
      const file = version.files?.[kind];
      return file && typeof file.fileName === 'string' && typeof file.url === 'string'
        && Number.isFinite(file.size) && typeof file.sha256 === 'string' && /^[a-f\d]{64}$/.test(file.sha256);
    })
  ));
}

async function responseError(response: Response, fallback: string) {
  const data = await response.json().catch(() => null);
  return data && typeof data.error === 'string' ? data.error : fallback;
}

export function AdminFirmwareSection({ showStatus }: Props) {
  const [overview, setOverview] = useState<FirmwareOverview | null>(null);
  const [pair, setPair] = useState<Pair>({ c23: null, ver: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'publish' | 'rollback' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mustRefresh, setMustRefresh] = useState(false);
  const inputRefs = useRef<Partial<Record<FirmwareKind, HTMLInputElement | null>>>({});
  const selectionSequence = useRef({ c23: 0, ver: 0 });
  const loadSequence = useRef(0);
  const actionInFlight = useRef(false);
  const mounted = useRef(true);

  const loadFirmware = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++loadSequence.current;
    const response = await fetch('/api/admin/firmware', { cache: 'no-store', signal });
    if (!response.ok) throw new Error(await responseError(response, 'Не удалось загрузить состояние прошивки'));
    const data: unknown = await response.json();
    if (!isOverview(data)) throw new Error('Сервер вернул некорректное состояние прошивки');
    if (mounted.current && sequence === loadSequence.current) {
      setOverview(data);
      setMustRefresh(false);
    }
    return data;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void loadFirmware(controller.signal).catch((caught: unknown) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Не удалось загрузить состояние прошивки');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [loadFirmware]);

  const selectFile = async (kind: FirmwareKind, file: File | undefined) => {
    const sequence = ++selectionSequence.current[kind];
    const validationError = file ? validateFirmwareFileSelection(file, kind) : null;
    setPair((current) => ({ ...current, [kind]: file ? { file, sha256: null, error: validationError } : null }));
    if (!file || validationError) return;
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (mounted.current && selectionSequence.current[kind] === sequence) {
        setPair((current) => ({ ...current, [kind]: { file, sha256, error: null } }));
      }
    } catch {
      if (mounted.current && selectionSequence.current[kind] === sequence) {
        setPair((current) => ({ ...current, [kind]: { file, sha256: null, error: 'Не удалось вычислить SHA256. Откройте админку по HTTPS и выберите файл снова.' } }));
      }
    }
  };

  const refresh = async () => {
    if (actionInFlight.current || loading) return;
    setLoading(true);
    setError(null);
    try { await loadFirmware(); }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'Не удалось обновить состояние'); }
    finally { if (mounted.current) setLoading(false); }
  };

  const perform = async (action: 'publish' | 'rollback', event?: FormEvent) => {
    event?.preventDefault();
    if (actionInFlight.current || loading || mustRefresh || !overview) return;
    if (action === 'publish' && !firmwarePairReady(pair)) return;
    if (action === 'rollback' && !overview.previous) return;
    const confirmation = action === 'publish'
      ? `Опубликовать пару файлов по постоянным адресам?\n\n${(['c23', 'ver'] as const).map((kind) => `${pair[kind]!.file.name} · ${formatFileSize(pair[kind]!.file.size)}\nSHA256: ${pair[kind]!.sha256}`).join('\n\n')}\n\nПредыдущая пара останется доступна для отката.`
      : `Восстановить предыдущую пару${overview.previous?.versionLabel ? ` (${overview.previous.versionLabel})` : ''}?\nОба файла по постоянным адресам будут переключены вместе.`;
    if (!window.confirm(confirmation)) return;
    actionInFlight.current = true;
    loadSequence.current++; // A GET started before this action cannot overwrite its result.
    setBusy(action);
    setError(null);
    try {
      const response = await fetch('/api/admin/firmware', action === 'publish'
        ? { method: 'POST', body: firmwarePublishForm(pair, overview.revision) }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, expectedRevision: overview.revision, previousId: overview.previous!.id }) });
      if (!response.ok) {
        const message = await responseError(response, 'Не удалось выполнить операцию');
        if (response.status === 409) {
          try { await loadFirmware(); }
          catch { if (mounted.current) setMustRefresh(true); }
        } else if (response.status >= 500 && mounted.current) setMustRefresh(true);
        if (mounted.current) setError(response.status === 409 ? `${message}. Проверьте актуальное состояние перед повторным подтверждением. Выбранные файлы сохранены.` : message);
        return;
      }
      const data: unknown = await response.json();
      if (!isOverview(data)) throw new Error('Unconfirmed operation');
      if (!mounted.current) return;
      loadSequence.current++;
      setOverview(data);
      setMustRefresh(false);
      if (action === 'publish') {
        selectionSequence.current.c23++;
        selectionSequence.current.ver++;
        setPair({ c23: null, ver: null });
        for (const kind of ['c23', 'ver'] as const) if (inputRefs.current[kind]) inputRefs.current[kind]!.value = '';
      }
      showStatus(action === 'publish' ? 'Пара файлов прошивки опубликована' : 'Предыдущая пара прошивки восстановлена');
    } catch {
      if (mounted.current) {
        setMustRefresh(true);
        setError('Не удалось подтвердить результат операции. Обновите состояние и проверьте версию и SHA256 перед повторной отправкой.');
      }
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const disabled = Boolean(busy) || loading || mustRefresh || !overview;
  return <section className={styles.section} aria-busy={loading || Boolean(busy)}>
    <div className={styles.sectionHeader}>
      <div><p>Прошивки</p><h2>Публикация пары файлов</h2></div>
      <button type="button" className={styles.secondary} onClick={() => void refresh()} disabled={loading || Boolean(busy)}>
        {loading ? 'Загрузка…' : 'Обновить состояние'}
      </button>
    </div>
    <p>Файлы .c23 и .ver публикуются вместе. Постоянные адреса загрузки не меняются. SHA256 проверяет целостность файла, но не его совместимость с устройством.</p>
    {error && <p role="alert">{error}</p>}
    {mustRefresh && <p>Перед следующим действием нажмите «Обновить состояние».</p>}
    {overview && <>
      <div className={styles.catalogImportCard} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))' }}>
        <FirmwareVersionDetails title="Текущая пара" version={overview.current} />
        <FirmwareVersionDetails title="Предыдущая пара" version={overview.previous} />
      </div>
      <p>Хранилище: {formatFileSize(overview.storageBytes)} из {formatFileSize(MAX_FIRMWARE_STORAGE_BYTES)}.</p>
    </>}
    <div style={{ marginBottom: 20 }}>
      {(['c23', 'ver'] as const).map((kind) => <p key={kind}>
        <a className={styles.firmwareFileUrl} href={FIRMWARE_FILES[kind].url} target="_blank" rel="noreferrer">{FIRMWARE_FILES[kind].url}</a>
      </p>)}
    </div>
    <form onSubmit={(event) => void perform('publish', event)}>
      {(['c23', 'ver'] as const).map((kind) => <div className={styles.catalogImportCard} key={kind} style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
        <div><h3>{FIRMWARE_FILES[kind].fileName}</h3><p>Максимум: {kind === 'c23' ? '25 МиБ' : '4 КиБ'}</p></div>
        <label className={styles.fileInput}>
          {pair[kind]?.file.name || `Выбрать файл .${kind}`}
          <input ref={(node) => { inputRefs.current[kind] = node; }} type="file" accept={`.${kind}`}
            aria-label={`Файл .${kind}`} disabled={Boolean(busy)}
            onChange={(event) => void selectFile(kind, event.target.files?.[0])} />
        </label>
        {pair[kind] && <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <span>{formatFileSize(pair[kind]!.file.size)}</span>
          {pair[kind]!.error ? <p role="alert">{pair[kind]!.error}</p>
            : pair[kind]!.sha256 ? <p>SHA256: <code>{pair[kind]!.sha256}</code></p> : <p role="status">Вычисление SHA256…</p>}
        </div>}
      </div>)}
      <button type="submit" disabled={disabled || !firmwarePairReady(pair)}>{busy === 'publish' ? 'Публикация…' : 'Опубликовать пару'}</button>
    </form>
    <div style={{ marginTop: 20 }}>
      <button type="button" className={styles.secondary} disabled={disabled || !overview?.previous} onClick={() => void perform('rollback')}>
        {busy === 'rollback' ? 'Восстановление…' : 'Восстановить предыдущую пару'}
      </button>
    </div>
  </section>;
}
