'use client';

import { useMemo, useState } from 'react';

import { emptyNews } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { readConfirmedOrder, reorderByDrop, reorderRequest } from '@/features/admin/model/reorder';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import { readContentMutationItem, readSavedContentItem } from '@/features/admin/model/adminContentRead';
import { useAdminContentRevision } from '@/features/admin/model/useAdminContentRevision';
import { useAdminDraft, useAdminDraftCollection } from '@/features/admin/model/useAdminDraftState';
import type { News } from '@/features/admin/types';

const newsKey = (item: News) => item.id;

export function useAdminNews(options: AdminCrudHookOptions) {
  const { showStatus } = options;
  const perform = useAdminContentAction(options);
  const collection = useAdminDraftCollection(newsKey, options.draftScope && `${options.draftScope}:news`);
  const revision = useAdminContentRevision(collection, options, '/api/admin/news', 'news');
  const creation = useAdminDraft(emptyNews, options.draftScope && `${options.draftScope}:new-news`);
  const news = useMemo(() => [...collection.items].sort((a, b) => a.sortOrder - b.sortOrder), [collection.items]);
  const newsDraft = creation.value;
  const [savedNewsId, setSavedNewsId] = useState<number | null>(null);
  const [newsCreated, setNewsCreated] = useState(false);
  const [draggedNewsId, setDraggedNewsId] = useState<number | null>(null);

  const nextNewsOrder = news.length + 1;

  const updateNews = (id: number, patch: Partial<News>) => {
    collection.update(id, patch);
  };

  const persistNewsOrder = async (orderedNews: News[]) => {
    await perform({ requests: [reorderRequest('/api/admin/news', orderedNews)], success: 'Очередность новостей сохранена', failure: 'Не удалось сохранить очередность новостей',
      onSaved: async (responses, signal) => {
        const warnings = await readConfirmedOrder(responses[0], orderedNews, signal);
        for (const saved of orderedNews) {
          const submitted = news.find((item) => item.id === saved.id);
          if (submitted) collection.accept(submitted, saved, ['sortOrder']);
        }
        if (warnings.length) return `Очередность новостей сохранена. ${warnings.join(' ')}`;
      } });
  };

  const moveNews = async (draggedId: number, targetId: number) => {
    if (options.actionLock?.current) return;
    const normalized = reorderByDrop(news, draggedId, targetId);
    if (!normalized) return;
    await persistNewsOrder(normalized);
  };

  const createNews = async () => {
    if (!newsDraft.imageUrl || !newsDraft.title.trim()) {
      showStatus('Добавьте заголовок и картинку для новости');
      return;
    }

    const submitted = newsDraft;
    await perform({ requests: [{ url: '/api/admin/news', init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...submitted, sortOrder: nextNewsOrder }),
    } }], success: 'Новость добавлена', failure: 'Не удалось добавить новость', onSaved: async (responses, signal) => {
      const result = await responses[0].json();
      if (!Number.isSafeInteger(result?.id) || result.id <= 0) throw new Error('Ответ не содержит номер созданной новости');
      const saved = await readSavedContentItem<News>('/api/admin/news', 'news', (item) => item.id === result.id, signal);
      signal.throwIfAborted();
      collection.accept(saved, saved);
      creation.resetAfterSave(submitted);
      setNewsCreated(true);
      window.setTimeout(() => setNewsCreated(false), 2000);
    } });
  };

  const saveNews = async (item: News) => {
    await perform({ requests: [{ url: `/api/admin/news/${item.id}`, init: {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    } }], success: 'Новость сохранена', failure: 'Не удалось сохранить новость', onConflict: () => revision.flag(item.id), onSaved: async (responses, signal) => {
      const saved = await readContentMutationItem<News>(responses[0], item.id);
      signal.throwIfAborted();
      collection.accept(item, saved);
      revision.clear(item.id);
      setSavedNewsId(item.id);
      window.setTimeout(() => {
        setSavedNewsId((current) => (current === item.id ? null : current));
      }, 2000);
    } });
  };

  const deleteNews = async (id: number) => {
    if (!confirm('Удалить новость?')) return;
    await perform({ requests: [{ url: `/api/admin/news/${id}`, init: { method: 'DELETE' } }],
      success: 'Новость удалена', failure: 'Не удалось удалить новость',
      onSaved: () => { collection.remove(id); } });
  };

  return {
    news,
    setNews: collection.hydrate,
    newsDraft,
    setNewsDraft: creation.setValue,
    dirtyCount: collection.dirtyKeys.size + Number(creation.dirty),
    dirtyKeys: collection.dirtyKeys,
    conflictIds: revision.conflicts,
    reloadNews: revision.reload,
    nextNewsOrder,
    draggedNewsId,
    setDraggedNewsId,
    newsCreated,
    savedNewsId,
    updateNews,
    moveNews,
    createNews,
    saveNews,
    deleteNews,
  };
}
