'use client';

import { useState } from 'react';

import { emptyNews } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { reorderByDrop } from '@/features/admin/model/reorder';
import type { News } from '@/features/admin/types';

export function useAdminNews({ setBusy, showStatus, reloadAdminData }: AdminCrudHookOptions) {
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
    setBusy(true);
    const responses = await Promise.all(
      orderedNews.map((item) =>
        fetch(`/api/admin/news/${item.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item),
        }),
      ),
    );
    setBusy(false);

    const saved = responses.every((res) => res.ok);
    showStatus(saved ? 'Очередность новостей сохранена' : 'Не удалось сохранить очередность новостей');
    if (saved) await reloadAdminData();
  };

  const moveNews = async (draggedId: number, targetId: number) => {
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

    setBusy(true);
    const res = await fetch('/api/admin/news', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newsDraft, sortOrder: nextNewsOrder }),
    });
    setBusy(false);
    showStatus(res.ok ? 'Новость добавлена' : 'Не удалось добавить новость');
    if (res.ok) {
      setNewsCreated(true);
      window.setTimeout(() => setNewsCreated(false), 2000);
      setNewsDraft(emptyNews);
      await reloadAdminData();
    }
  };

  const saveNews = async (item: News) => {
    setBusy(true);
    const res = await fetch(`/api/admin/news/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    setBusy(false);
    showStatus(res.ok ? 'Новость сохранена' : 'Не удалось сохранить новость');
    if (res.ok) {
      setSavedNewsId(item.id);
      window.setTimeout(() => {
        setSavedNewsId((current) => (current === item.id ? null : current));
      }, 2000);
      await reloadAdminData();
    }
  };

  const deleteNews = async (id: number) => {
    if (!confirm('Удалить новость?')) return;
    setBusy(true);
    const res = await fetch(`/api/admin/news/${id}`, { method: 'DELETE' });
    setBusy(false);
    showStatus(res.ok ? 'Новость удалена' : 'Не удалось удалить новость');
    if (res.ok) await reloadAdminData();
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
