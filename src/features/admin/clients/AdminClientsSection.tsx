'use client';

import styles from '@/app/admin/admin.module.scss';
import { AdminClientCompanyCard } from './AdminClientCompanyCard';
import { AdminClientCreateForm } from './AdminClientCreateForm';
import { AdminClientDeletionDialog } from './AdminClientDeletionDialog';
import { toDraft, type AdminClientsSectionProps } from './AdminClientsModel';
import { useAdminClientOperations } from './useAdminClientOperations';
import { useAdminClientDrafts } from './useAdminClientDrafts';
import { useAdminClientList } from './useAdminClientList';
import { useAdminClientEditing } from './useAdminClientEditing';
import { useAdminClientLifecycle } from './useAdminClientLifecycle';

export function AdminClientsSection({ onBack, draftScope, onNavigationStateChange }: AdminClientsSectionProps) {
  const operations = useAdminClientOperations();
  const { busy, status, cancelAll } = operations;
  const editor = useAdminClientDrafts({ draftScope, onNavigationStateChange, busy });
  const { draft, setDraft, companyDrafts, clientPasswordEditIds, clientPasswordDrafts, setClientPasswordDrafts,
    companyConflicts, setCompanyConflicts, expandedCompanyIds, savedCompanyId, scope, hasUnsaved, passwordPending,
    updateCompanyDraft, toggleCompanyExpanded, toggleClientPasswordEdit } = editor;
  const list = useAdminClientList(operations, editor);
  const { companies, loading, canPermanentlyDelete, managers, developmentManagers, supportManagers, selectScope, refreshClients } = list;
  const { createCompany, saveCompany, loadCompanyConflict, applyCompanyConflict } = useAdminClientEditing(operations, editor, list);
  const { archiveCompany, restoreCompany, previewPermanentDeletion, permanentlyDeleteCompany,
    deletionPreview, setDeletionPreview, deletionError } = useAdminClientLifecycle(operations, editor, list);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Личный кабинет</p>
          <h2>Клиенты</h2>
        </div>
        <button className={styles.secondary} disabled={busy} onClick={refreshClients}>
          Обновить список
        </button>
        {busy ? <button className={styles.secondary} onClick={cancelAll}>Отменить ожидание</button> : null}
        <button className={styles.secondary} onClick={onBack}>
          Вернуться в панель управления
        </button>
      </div>

      {status ? <p role="status" className={`${styles.status} ${styles.clientSectionStatus}`}>{status}</p> : null}

      {hasUnsaved ? <p role="status" className={styles.draftNotice}>
        <strong>Есть несохранённые изменения.</strong>{' '}
        {draftScope ? 'Обычные поля сохранятся при переходах между разделами в этой вкладке, но ещё не записаны на сервер.' : 'Перед уходом сохраните нужные карточки.'}{' '}
        При обновлении страницы, закрытии вкладки или выходе из учётной записи черновики потеряются.
        {passwordPending ? ' Введённые пароли при уходе не сохраняются — после возврата введите их заново.' : ''}
      </p> : null}

      <div className={styles.userRoleTabs} aria-label="Список клиентов">
        <button type="button" aria-pressed={scope === 'active'} disabled={busy} onClick={() => selectScope('active')}>Клиенты</button>
        <button type="button" aria-pressed={scope === 'archived'} disabled={busy} onClick={() => selectScope('archived')}>Архив</button>
      </div>
      {scope === 'archived' ? <p className={styles.mutedText}>Данные и файлы хранятся в архиве до явного ручного удаления администратором, без автоматического удаления по сроку. Восстановление не включает доступ в кабинет. Публичные ссылки на прайсы не отключаются архивированием, заявки по ним могут продолжать поступать.</p> : null}

      {scope === 'active' ? <AdminClientCreateForm
        draft={draft}
        developmentManagers={developmentManagers}
        supportManagers={supportManagers}
        busy={busy || loading}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        onCreate={createCompany}
      /> : null}

      <div className={styles.clientCompanyList}>
        {loading ? <p className={styles.mutedText}>Загружаем список клиентов...</p> : companies.length === 0 ? <p className={styles.mutedText}>{scope === 'archived' ? 'Архив пуст.' : 'Клиенты пока не добавлены.'}</p> : null}
        {companies.map((company) => (
          <AdminClientCompanyCard
            key={company.id}
            company={company}
            currentDraft={companyDrafts[company.id] ?? toDraft(company)}
            passwordIsEdited={Boolean(clientPasswordEditIds[company.id])}
            passwordDraft={clientPasswordDrafts[company.id] || ''}
            developmentManagers={developmentManagers}
            supportManagers={supportManagers}
            busy={busy || loading}
            isExpanded={Boolean(expandedCompanyIds[company.id])}
            isSaved={savedCompanyId === company.id}
            canPermanentlyDelete={canPermanentlyDelete}
            conflict={companyConflicts[company.id] ?? (companyDrafts[company.id]?.expectedUpdatedAt && companyDrafts[company.id].expectedUpdatedAt !== company.updatedAt ? { comparison: null, error: '' } : null)}
            managers={managers}
            onLoadConflict={loadCompanyConflict}
            onCloseConflict={(id) => setCompanyConflicts((conflicts) => ({ ...conflicts, [id]: { comparison: null, error: '' } }))}
            onResolveConflict={applyCompanyConflict}
            onDraftChange={updateCompanyDraft}
            onToggleExpanded={toggleCompanyExpanded}
            onTogglePasswordEdit={toggleClientPasswordEdit}
            onPasswordDraftChange={(id, value) => setClientPasswordDrafts((current) => ({ ...current, [id]: value }))}
            onSave={saveCompany}
            onArchive={archiveCompany}
            onRestore={restoreCompany}
            onPermanentDelete={previewPermanentDeletion}
          />
        ))}
      </div>
      {deletionPreview ? <AdminClientDeletionDialog key={`${deletionPreview.id}:${deletionPreview.revision}`} preview={deletionPreview}
        busy={busy} error={deletionError} onCancel={() => setDeletionPreview(null)} onConfirm={permanentlyDeleteCompany} /> : null}
    </section>
  );
}
