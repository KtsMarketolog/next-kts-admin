'use client';

import { useState } from 'react';

import { readSavedContentItem } from '@/features/admin/model/adminContentRead';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import { useAdminDraftCollection } from '@/features/admin/model/useAdminDraftState';
import type { PriceGroupImage } from '@/features/admin/types';

const priceGroupKey = (group: PriceGroupImage) => group.title;

export function useAdminPriceGroups(options: AdminCrudHookOptions) {
  const perform = useAdminContentAction(options);
  const groups = useAdminDraftCollection<PriceGroupImage>(priceGroupKey, options.draftScope && `${options.draftScope}:price-groups`);
  const [savedPriceGroupTitle, setSavedPriceGroupTitle] = useState<string | null>(null);

  const updatePriceGroup = (title: string, patch: Partial<PriceGroupImage>) => groups.update(title, patch);

  const savePriceGroup = async (group: PriceGroupImage) => {
    const submitted = { ...group };
    await perform({
      requests: [{ url: '/api/admin/price-groups', init: {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: submitted.title, imageUrl: submitted.imageUrl }),
      } }],
      success: 'Картинка ценовой группы сохранена',
      failure: 'Не удалось сохранить картинку ценовой группы',
      onSaved: async (_responses, signal) => {
        const saved = await readSavedContentItem<PriceGroupImage>('/api/admin/price-groups', 'groups', (item) => item.title === submitted.title, signal);
        if (signal.aborted) return;
        groups.accept(submitted, saved);
        setSavedPriceGroupTitle(submitted.title);
        window.setTimeout(() => setSavedPriceGroupTitle((current) => (current === submitted.title ? null : current)), 2000);
      },
    });
  };

  return {
    priceGroups: groups.items,
    setPriceGroups: groups.hydrate,
    dirtyCount: groups.dirtyKeys.size,
    savedPriceGroupTitle,
    updatePriceGroup,
    savePriceGroup,
  };
}
