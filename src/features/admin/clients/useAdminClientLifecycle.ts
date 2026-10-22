'use client';

import { useState } from 'react';
import { submitClientMutation } from './clientMutation';
import { archiveClientConfirmation, readClientDeletionPreview, readApiError, readApiErrorFallback, type ClientCompany, type ClientDeletionPreview } from './AdminClientsModel';
import type { AdminClientDraftState } from './useAdminClientDrafts';
import type { AdminClientListState } from './useAdminClientList';
import type { AdminClientOperations } from './useAdminClientOperations';

/** Archive, restore, and preview-confirmed deletion do not share ordinary edit requests. */
export function useAdminClientLifecycle(operations: AdminClientOperations, editor: AdminClientDraftState, list: AdminClientListState) {
  const { request, isActive, setStatus, startMutation, finishMutation } = operations;
  const { companyBaselines, replaceCompanyDrafts, replacePasswordEditIds, setClientPasswordDrafts, setCompanyConflicts, setExpandedCompanyIds } = editor;
  const { companiesRef, setCompanies, acceptSavedCompany, canPermanentlyDelete } = list;
  const [deletionPreview, setDeletionPreview] = useState<ClientDeletionPreview | null>(null);
  const [deletionError, setDeletionError] = useState('');

  const archiveCompany = async (company: ClientCompany) => {
    const confirmed = window.confirm(archiveClientConfirmation(company));
    if (!confirmed) return;

    if (!startMutation()) return;
    try {
      const result = await submitClientMutation(`/api/admin/clients/${company.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: company.updatedAt }),
      }, request);
      if (!isActive()) return;
      if (!result.company?.archivedAt) throw new Error('Не удалось подтвердить архивирование. Обновите список перед повторной попыткой.');
      companyBaselines.current.set(company.id, result.company);
      companiesRef.current = companiesRef.current.filter((item) => item.id !== company.id);
      setCompanies(companiesRef.current);
      setClientPasswordDrafts((current) => {
        const next = { ...current };
        delete next[company.id];
        return next;
      });
      replacePasswordEditIds((current) => {
        const next = { ...current };
        delete next[company.id];
        return next;
      });
      replaceCompanyDrafts((current) => {
        const next = { ...current };
        delete next[company.id];
        return next;
      });
      setCompanyConflicts((current) => { const next = { ...current }; delete next[company.id]; return next; });
      setExpandedCompanyIds((current) => {
        const next = { ...current };
        delete next[company.id];
        return next;
      });
      setStatus(['Клиент перенесён в архив. Данные и файлы сохранены, вход закрыт. Публичные ссылки на прайсы не отключены.', ...result.warnings].join(' '));
    } catch (error) {
      if (isActive()) setStatus(readApiErrorFallback(error, 'Не удалось подтвердить архивирование клиента'));
    } finally {
      finishMutation();
    }
  };

  const restoreCompany = async (company: ClientCompany) => {
    if (!window.confirm(`Восстановить клиента «${company.title || 'Без названия'}» из архива? Доступ останется отключённым. Включить его можно отдельно в карточке клиента после проверки данных.`)) return;
    if (!startMutation()) return;
    try {
      const result = await submitClientMutation(`/api/admin/clients/${company.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: company.updatedAt }),
      }, request);
      if (!isActive()) return;
      if (!result.company || result.company.archivedAt || result.company.isActive) throw new Error('Не удалось подтвердить восстановление. Обновите список перед повторной попыткой.');
      acceptSavedCompany(result.company);
      setStatus(['Клиент восстановлен. Он находится во вкладке «Клиенты», доступ остаётся отключённым.', ...result.warnings].join(' '));
    } catch (error) {
      if (isActive()) setStatus(readApiErrorFallback(error, 'Не удалось подтвердить восстановление клиента'));
    } finally {
      finishMutation();
    }
  };

  const previewPermanentDeletion = async (company: ClientCompany) => {
    if (!canPermanentlyDelete || !company.archivedAt || !startMutation()) return;
    setDeletionError('');
    try {
      const response = await request(`/api/admin/clients/${company.id}/deletion-preview`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось проверить состав удаляемых данных'));
      const data = await response.json();
      const preview = readClientDeletionPreview(data?.preview, company.id);
      if (isActive()) setDeletionPreview(preview);
    } catch (error) {
      if (isActive()) setStatus(readApiErrorFallback(error, 'Не удалось проверить состав удаляемых данных'));
    } finally {
      finishMutation();
    }
  };

  const permanentlyDeleteCompany = async (confirmationTitle: string) => {
    const preview = deletionPreview;
    if (!canPermanentlyDelete || !preview || confirmationTitle !== preview.title || !startMutation()) return;
    setDeletionError('');
    try {
      const response = await request(`/api/admin/clients/${preview.id}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: preview.updatedAt, expectedRevision: preview.revision, confirmationTitle }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось подтвердить удаление. Обновите список перед повтором.'));
      const data = await response.json().catch(() => null);
      if (!data || data.ok !== true || data.saved !== true) throw new Error('Не удалось подтвердить удаление. Обновите список перед повтором.');
      if (!isActive()) return;
      companiesRef.current = companiesRef.current.filter((item) => item.id !== preview.id);
      companyBaselines.current.delete(preview.id);
      setCompanies(companiesRef.current);
      replaceCompanyDrafts((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      setCompanyConflicts((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      setClientPasswordDrafts((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      replacePasswordEditIds((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      setExpandedCompanyIds((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      setDeletionPreview(null);
      const warnings = Array.isArray(data.warnings) ? data.warnings.flatMap((warning: { message?: unknown }) => typeof warning?.message === 'string' ? [warning.message] : []) : [];
      const fileStatus = !Number.isSafeInteger(data.cleanupPending) || data.cleanupPending < 0
        ? 'Статус очистки файлов не получен; его нужно проверить отдельно.'
        : data.cleanupPending > 0 ? `Заданий очистки файлов, ожидающих отдельного подтверждения: ${data.cleanupPending}.` : 'Ожидающих заданий очистки файлов нет.';
      setStatus([`Клиент удалён навсегда. Прайсы и их товары сохранены, привязки к клиенту сняты. ${fileStatus}`, ...warnings].join(' '));
    } catch (error) {
      if (isActive()) setDeletionError(readApiErrorFallback(error, 'Не удалось подтвердить удаление. Обновите список перед повтором.'));
    } finally {
      finishMutation();
    }
  };


  return { archiveCompany, restoreCompany, previewPermanentDeletion, permanentlyDeleteCompany, deletionPreview, setDeletionPreview, deletionError };
}
