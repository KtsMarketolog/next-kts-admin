import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PersonalSnapshotReplacementPreview, PersonalSnapshotReplacementFile } from '@/shared/lib/managerDashboardSnapshotReplacement';
import { formatDashboardTimestamp } from '@/shared/lib/dashboardDates';
import { formatDashboardDate, ImportResults } from './ManagerDashboardParts';
import type { ManagerDashboardGroup, ManagerDashboardImport, ManagerDashboardMutationResult } from './types';
import styles from './ManagerDashboard.module.scss';
import replacementStyles from './PersonalSnapshotReplacement.module.scss';

type Props = {
  groups: ManagerDashboardGroup[];
  busy: boolean;
  mutate: (path: string, init: RequestInit, message: string) => Promise<ManagerDashboardMutationResult | null>;
};

function FileDetails({ title, file }: { title: string; file: PersonalSnapshotReplacementFile }) {
  return <section className={replacementStyles.file} aria-label={title}>
    <h4>{title}</h4><strong>{file.originalName}</strong>
    <dl>
      <div><dt>Данные на</dt><dd>{formatDashboardDate(file.issued)}</dd></div>
      <div><dt>Доступ до</dt><dd>{formatDashboardDate(file.expires)}</dd></div>
      <div><dt>Размер</dt><dd>{new Intl.NumberFormat('ru-RU').format(file.fileSize)} байт</dd></div>
      {file.receivedAt && <div><dt>Загружен, МСК</dt><dd>{formatDashboardTimestamp(file.receivedAt)}</dd></div>}
    </dl>
    <details className={replacementStyles.digest}><summary>Контрольная сумма SHA-256</summary><code>{file.sha256}</code></details>
  </section>;
}

