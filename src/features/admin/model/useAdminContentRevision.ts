'use client';

import { useState } from 'react';

import type { AdminCrudHookOptions } from './hookTypes';
import { useAdminContentAction } from './useAdminContentAction';
import { parseRecordRevision } from '@/shared/lib/recordVersion';

type RevisionedItem = { id: number; revision?: string };
type Collection<T> = { items: T[]; replace(saved: T, expected: T): boolean };

/** Conflict recovery is explicit and scoped to one row, never to all open drafts. */
export function useAdminContentRevision<T extends RevisionedItem>(
  collection: Collection<T>, options: AdminCrudHookOptions, endpoint: string, listKey: string,
) {
  const [conflicts, setConflicts] = useState<Set<number>>(() => new Set());
  const perform = useAdminContentAction(options);
  const flag = (id: number) => setConflicts((current) => new Set(current).add(id));
  const clear = (id: number) => setConflicts((current) => {
    const next = new Set(current); next.delete(id); return next;
  });
  const reload = async (id: number) => {
    if (options.actionLock?.current) return;
    const expected = collection.items.find((item) => item.id === id);
    if (!expected || !confirm('Загрузить актуальную версию? Несохранённые изменения только этой записи будут отменены. Правки остальных записей останутся.')) return;
    await perform({
      requests: [{ url: endpoint, init: { method: 'GET' } }], mutation: false,
      success: 'Актуальная версия загружена. Можно повторить нужные изменения.',
      failure: 'Не удалось загрузить актуальную версию. Ваши правки сохранены в форме.',
      onSaved: async (responses, signal) => {
        const data = await responses[0].json();
        signal.throwIfAborted();
        const item = Array.isArray(data?.[listKey])
          ? (data[listKey] as T[]).find((row) => row.id === id) : undefined;
        if (!item || !parseRecordRevision(item.revision)) {
          throw new Error('Актуальная запись не найдена. Возможно, её удалили. Ваши правки остаются в форме.');
        }
        if (!collection.replace(item, expected)) {
          return 'Во время загрузки вы изменили форму. Эти правки не сброшены. Повторите загрузку актуальной версии, если хотите их отменить.';
        }
        clear(id);
      },
    });
  };
  return { conflicts, flag, clear, reload };
}
