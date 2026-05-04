'use client';

import { useState } from 'react';

import { emptySlide } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { reorderByDrop } from '@/features/admin/model/reorder';
import type { Slide } from '@/features/admin/types';

export function useAdminSlides({ setBusy, showStatus, reloadAdminData }: AdminCrudHookOptions) {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [draft, setDraft] = useState(emptySlide);
  const [savedSlideId, setSavedSlideId] = useState<number | null>(null);
  const [draggedSlideId, setDraggedSlideId] = useState<number | null>(null);

  const nextSlideOrder = slides.length + 1;

  const updateSlide = (id: number, patch: Partial<Slide>) => {
    setSlides((current) => current.map((slide) => (slide.id === id ? { ...slide, ...patch } : slide)));
  };

  const saveSlide = async (slide: Slide) => {
    setBusy(true);
    const res = await fetch(`/api/admin/slides/${slide.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slide),
    });
    setBusy(false);
    showStatus(res.ok ? 'Слайд сохранен' : 'Не удалось сохранить слайд');
    if (res.ok) {
      setSavedSlideId(slide.id);
      window.setTimeout(() => {
        setSavedSlideId((current) => (current === slide.id ? null : current));
      }, 2000);
      await reloadAdminData();
    }
  };

  const deleteSlide = async (id: number) => {
    if (!confirm('Удалить слайд?')) return;
    setBusy(true);
    const res = await fetch(`/api/admin/slides/${id}`, { method: 'DELETE' });
    setBusy(false);
    showStatus(res.ok ? 'Слайд удален' : 'Не удалось удалить слайд');
    if (res.ok) await reloadAdminData();
  };

  const createSlide = async () => {
    if (!draft.imageUrl) {
      showStatus('Добавьте картинку для нового слайда');
      return;
    }

    setBusy(true);
    const res = await fetch('/api/admin/slides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draft, sortOrder: nextSlideOrder }),
    });
    setBusy(false);
    showStatus(res.ok ? 'Слайд добавлен' : 'Не удалось добавить слайд');
    if (res.ok) {
      setDraft(emptySlide);
      await reloadAdminData();
    }
  };

  const persistSlideOrder = async (orderedSlides: Slide[]) => {
    setBusy(true);
    const responses = await Promise.all(
      orderedSlides.map((slide) =>
        fetch(`/api/admin/slides/${slide.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slide),
        }),
      ),
    );
    setBusy(false);

    const saved = responses.every((res) => res.ok);
    showStatus(saved ? 'Очередность слайдов сохранена' : 'Не удалось сохранить очередность слайдов');
    if (saved) await reloadAdminData();
  };

  const moveSlide = async (draggedId: number, targetId: number) => {
    const normalized = reorderByDrop(slides, draggedId, targetId);
    if (!normalized) return;
    setSlides(normalized);
    await persistSlideOrder(normalized);
  };

  return {
    slides,
    setSlides,
    draft,
    setDraft,
    nextSlideOrder,
    savedSlideId,
    draggedSlideId,
    setDraggedSlideId,
    updateSlide,
    moveSlide,
    createSlide,
    saveSlide,
    deleteSlide,
  };
}