/** Explicit single-file confirmation. Ordinary bulk/mail imports never silently replace the same date. */
export function PersonalSnapshotReplacement({ groups, busy, mutate }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const comparison = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PersonalSnapshotReplacementPreview | null>(null);
  const [error, setError] = useState('');
  const [results, setResults] = useState<ManagerDashboardImport[]>([]);
  const [recipientKey, setRecipientKey] = useState('');
  const disabled = busy || pending;
  const recipients = groups.flatMap(group => group.managers).filter(manager => manager.previousSnapshot && manager.snapshot && manager.isActive !== false);
  const selectedRecipient = recipients.find(manager => `${manager.source ?? 'manager'}:${manager.id}` === recipientKey);

  useEffect(() => { if (preview) comparison.current?.focus({ preventScroll: true }); }, [preview]);

  async function send(form: FormData, message: string) {
    if (disabled || inFlight.current) return null;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      const result = await mutate('/snapshots/replacement', { method: 'POST', body: form }, message);
      if (!result) setError('Операция не подтверждена. Проверьте сообщение об ошибке выше. При изменении снимка другим администратором выполните проверку заново.');
      return result;
    } catch {
      setError('Не удалось получить ответ. Повторите подтверждение: одна и та же операция не будет выполнена дважды.');
      return null;
    } finally { inFlight.current = false; setPending(false); }
  }

  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (disabled || !file) return;
    setResults([]); setPreview(null);
    if (!/\.ktsp$/i.test(file.name) || file.size === 0 || file.size > 8 * 1024 * 1024) {
      setError('Выберите непустой личный файл .ktsp размером до 8 МБ.'); return;
    }
    const form = new FormData(); form.set('action', 'prepare'); form.set('file', file);
    const result = await send(form, 'Файл проверен. Действующий снимок пока не изменён.');
    if (result?.preview) setPreview(result.preview);
  }

  async function prepareRollback() {
    if (disabled || !selectedRecipient) return;
    setResults([]); setPreview(null);
    const form = new FormData(); form.set('action', 'prepare-rollback');
    form.set('recipientSource', selectedRecipient.source ?? 'manager'); form.set('recipientId', String(selectedRecipient.id));
    const result = await send(form, 'Откат подготовлен для подтверждения. Действующий снимок пока не изменён.');
    if (result?.preview) setPreview(result.preview);
  }

  async function confirm() {
    if (disabled || !preview || (preview.action === 'replace' && !file)) return;
    const form = new FormData(); form.set('action', preview.action === 'replace' ? 'confirm' : 'confirm-rollback');
    form.set('token', preview.token); form.set('confirmed', 'true');
    if (preview.action === 'replace' && file) form.set('file', file);
    const result = await send(form, preview.action === 'replace' ? 'Личный снимок заменён. Предыдущий файл сохранён для отката.' : 'Предыдущий личный снимок восстановлен.');
    if (result && !result.preview) {
      setResults(result.results ?? []); setPreview(null); setFile(null);
      if (input.current) input.current.value = '';
    }
  }

  return <section id="personal-snapshot-replacement" className={styles.panel} aria-labelledby="personal-snapshot-replacement-heading">
    <div className={styles.sectionHeading}><div><h2 id="personal-snapshot-replacement-heading">Замена личного снимка и откат</h2>
      <p>Исправленный .ktsp за ту же дату заменяется только после проверки и вашего подтверждения. Сотрудник определяется по получателю внутри файла. Пароль снимка вводить не нужно.</p></div></div>
    <form className={styles.uploadForm} onSubmit={event => void prepare(event)}>
      <label htmlFor="personal-snapshot-replacement-file">Исправленный личный .ktsp · до 8 МБ</label>
      <div className={styles.actions}><input ref={input} id="personal-snapshot-replacement-file" type="file" accept=".ktsp" required disabled={disabled}
        onChange={event => { setFile(event.currentTarget.files?.[0] ?? null); setPreview(null); setError(''); setResults([]); }} />
        <button type="submit" className={styles.secondary} disabled={disabled || !file}>Проверить замену</button></div>
    </form>
    {recipients.length > 0 && <div className={styles.uploadForm}>
      <label htmlFor="personal-snapshot-rollback-recipient">Восстановить предыдущий снимок сотрудника</label>
      <div className={styles.actions}><select id="personal-snapshot-rollback-recipient" value={recipientKey} disabled={disabled}
        onChange={event => { setRecipientKey(event.target.value); setPreview(null); setError(''); setResults([]); }}>
        <option value="">Выберите сотрудника</option>
        {recipients.map(manager => <option key={`${manager.source ?? 'manager'}:${manager.id}`} value={`${manager.source ?? 'manager'}:${manager.id}`}>{manager.name} · {manager.email}</option>)}
      </select><button type="button" className={styles.secondary} disabled={disabled || !selectedRecipient} onClick={() => void prepareRollback()}>Проверить откат</button></div>
    </div>}
    {error && <p className={styles.warning} role="alert">{error}</p>}
    {preview && <div ref={comparison} className={replacementStyles.confirmation} tabIndex={-1} aria-label="Подтверждение изменения личного снимка">
      <h3>{preview.action === 'replace' ? 'За эту дату уже есть снимок. Заменить его?' : 'Вернуть предыдущий личный снимок?'}</h3>
      <p><strong>{preview.recipient.name}</strong> · {preview.recipient.email}</p>
      <div className={replacementStyles.comparison}><FileDetails title="Сейчас действует" file={preview.current} />
        <FileDetails title={preview.action === 'replace' ? 'Будет загружен' : 'Будет восстановлен'} file={preview.incoming} /></div>
      <p className={styles.notice}>Новый выбор станет действующим, текущий снимок сохранится как предыдущий. Хранятся две рабочие версии; более старый резервный снимок при новой загрузке будет заменён. HTML и файлы других сотрудников не меняются. Изменение записывается в журнал.</p>
      {preview.action === 'replace' && preview.previous && <p className={styles.muted}>Будет удалена только более старая резервная версия: «{preview.previous.originalName}», данные на {formatDashboardDate(preview.previous.issued)}. Текущий файл останется для отката.</p>}
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={disabled} onClick={() => void confirm()}>
        {preview.action === 'replace' ? 'Подтвердить замену' : 'Подтвердить откат'}</button>
        <button type="button" className={styles.secondary} disabled={disabled} onClick={() => { setPreview(null); setError(''); }}>Отмена</button></div>
    </div>}
    <ImportResults results={results} title="Результат замены / отката" />
  </section>;
}
