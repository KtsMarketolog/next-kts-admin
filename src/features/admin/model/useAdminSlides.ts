'use client';

import { useState } from 'react';

import { emptySlide } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { reorderByDrop } from '@/features/admin/model/reorder';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import type { Slide } from '@/features/admin/types';

export function useAdminSlides(options: AdminCrudHookOptions) {
  const { showStatus } = options;
  const perform = useAdminContentAction(options);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [draft, setDraft] = useState(emptySlide);
  const [savedSlideId, setSavedSlideId] = useState<number | null>(null);
  const [draggedSlideId, setDraggedSlideId] = useState<number | null>(null);

  const nextSlideOrder = slides.length + 1;

  const updateSlide = (id: number, patch: Partial<Slide>) => {
    setSlides((current) => current.map((slide) => (slide.id === id ? { ...slide, ...patch } : slide)));
  };

  const saveSlide = async (slide: Slide) => {
    await perform({ requests: [{ url: `/api/admin/slides/${slide.id}`, init: {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slide),
    } }], success: 'Слайд сохранен', failure: 'Не удалось сохранить слайд', onSaved: () => {
      setSavedSlideId(slide.id);
      window.setTimeout(() => {
        setSavedSlideId((current) => (current === slide.id ? null : current));
      }, 2000);
    } });
  };

  const deleteSlide = async (id: number) => {
    if (!confirm('Удалить слайд?')) return;
    await perform({ requests: [{ url: `/api/admin/slides/${id}`, init: { method: 'DELETE' } }],
      success: 'Слайд удален', failure: 'Не удалось удалить слайд' });
  };

  const createSlide = async () => {
    if (!draft.imageUrl) {
      showStatus('Добавьте картинку для нового слайда');
      return;
    }

    await perform({ requests: [{ url: '/api/admin/slides', init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draft, sortOrder: nextSlideOrder }),
    } }], success: 'Слайд добавлен', failure: 'Не удалось добавить слайд', onSaved: () => {
      setDraft(emptySlide);
    } });
  };

  const persistSlideOrder = async (orderedSlides: Slide[]) => {
    await perform({ requests: orderedSlides.map((slide) => ({ url: `/api/admin/slides/${slide.id}`, init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slide),
        } })), success: 'Очередность слайдов сохранена', failure: 'Не удалось сохранить очередность слайдов' });
  };

  const moveSlide = async (draggedId: number, targetId: number) => {
    if (options.actionLock?.current) return;
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
