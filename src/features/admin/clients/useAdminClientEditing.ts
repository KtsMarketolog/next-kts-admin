'use client';

import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { ClientMutationError, submitClientMutation } from './clientMutation';
import { buildClientConflict, resolveClientConflict, type ClientEditableField } from './clientConflict';
import { emptyDraft, readApiError, readApiErrorFallback, withoutClientCredentials, type ClientCompany } from './AdminClientsModel';
import type { AdminClientDraftState } from './useAdminClientDrafts';
import type { AdminClientListState } from './useAdminClientList';
import type { AdminClientOperations } from './useAdminClientOperations';

/** Creation/save acknowledgements and explicit three-way conflict resolution. */
export function useAdminClientEditing(operations: AdminClientOperations, editor: AdminClientDraftState, list: AdminClientListState) {
  const { request, isActive, mutationRef, dataGeneration, showStatus, setStatus, startMutation, finishMutation } = operations;
  const { draft, setDraft, companyDraftsRef, companyBaselines, replaceCompanyDrafts,
    clientPasswordEditIds, clientPasswordEditIdsRef, replacePasswordEditIds, clientPasswordDrafts, setClientPasswordDrafts,
    companyConflicts, setCompanyConflicts, setExpandedCompanyIds, setSavedCompanyId } = editor;
  const { companiesRef, setCompanies, acceptSavedCompany } = list;

  const validateClientPassword = (password: string) => {
    const passwordPolicy = validatePasswordPolicy(password);
    if (!passwordPolicy.ok) {
      showStatus(passwordPolicy.error || 'Пароль не подходит');
      return false;
    }
    return true;
  };

  const createCompany = async () => {
    if (!draft.title.trim()) {
      showStatus('Введите название компании');
      return;
    }
    if (!draft.email.trim()) {
      showStatus('Введите email клиента для входа');
      return;
    }
    if (!draft.password.trim()) {
      showStatus('Введите пароль клиента');
      return;
    }
    if (!validateClientPassword(draft.password.trim())) return;

    if (!startMutation()) return;
    try {
      const result = await submitClientMutation('/api/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      }, request);
      if (!isActive()) return;
      setDraft(emptyDraft);
      if (result.company) acceptSavedCompany(result.company);
      setStatus(['Компания клиента добавлена.', ...result.warnings].join(' '));
    } catch (error) {
      if (isActive()) setStatus(readApiErrorFallback(error, 'Не удалось подтвердить добавление компании'));
    } finally {
      finishMutation();
    }
  };

  const saveCompany = async (companyId: number) => {
    const nextDraft = companyDraftsRef.current[companyId];
    const latest = companiesRef.current.find((company) => company.id === companyId);
    if (companyConflicts[companyId] || (latest && nextDraft?.expectedUpdatedAt !== latest.updatedAt)) {
      setCompanyConflicts((current) => ({ ...current, [companyId]: current[companyId] ?? { comparison: null, error: '' } }));
      setStatus('Сначала сравните свои правки с актуальной карточкой клиента. Повторное сохранение старой формы не отправлено.');
      return;
    }
    if (!nextDraft?.title.trim()) {
      showStatus('Введите название компании');
      return;
    }
    if (!nextDraft.email.trim()) {
      showStatus('Введите email клиента для входа');
      return;
    }

    const passwordIsEdited = Boolean(clientPasswordEditIds[companyId]);
    const nextPassword = passwordIsEdited ? (clientPasswordDrafts[companyId] || '').trim() : '';
    if (passwordIsEdited && !nextPassword) {
      showStatus('Введите новый пароль или отмените изменение пароля');
      return;
    }
    if (nextPassword && !validateClientPassword(nextPassword)) return;

    if (!startMutation()) return;
    try {
      const result = await submitClientMutation(`/api/admin/clients/${companyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...nextDraft, password: nextPassword }),
      }, request);
      if (!isActive()) return;
      if (result.company) acceptSavedCompany(result.company);
      if (nextPassword) {
        setClientPasswordDrafts((current) => {
          const next = { ...current };
          delete next[companyId];
          return next;
        });
        replacePasswordEditIds((current) => {
          const next = { ...current };
          delete next[companyId];
          return next;
        });
      }
      setSavedCompanyId(companyId);
      setStatus(['Компания клиента сохранена.', ...result.warnings].join(' '));
      window.setTimeout(() => {
        setSavedCompanyId((current) => (current === companyId ? null : current));
      }, 2200);
    } catch (error) {
      if (isActive()) {
        if (error instanceof ClientMutationError && (error.status === 409 || error.status === 428)) {
          setCompanyConflicts((current) => ({ ...current, [companyId]: { comparison: null, error: '' } }));
          setExpandedCompanyIds((current) => ({ ...current, [companyId]: true }));
          setSavedCompanyId(null);
        }
        setStatus(readApiErrorFallback(error, 'Не удалось подтвердить сохранение компании'));
      }
    } finally {
      finishMutation();
    }
  };

  const loadCompanyConflict = async (companyId: number) => {
    if (!startMutation()) return;
    setCompanyConflicts((current) => ({ ...current, [companyId]: { comparison: null, error: '' } }));
    try {
      // Reuse the permission-filtered list, including archives so an archived
      // client is never mistaken for a writable card or silently reactivated.
      const response = await request('/api/admin/clients?scope=all', { cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось загрузить актуальную карточку'));
      const data = await response.json();
      if (!isActive()) return;
      if (!Array.isArray(data.companies)) throw new Error('Получены неполные данные. Ваши правки сохранены в форме; повторите загрузку актуальной карточки.');
      const latest = (data.companies as ClientCompany[]).find((company) => company?.id === companyId);
      if (!latest) throw new Error('Клиент удалён или больше недоступен. Ваши правки оставлены в форме; сохранение недоступно.');
      if (latest.archivedAt) throw new Error('Клиент уже в архиве. Сохранение этой формы недоступно. Ваши правки оставлены в форме; восстановление выполняется отдельно в архиве.');
      const base = companyBaselines.current.get(companyId);
      const local = companyDraftsRef.current[companyId];
      if (!base || !local) throw new Error('Не удалось определить исходную версию карточки. Ваши правки не изменены.');
      const comparison = buildClientConflict(base, local, withoutClientCredentials(latest));
      companiesRef.current = companiesRef.current.map((company) => company.id === companyId ? comparison.latest : company);
      setCompanies(companiesRef.current);
      setCompanyConflicts((current) => ({ ...current, [companyId]: { comparison, error: '' } }));
    } catch (error) {
      if (isActive()) setCompanyConflicts((current) => ({ ...current, [companyId]: { comparison: null, error: readApiErrorFallback(error, 'Не удалось загрузить актуальную карточку. Ваши правки не изменены.') } }));
    } finally {
      finishMutation();
    }
  };

  const applyCompanyConflict = (companyId: number, selectedFields: ClientEditableField[], discardAll = false) => {
    if (mutationRef.current) return;
    const comparison = companyConflicts[companyId]?.comparison;
    if (!comparison) return;
    const current = companiesRef.current.find((company) => company.id === companyId);
    if (!current || current.updatedAt !== comparison.latest.updatedAt || current.archivedAt) {
      setCompanyConflicts((conflicts) => ({ ...conflicts, [companyId]: { comparison: null, error: 'Карточка снова изменилась. Загрузите актуальную карточку ещё раз; ваши правки не изменены.' } }));
      return;
    }
    const passwordPending = Boolean(clientPasswordEditIdsRef.current[companyId]);
    const prompt = (discardAll ? 'Загрузить актуальную карточку и отказаться от собственных несохранённых правок?' : 'Перенести только отмеченные правки в актуальную карточку? Остальные поля будут взяты с сервера.')
      + (passwordPending ? '\nНовый пароль не будет перенесён — задайте его заново после сравнения.' : '')
      + '\nЭто обновит только вашу форму. Для записи потребуется нажать «Сохранить».';
    if (!window.confirm(prompt)) return;
    const resolved = resolveClientConflict(comparison, selectedFields);
    // Invalidate list requests begun before this explicit local rebase.
    dataGeneration.current += 1;
    companyBaselines.current.set(companyId, comparison.latest);
    replaceCompanyDrafts((drafts) => ({ ...drafts, [companyId]: resolved }));
    setClientPasswordDrafts((drafts) => { const next = { ...drafts }; delete next[companyId]; return next; });
    replacePasswordEditIds((ids) => { const next = { ...ids }; delete next[companyId]; return next; });
    setCompanyConflicts((conflicts) => { const next = { ...conflicts }; delete next[companyId]; return next; });
    setSavedCompanyId(null);
    setStatus(`Форма обновлена по актуальной карточке. Проверьте её и нажмите «Сохранить».${passwordPending ? ' Новый пароль при необходимости задайте заново.' : ''}`);
  };


  return { createCompany, saveCompany, loadCompanyConflict, applyCompanyConflict };
}
