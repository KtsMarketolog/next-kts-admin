'use client';

import { useMemo, useState } from 'react';

import { emptySlide } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { readConfirmedOrder, reorderByDrop, reorderRequest } from '@/features/admin/model/reorder';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import { readSavedContentItem } from '@/features/admin/model/adminContentRead';
import { useAdminDraft, useAdminDraftCollection } from '@/features/admin/model/useAdminDraftState';
import type { Slide } from '@/features/admin/types';

const slideKey = (slide: Slide) => slide.id;

export function useAdminSlides(options: AdminCrudHookOptions) {
  const { showStatus } = options;
  const perform = useAdminContentAction(options);
  const collection = useAdminDraftCollection(slideKey, options.draftScope && `${options.draftScope}:slides`);
  const creation = useAdminDraft(emptySlide, options.draftScope && `${options.draftScope}:new-slide`);
  const slides = useMemo(() => [...collection.items].sort((a, b) => a.sortOrder - b.sortOrder), [collection.items]);
  const draft = creation.value;
  const [savedSlideId, setSavedSlideId] = useState<number | null>(null);
  const [draggedSlideId, setDraggedSlideId] = useState<number | null>(null);

  const nextSlideOrder = slides.length + 1;

  const updateSlide = (id: number, patch: Partial<Slide>) => {
    collection.update(id, patch);
  };

  const saveSlide = async (slide: Slide) => {
    await perform({ requests: [{ url: `/api/admin/slides/${slide.id}`, init: {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slide),
    } }], success: 'Слайд сохранен', failure: 'Не удалось сохранить слайд', onSaved: async (_responses, signal) => {
      const saved = await readSavedContentItem<Slide>('/api/admin/slides', 'slides', (item) => item.id === slide.id, signal);
      signal.throwIfAborted();
      collection.accept(slide, saved);
      setSavedSlideId(slide.id);
      window.setTimeout(() => {
        setSavedSlideId((current) => (current === slide.id ? null : current));
      }, 2000);
    } });
  };

  const deleteSlide = async (id: number) => {
    if (!confirm('Удалить слайд?')) return;
    await perform({ requests: [{ url: `/api/admin/slides/${id}`, init: { method: 'DELETE' } }],
      success: 'Слайд удален', failure: 'Не удалось удалить слайд',
      onSaved: () => { collection.remove(id); } });
  };

  const createSlide = async () => {
    if (!draft.imageUrl) {
      showStatus('Добавьте картинку для нового слайда');
      return;
    }

    const submitted = draft;
    await perform({ requests: [{ url: '/api/admin/slides', init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...submitted, sortOrder: nextSlideOrder }),
    } }], success: 'Слайд добавлен', failure: 'Не удалось добавить слайд', onSaved: async (responses, signal) => {
      const result = await responses[0].json();
      if (!Number.isSafeInteger(result?.id) || result.id <= 0) throw new Error('Ответ не содержит номер созданного слайда');
      const saved = await readSavedContentItem<Slide>('/api/admin/slides', 'slides', (item) => item.id === result.id, signal);
      signal.throwIfAborted();
      collection.accept(saved, saved);
      creation.resetAfterSave(submitted);
    } });
  };

  const persistSlideOrder = async (orderedSlides: Slide[]) => {
    await perform({ requests: [reorderRequest('/api/admin/slides', orderedSlides)], success: 'Очередность слайдов сохранена', failure: 'Не удалось сохранить очередность слайдов',
      onSaved: async (responses, signal) => {
        const warnings = await readConfirmedOrder(responses[0], orderedSlides, signal);
        for (const saved of orderedSlides) {
          const submitted = slides.find((item) => item.id === saved.id);
          if (submitted) collection.accept(submitted, saved, ['sortOrder']);
        }
        if (warnings.length) return `Очередность слайдов сохранена. ${warnings.join(' ')}`;
      } });
  };

  const moveSlide = async (draggedId: number, targetId: number) => {
    if (options.actionLock?.current) return;
    const normalized = reorderByDrop(slides, draggedId, targetId);
    if (!normalized) return;
    await persistSlideOrder(normalized);
  };

  return {
    slides,
    setSlides: collection.hydrate,
    draft,
    setDraft: creation.setValue,
    dirtyCount: collection.dirtyKeys.size + Number(creation.dirty),
    dirtyKeys: collection.dirtyKeys,
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
