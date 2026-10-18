'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useAdminBrandPortfolio } from '@/features/admin/model/useAdminBrandPortfolio';
import { useAdminGroupCompanies } from '@/features/admin/model/useAdminGroupCompanies';
import { useAdminNews } from '@/features/admin/model/useAdminNews';
import { useAdminPriceGroups } from '@/features/admin/model/useAdminPriceGroups';
import { useAdminSlides } from '@/features/admin/model/useAdminSlides';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import { useAdminDraft } from '@/features/admin/model/useAdminDraftState';
import type { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import type { AdminSection, SettingKey } from '@/features/admin/types';
import { uploadAdminImage, type AdminUploadKind } from './adminUploadClient';

type SiteContentOptions = {
  draftScope: string | undefined;
  request: ReturnType<typeof useAdminRequestScope>['request'];
  isActive: ReturnType<typeof useAdminRequestScope>['isActive'];
  showStatus: (message: string) => void;
  recheckSessionAfterDenied: () => Promise<void>;
  setAuthenticated: (value: boolean) => void;
};

/** Each editor owns its drafts; this hook only hydrates once and coordinates explicit saves. */
export function useAdminSiteContent({ draftScope, request, isActive, showStatus, recheckSessionAfterDenied, setAuthenticated }: SiteContentOptions) {
  const settingsDraft = useAdminDraft({ phone: '', email: '', address: '' }, draftScope && `${draftScope}:settings`);
  const { phone, email, address } = settingsDraft.value;
  const { hydrate: hydrateSettings } = settingsDraft;
  const [busy, setBusy] = useState(false);
  const contentActionLock = useRef(false);
  const [contentLoaded, setContentLoaded] = useState(false);
  const contentLoadedRef = useRef(false);
  const contentLoadingRef = useRef<Promise<void> | null>(null);
  const contentScopeRef = useRef(draftScope);
  const [contentLoadError, setContentLoadError] = useState('');
  const [savedSetting, setSavedSetting] = useState<SettingKey | null>(null);
  const uploadImage = useCallback((file: File, kind?: AdminUploadKind) => uploadAdminImage(file, kind, request), [request]);

  const contentOptions = { setBusy, showStatus, actionLock: contentActionLock, draftScope };
  const performContentAction = useAdminContentAction(contentOptions);
  const slideAdmin = useAdminSlides(contentOptions);
  const newsAdmin = useAdminNews(contentOptions);
  const groupCompanyAdmin = useAdminGroupCompanies(contentOptions);
  const brandAdmin = useAdminBrandPortfolio(contentOptions);
  const priceGroupAdmin = useAdminPriceGroups(contentOptions);
  const { setSlides } = slideAdmin;
  const { setNews } = newsAdmin;
  const { setGroupCompanies } = groupCompanyAdmin;
  const { setBrandCategories, setBrands, initializeBrandDraft } = brandAdmin;
  const { setPriceGroups } = priceGroupAdmin;
  const dirtySections: Partial<Record<AdminSection, number>> = {
    info: Number(settingsDraft.dirty),
    slider: slideAdmin.dirtyCount,
    news: newsAdmin.dirtyCount,
    groupCompanies: groupCompanyAdmin.dirtyCount,
    brands: brandAdmin.dirtyCount,
    priceGroups: priceGroupAdmin.dirtyCount,
  };
  const hasUnsaved = Object.values(dirtySections).some((count) => count > 0);
  useLayoutEffect(() => {
    if (contentScopeRef.current === draftScope) return;
    contentScopeRef.current = draftScope;
    contentLoadedRef.current = false;
    contentLoadingRef.current = null;
    setContentLoaded(false);
  }, [draftScope]);

  const loadAdminData = useCallback(async () => {
    // Rechecking the session must not reload every editor after a save or tab switch.
    if (!draftScope || contentLoadedRef.current) return;
    if (contentLoadingRef.current) return contentLoadingRef.current;
    const loading = (async () => {
      const [settingsRes, slidesRes, newsRes, groupCompaniesRes, brandsRes, priceGroupsRes] = await Promise.all([
        request('/api/admin/settings', { cache: 'no-store' }),
        request('/api/admin/slides', { cache: 'no-store' }),
        request('/api/admin/news', { cache: 'no-store' }),
        request('/api/admin/group-companies', { cache: 'no-store' }),
        request('/api/admin/brand-categories', { cache: 'no-store' }),
        request('/api/admin/price-groups', { cache: 'no-store' }),
      ]);

      const responses = [settingsRes, slidesRes, newsRes, groupCompaniesRes, brandsRes, priceGroupsRes];
      if (!isActive() || contentScopeRef.current !== draftScope) return;

      if (responses.some((response) => response.status === 401 || response.status === 403)) {
        await recheckSessionAfterDenied();

        throw new Error('Не удалось загрузить данные: проверьте авторизацию и права доступа');
      }

      if (responses.some((response) => !response.ok)) {
        console.error(
          'Failed to load admin data',
          responses.map((response) => response.status).join(', '),
        );
        throw new Error('Не удалось загрузить данные сайта. Изменения в форме сохранены.');
      }

      const settings = await settingsRes.json();
      const slideData = await slidesRes.json();
      const newsData = await newsRes.json();
      const groupCompanyData = await groupCompaniesRes.json();
      const brandData = await brandsRes.json();
      const priceGroupData = await priceGroupsRes.json();
      if (!isActive() || contentScopeRef.current !== draftScope) return;
      if (![slideData.slides, newsData.news, groupCompanyData.companies, brandData.categories, brandData.brands, priceGroupData.groups].every(Array.isArray)) {
        throw new Error('Сервер вернул неполные данные сайта. Обновите страницу перед сохранением.');
      }
      const nextBrandCategories = Array.isArray(brandData.categories) ? brandData.categories : [];

      hydrateSettings({ phone: settings.phone ?? '', email: settings.email ?? '', address: settings.address ?? '' });
      setSlides(Array.isArray(slideData.slides) ? slideData.slides : []);
      setNews(Array.isArray(newsData.news) ? newsData.news : []);
      setGroupCompanies(Array.isArray(groupCompanyData.companies) ? groupCompanyData.companies : []);
      setBrandCategories(nextBrandCategories);
      setBrands(Array.isArray(brandData.brands) ? brandData.brands : []);
      setPriceGroups(Array.isArray(priceGroupData.groups) ? priceGroupData.groups : []);
      initializeBrandDraft(nextBrandCategories[0]?.id || 0);
      setAuthenticated(true);
      contentLoadedRef.current = true;
      setContentLoaded(true);
      setContentLoadError('');
    })();
    contentLoadingRef.current = loading;
    try { await loading; } finally {
      if (contentLoadingRef.current === loading) contentLoadingRef.current = null;
    }
  }, [draftScope, request, isActive, hydrateSettings, initializeBrandDraft, setBrandCategories, setBrands, setGroupCompanies, setNews, setPriceGroups, setSlides, recheckSessionAfterDenied, setAuthenticated]);

  const saveInfo = async (target: SettingKey) => {
    if (!contentLoaded) return;
    const submitted = settingsDraft.value;
    await performContentAction({ requests: [{ url: '/api/admin/settings', init: {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [target]: submitted[target] }),
    } }], success: 'Информация сохранена', failure: 'Не удалось сохранить информацию', onSaved: async ([response]) => {
      const saved = await response.json();
      if (typeof saved[target] !== 'string') throw new Error('Не удалось подтвердить сохранённое поле');
      settingsDraft.accept(submitted, { ...submitted, [target]: saved[target] }, [target]);
      setSavedSetting(target);
      window.setTimeout(() => {
        setSavedSetting((current) => (current === target ? null : current));
      }, 2000);
    } });
  };


  return { settingsDraft, phone, email, address, busy, contentLoaded, contentLoadError, setContentLoadError,
    savedSetting, uploadImage, slideAdmin, newsAdmin, groupCompanyAdmin, brandAdmin, priceGroupAdmin,
    dirtySections, hasUnsaved, loadAdminData, saveInfo };
}
