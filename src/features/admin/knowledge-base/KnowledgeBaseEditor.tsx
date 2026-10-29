'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import { ADMIN_UPLOAD_TIMEOUT_MS } from '@/features/admin/shared/adminRequest';
import type { KnowledgeBaseNode, KnowledgeBaseAccess } from '@/shared/lib/knowledgeBase';
import { KnowledgeBaseDialog } from './KnowledgeBaseDialog';
import { KnowledgeBaseAccessEditor } from './KnowledgeBaseAccessEditor';
import { KB_API, readKbResponse, kbSize } from './knowledge-base-ui';
import styles from './knowledge-base.module.scss';

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpg,.jpeg,.png,.webp,.gif,.html,.htm';
export function KnowledgeBaseEditor({ node, parentId, upload, onClose, onSaved }: {
  node?: KnowledgeBaseNode; parentId: number | null; upload?: boolean; onClose: () => void; onSaved: (message: string) => void;
}) {
  const [title, setTitle] = useState(node?.title ?? '');
  const [access, setAccess] = useState<KnowledgeBaseAccess>(node?.access ?? { mode: parentId ? 'inherit' : 'custom', actorKeys: [] });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), operation = useRef<string | null>(null);
  const signature = useRef('');
  const { request, isActive } = useAdminRequestScope();
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (pending.current) return;
    if (!title.trim()) { setError('Введите название.'); return; }
    if (upload && !file) { setError('Выберите файл.'); return; }
    if (file && (file.size === 0 || file.size > 25 * 1024 * 1024)) { setError('Выберите непустой файл размером не больше 25 МБ.'); return; }
    pending.current = true; setBusy(true); setError('');
    const nextSignature = JSON.stringify([title.trim(), access, parentId, file?.name, file?.size, file?.lastModified]);
    if (!operation.current || signature.current !== nextSignature) { operation.current = crypto.randomUUID(); signature.current = nextSignature; }
    try {
      let response: Response;
      if (upload && file) {
        const query = new URLSearchParams({ operationId: operation.current });
        if (parentId !== null) query.set('parentId', String(parentId));
        response = await request(`${KB_API}/upload?${query}`, { method: 'POST', body: file,
          headers: { 'Content-Type': 'application/octet-stream', 'X-KB-File-Name': encodeURIComponent(file.name),
            'X-KB-Title': encodeURIComponent(title.trim()), 'X-KB-Access': encodeURIComponent(JSON.stringify(access)) } }, { timeoutMs: ADMIN_UPLOAD_TIMEOUT_MS });
      } else {
        response = await request(node ? `${KB_API}/${node.id}` : KB_API, { method: node ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(node
            ? { expectedRevision: node.revision, title: title.trim(), access }
            : { operationId: operation.current, parentId, title: title.trim(), access }) });
      }
      const result = await readKbResponse<{ node: KnowledgeBaseNode; warning?: string }>(response);
      if (isActive()) onSaved([
        upload ? 'Файл загружен.' : node ? 'Изменения сохранены.' : 'Папка создана.',
        typeof result.warning === 'string' ? result.warning : '',
      ].filter(Boolean).join(' '));
    } catch (cause) { if (isActive()) setError(cause instanceof Error ? cause.message : 'Не удалось сохранить.'); }
    finally { pending.current = false; if (isActive()) setBusy(false); }
  };
  return <KnowledgeBaseDialog title={node ? 'Название и доступ' : upload ? 'Загрузить материал' : 'Новая папка'} onClose={onClose} busy={busy}>
    <form className={styles.modalBody} onSubmit={save}>
      {upload && <><label className={styles.field}>Файл<input type="file" accept={ACCEPT} disabled={busy} required onChange={(event) => {
        const next = event.target.files?.[0] ?? null; setFile(next); if (next) setTitle(next.name); operation.current = null;
      }} /></label><p className={styles.muted}>PDF, Word, Excel, PowerPoint, TXT, CSV, изображения и HTML. До 25 МБ. {file ? `Выбрано: ${kbSize(file.size)}.` : ''}</p>
        <p className={styles.muted}>HTML открывается изолированно. Встроенные стили и сценарии поддерживаются; внешние ресурсы, сетевые запросы и доступ к кабинету запрещены. Загрузите самодостаточный HTML.</p></>}
      <label className={styles.field}>Название<input value={title} maxLength={200} required disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
      <KnowledgeBaseAccessEditor value={access} onChange={setAccess} parentId={parentId} disabled={busy} />
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}><button type="button" disabled={busy} onClick={onClose}>Отмена</button>
        <button className={styles.primary} type="submit" disabled={busy}>{busy ? (upload ? 'Загружаем…' : 'Сохраняем…') : upload ? 'Загрузить файл' : 'Сохранить'}</button></div>
    </form>
  </KnowledgeBaseDialog>;
}
