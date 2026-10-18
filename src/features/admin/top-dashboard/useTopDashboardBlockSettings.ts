'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { requestProfitabilityFrameChange } from '@/features/admin/dashboard-usage/useProfitabilityAuditGuard';
import { readError } from './topDashboardManagementModel';
import { versionCountLabel } from './topDashboardPresentation';
import type { TopDashboardManagement } from './useTopDashboardManagement';

/** Title draft survives unrelated overview refreshes until explicitly saved/cancelled. */
export function useTopDashboardBlockSettings(management: TopDashboardManagement) {
  const { overview, setOverview, busyAction, previewFrameRef, beginMutation, finishMutation, request, apiBasePath, router, showStatusRef, isActive } = management;
  const [isEditingBlockTitle, setIsEditingBlockTitle] = useState(false);
  const [blockTitleDraft, setBlockTitleDraft] = useState('');
  const [blockMutationError, setBlockMutationError] = useState<string | null>(null);
  const blockTitleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditingBlockTitle) {
      blockTitleInputRef.current?.focus();
      blockTitleInputRef.current?.select();
    }
  }, [isEditingBlockTitle]);

  const beginBlockTitleEdit = () => {
    if (!overview || busyAction !== null) return;
    setBlockTitleDraft(overview.block.title);
    setBlockMutationError(null);
    setIsEditingBlockTitle(true);
  };

  const cancelBlockTitleEdit = () => {
    setBlockTitleDraft('');
    setBlockMutationError(null);
    setIsEditingBlockTitle(false);
  };

  const renameBlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!overview || busyAction !== null) return;

    const title = blockTitleDraft.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (!title || Array.from(title).length > 120) {
      setBlockMutationError('Название блока должно содержать от 1 до 120 символов');
      blockTitleInputRef.current?.focus();
      return;
    }
    if (title === overview.block.title) {
      cancelBlockTitleEdit();
      return;
    }

    if (!beginMutation('rename-block')) return;
    setBlockMutationError(null);
    try {
      const response = await request(apiBasePath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title }),
      });
      if (!response.ok) {
        if (response.status === 404) {
          showStatusRef.current('Блок уже удалён');
          router.replace('/admin/top', { scroll: false });
          return;
        }
        const message = await readError(response, 'Не удалось изменить название блока');
        setBlockMutationError(message);
        showStatusRef.current(message);
        return;
      }

      const data = await response.json().catch(() => ({}));
      const updatedTitle = typeof data.block?.title === 'string' ? data.block.title : title;
      setOverview((current) => current
        ? { ...current, block: { ...current.block, title: updatedTitle } }
        : current);
      setBlockTitleDraft('');
      setIsEditingBlockTitle(false);
      showStatusRef.current('Название блока изменено');
    } catch (error) {
      if (!isActive()) return;
      const message = error instanceof Error ? error.message : 'Не удалось подтвердить изменение названия. Обновите страницу перед повторной попыткой.';
      setBlockMutationError(message);
      showStatusRef.current(message);
    } finally {
      finishMutation();
    }
  };

  const deleteBlock = async () => {
    if (!requestProfitabilityFrameChange(previewFrameRef.current)) return;
    if (!overview || busyAction !== null) return;

    const title = overview.block.title;
    const versions = versionCountLabel(overview.versions.length);
    if (
      !window.confirm(
        `Удалить блок «${title}» и все его версии (${versions})?\n\nЭто действие необратимо: блок и загруженные HTML-файлы будут удалены полностью.`,
      )
    ) {
      return;
    }

    if (!beginMutation('delete-block')) return;
    setBlockMutationError(null);
    try {
      const response = await request(apiBasePath, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        if (response.status === 404) {
          showStatusRef.current('Блок уже удалён');
          router.replace('/admin/top', { scroll: false });
          return;
        }
        const message = await readError(response, 'Не удалось удалить блок');
        setBlockMutationError(message);
        showStatusRef.current(message);
        return;
      }

      showStatusRef.current(`Блок «${title}» удалён`);
      router.replace('/admin/top', { scroll: false });
    } catch (error) {
      if (!isActive()) return;
      const message = error instanceof Error ? error.message : 'Не удалось подтвердить удаление блока. Обновите список перед повторной попыткой.';
      setBlockMutationError(message);
      showStatusRef.current(message);
    } finally {
      finishMutation();
    }
  };

  return { isEditingBlockTitle, blockTitleDraft, setBlockTitleDraft, blockMutationError, blockTitleInputRef, beginBlockTitleEdit, cancelBlockTitleEdit, renameBlock, deleteBlock };
}

export type TopDashboardBlockSettings = ReturnType<typeof useTopDashboardBlockSettings>;
