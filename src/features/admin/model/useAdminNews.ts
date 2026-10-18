'use client';

import { useState } from 'react';

import { emptyNews } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { reorderByDrop } from '@/features/admin/model/reorder';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import type { News } from '@/features/admin/types';

export function useAdminNews(options: AdminCrudHookOptions) {
  const { showStatus } = options;
  const perform = useAdminContentAction(options);
  const [news, setNews] = useState<News[]>([]);
  const [newsDraft, setNewsDraft] = useState(emptyNews);
  const [savedNewsId, setSavedNewsId] = useState<number | null>(null);
  const [newsCreated, setNewsCreated] = useState(false);
  const [draggedNewsId, setDraggedNewsId] = useState<number | null>(null);

  const nextNewsOrder = news.length + 1;

  const updateNews = (id: number, patch: Partial<News>) => {
    setNews((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const persistNewsOrder = async (orderedNews: News[]) => {
    await perform({ requests: orderedNews.map((item) => ({ url: `/api/admin/news/${item.id}`, init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item),
        } })), success: 'Очередность новостей сохранена', failure: 'Не удалось сохранить очередность новостей' });
  };

  const moveNews = async (draggedId: number, targetId: number) => {
    if (options.actionLock?.current) return;
    const normalized = reorderByDrop(news, draggedId, targetId);
    if (!normalized) return;
    setNews(normalized);
    await persistNewsOrder(normalized);
  };

  const createNews = async () => {
    if (!newsDraft.imageUrl || !newsDraft.title.trim()) {
      showStatus('Добавьте заголовок и картинку для новости');
      return;
    }

    await perform({ requests: [{ url: '/api/admin/news', init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newsDraft, sortOrder: nextNewsOrder }),
    } }], success: 'Новость добавлена', failure: 'Не удалось добавить новость', onSaved: () => {
      setNewsCreated(true);
      window.setTimeout(() => setNewsCreated(false), 2000);
      setNewsDraft(emptyNews);
    } });
  };

  const saveNews = async (item: News) => {
    await perform({ requests: [{ url: `/api/admin/news/${item.id}`, init: {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    } }], success: 'Новость сохранена', failure: 'Не удалось сохранить новость', onSaved: () => {
      setSavedNewsId(item.id);
      window.setTimeout(() => {
        setSavedNewsId((current) => (current === item.id ? null : current));
      }, 2000);
    } });
  };

  const deleteNews = async (id: number) => {
    if (!confirm('Удалить новость?')) return;
    await perform({ requests: [{ url: `/api/admin/news/${id}`, init: { method: 'DELETE' } }],
      success: 'Новость удалена', failure: 'Не удалось удалить новость' });
  };

  return {
    news,
    setNews,
    newsDraft,
    setNewsDraft,
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
