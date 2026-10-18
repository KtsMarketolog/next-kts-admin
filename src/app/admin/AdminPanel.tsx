'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { AdminDashboard } from '@/features/admin/dashboard/AdminDashboard';
import { AnalogFinder } from '@/features/analogs/AnalogFinder';
import { AdminClientDetailSection } from '@/features/admin/clients/AdminClientDetailSection';
import { AdminClientsSection } from '@/features/admin/clients/AdminClientsSection';
import { useAdminBrandPortfolio } from '@/features/admin/model/useAdminBrandPortfolio';
import { useAdminGroupCompanies } from '@/features/admin/model/useAdminGroupCompanies';
import { useAdminNews } from '@/features/admin/model/useAdminNews';
import { useAdminPriceGroups } from '@/features/admin/model/useAdminPriceGroups';
import { useAdminSlides } from '@/features/admin/model/useAdminSlides';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import { discardAdminDraftWorkspace, useAdminDraft } from '@/features/admin/model/useAdminDraftState';
import { useAdminUnsavedChanges } from '@/features/admin/model/useAdminUnsavedChanges';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import { AdminStatusToast } from '@/features/admin/shared/AdminStatusToast';
import { AdminTopDashboardCatalog } from '@/features/admin/top-dashboard/AdminTopDashboardCatalog';
import { AdminTopDashboardSection } from '@/features/admin/top-dashboard/AdminTopDashboardSection';
import { TopDashboardViewer } from '@/features/admin/top-dashboard/TopDashboardViewer';
import { AdminWholesaleGateway } from '@/features/admin/wholesale/AdminWholesaleGateway';
import type { AdminSection, SettingKey } from '@/features/admin/types';
import type { AdminSession } from '@/shared/lib/adminAuth';
import { canAccessReportsCatalog, canAssignDashboardAccess, getReportEntries } from '@/shared/lib/dashboardAccess';
import { canReviewDashboardUsage } from '@/shared/lib/dashboardUsageAccess';

import { AdminSiteContent } from './AdminSiteContent';
import { AdminSiteSidebar } from './AdminSiteSidebar';
import { AdminTopbar } from './AdminTopbar';
import { fetchAdminSessionWithRetry, normalizeSessionRole } from './adminSessionClient';
import { uploadAdminImage, type AdminUploadKind } from './adminUploadClient';
import { ADMIN_SECTIONS, type AdminArea, isManagerRole } from './adminPanelConfig';
import styles from './admin.module.scss';

type AdminPanelProps = {
  initialArea?: AdminArea;
  initialSession?: AdminSession | null;
  initialTopDashboardBlockId?: number | null;
};

function isTopDashboardPath(pathname: string) {
  return /^\/admin\/top(?:\/[1-9]\d*)?\/?$/.test(pathname);
}

function canRoleAccessTopDashboard(
  role: AdminSession['role'] | null | undefined,
  explicitPermission: boolean | undefined,
) {
  return role === 'admin'
    || role === 'admintop'
    || role === 'top'
    || role === 'purchaser'
    || explicitPermission === true;
}

function canRoleManageTopDashboard(
  role: AdminSession['role'] | null | undefined,
  explicitPermission: boolean | undefined,
) {
  return role === 'admin'
    || role === 'admintop'
    || ((role === 'top' || isManagerRole(role)) && explicitPermission === true);
}

function isTopAreaOnlyRole(role: AdminSession['role'] | null | undefined) {
  return role === 'top' || role === 'admintop' || role === 'purchaser';
}

export default function AdminPanel({
  initialArea = 'home',
  initialSession = null,
  initialTopDashboardBlockId = null,
}: AdminPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [authenticated, setAuthenticated] = useState(Boolean(initialSession));
  const [sessionReady, setSessionReady] = useState(Boolean(initialSession));
  const [sessionRole, setSessionRole] = useState<AdminSession['role'] | null>(initialSession?.role ?? null);
  const [reportSession, setReportSession] = useState<AdminSession | null>(initialSession);
  const [canAccessTopDashboard, setCanAccessTopDashboard] = useState(
    canRoleAccessTopDashboard(initialSession?.role, initialSession?.dashboardAccess?.some((key)=>key.startsWith('top:')) || initialSession?.canManageTopDashboard),
  );
  const [canManageTopDashboard, setCanManageTopDashboard] = useState(
    canRoleManageTopDashboard(initialSession?.role, initialSession?.canManageTopDashboard),
  );
  const [activeArea, setActiveArea] = useState<AdminArea>(() => {
    if (isTopAreaOnlyRole(initialSession?.role)) return initialArea === 'top' ? 'top' : 'home';
    return initialSession?.role !== 'admin' && initialArea === 'site' ? 'home' : initialArea;
  });
  const canAccessCatalog = canAccessReportsCatalog(reportSession);
  const [activeSection, setActiveSection] = useState<AdminSection>('info');
  const draftScope = reportSession?.role === 'admin' ? `site-content:${reportSession.adminUserId ?? 'legacy-admin'}` : undefined;
  const settingsDraft = useAdminDraft({ phone: '', email: '', address: '' }, draftScope && `${draftScope}:settings`);
  const { phone, email, address } = settingsDraft.value;
  const { hydrate: hydrateSettings } = settingsDraft;
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const contentActionLock = useRef(false);
  const { request, isActive } = useAdminRequestScope();
  const [contentLoaded, setContentLoaded] = useState(false);
  const contentLoadedRef = useRef(false);
  const contentLoadingRef = useRef<Promise<void> | null>(null);
  const contentScopeRef = useRef(draftScope);
  const [contentLoadError, setContentLoadError] = useState('');
  const [savedSetting, setSavedSetting] = useState<SettingKey | null>(null);
  const authenticatedRef = useRef(Boolean(initialSession));
  const clientDetailMatch = /^\/admin\/clients\/(\d+)(?:\/)?$/.exec(pathname);
  const clientDetailId = clientDetailMatch ? Number(clientDetailMatch[1]) : null;
  const topDashboardDetailMatch = /^\/admin\/top\/([1-9]\d*)(?:\/)?$/.exec(pathname);
  const matchedTopDashboardBlockId = topDashboardDetailMatch ? Number(topDashboardDetailMatch[1]) : null;
  const topDashboardBlockId = Number.isSafeInteger(matchedTopDashboardBlockId)
    ? matchedTopDashboardBlockId
    : initialTopDashboardBlockId;

  const showStatus = useCallback((message: string) => {
    setStatus(message);
    window.setTimeout(() => {
      setStatus((current) => (current === message ? '' : current));
    }, 8000);
  }, []);

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
  const { confirmLeave } = useAdminUnsavedChanges(hasUnsaved || busy);
  useLayoutEffect(() => {
    if (contentScopeRef.current === draftScope) return;
    contentScopeRef.current = draftScope;
    contentLoadedRef.current = false;
    contentLoadingRef.current = null;
    setContentLoaded(false);
  }, [draftScope]);

  const switchSection = (section: AdminSection) => {
    if (section === 'users') {
      if (!confirmLeave()) return;
      router.replace('/admin/site/users', { scroll: false });
      return;
    }
    setActiveSection(section);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('area');
    params.set('section', section);
    router.replace(`/admin/site?${params.toString()}`, { scroll: false });
  };

  const switchArea = (area: AdminArea) => {
    if (!confirmLeave()) return;
    if (area === 'top') {
      if (!canAccessCatalog) return;
      router.replace('/admin/top', { scroll: false });
      return;
    }

    if (isTopAreaOnlyRole(sessionRole)) {
      router.replace('/admin', { scroll: false });
      return;
    }

    if (area === 'wholesale') {
      router.replace(isManagerRole(sessionRole) ? '/admin/wholesale/manager' : '/admin/wholesale/admin', { scroll: false });
      return;
    }

    if (area === 'clients') {
      router.replace('/admin/clients', { scroll: false });
      return;
    }

    if (area === 'analogs') {
      router.replace('/admin/analogs', { scroll: false });
      return;
    }

    if (area === 'site') {
      if (sessionRole !== 'admin') return;
      router.replace('/admin/site', { scroll: false });
      return;
    }

    setActiveArea('home');
    router.replace('/admin', { scroll: false });
  };

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
        const session = await fetchAdminSessionWithRetry().catch((error) => {
          console.error('Failed to recheck admin session after protected data response', error);
          return null;
        });

        if (!session?.authenticated) {
          setSessionRole(null);
          setReportSession(null);
          setCanAccessTopDashboard(false);
          setCanManageTopDashboard(false);
          setAuthenticated(false);
        } else {
          const nextRole = normalizeSessionRole(session.role);
          setSessionRole(nextRole);
          setReportSession(nextRole ? {...session, role: nextRole} : null);
          setCanAccessTopDashboard(
            canRoleAccessTopDashboard(nextRole, session.dashboardAccess?.some((key)=>key.startsWith('top:')) || session.canManageTopDashboard),
          );
          setCanManageTopDashboard(
            canRoleManageTopDashboard(nextRole, session.canManageTopDashboard),
          );
          setAuthenticated(Boolean(nextRole));
        }
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
  }, [draftScope, request, isActive, hydrateSettings, initializeBrandDraft, setBrandCategories, setBrands, setGroupCompanies, setNews, setPriceGroups, setSlides]);

  useEffect(() => {
    authenticatedRef.current = authenticated;
  }, [authenticated]);

  useEffect(() => {
    let cancelled = false;

    if (!authenticatedRef.current) {
      setSessionReady(false);
    }

    fetchAdminSessionWithRetry()
      .then((data) => {
        if (cancelled) return;

        if (data.authenticated) {
          const nextRole = normalizeSessionRole(data.role);
          if (!nextRole) {
            setSessionRole(null);
            setReportSession(null);
            setCanAccessTopDashboard(false);
            setCanManageTopDashboard(false);
            setAuthenticated(false);
            setSessionReady(true);
            return;
          }
          const nextCanAccessTopDashboard = canRoleAccessTopDashboard(
            nextRole,
            Array.isArray(data.dashboardAccess) && data.dashboardAccess.some((key:unknown)=>typeof key==='string' && key.startsWith('top:')) || data.canManageTopDashboard,
          );
          setSessionRole(nextRole);
          const nextReportSession = {...data, role: nextRole};
          setReportSession(nextReportSession);
          setCanAccessTopDashboard(nextCanAccessTopDashboard);
          setCanManageTopDashboard(
            canRoleManageTopDashboard(nextRole, data.canManageTopDashboard),
          );
          setAuthenticated(true);
          setSessionReady(true);
          if (isTopAreaOnlyRole(nextRole)) {
            const isTopPath = isTopDashboardPath(pathname);
            const isHomePath = pathname === '/admin' || pathname === '/admin/';
            setActiveArea(isTopPath ? 'top' : 'home');
            if (!isTopPath && !isHomePath) {
              router.replace('/admin', { scroll: false });
            }
            if (nextRole === 'purchaser' && isHomePath) router.replace('/admin/top', { scroll: false });
            return;
          }
          if (nextRole !== 'admin') {
            const topAllowed = /^\/admin\/top\/?$/.test(pathname)
              ? canAccessReportsCatalog(nextReportSession) : nextCanAccessTopDashboard;
            if (isTopDashboardPath(pathname) && !topAllowed) {
              router.replace('/admin', { scroll: false });
              return;
            }
            if (pathname.startsWith('/admin/site')) {
              router.replace('/admin', { scroll: false });
            }
            return;
          }
          void loadAdminData().catch((error) => {
            console.error('Failed to load admin data after session check', error);
            setContentLoadError(error instanceof Error ? error.message : 'Не удалось загрузить данные сайта');
          });
        } else {
          setSessionRole(null);
          setReportSession(null);
          setCanAccessTopDashboard(false);
          setCanManageTopDashboard(false);
          setAuthenticated(false);
          setSessionReady(true);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to verify admin session', error);
        if (!authenticatedRef.current) {
          setSessionRole(null);
          setReportSession(null);
          setCanAccessTopDashboard(false);
          setCanManageTopDashboard(false);
          setAuthenticated(false);
        }
        setSessionReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [loadAdminData, pathname, router]);

  useEffect(() => {
    if (isTopAreaOnlyRole(sessionRole)) {
      const isTopPath = isTopDashboardPath(pathname);
      const isHomePath = pathname === '/admin' || pathname === '/admin/';
      setActiveArea(isTopPath ? 'top' : 'home');
      if (!isTopPath && !isHomePath) {
        router.replace('/admin', { scroll: false });
      }
      if (sessionRole === 'purchaser' && isHomePath) router.replace('/admin/top', { scroll: false });
      return;
    }

    if (isTopDashboardPath(pathname)) {
      const allowed = /^\/admin\/top\/?$/.test(pathname) ? canAccessCatalog : canAccessTopDashboard;
      setActiveArea(allowed ? 'top' : 'home');
      if (sessionReady && sessionRole && !allowed) {
        router.replace('/admin', { scroll: false });
      }
      return;
    }

    if (pathname.startsWith('/admin/wholesale')) {
      setActiveArea('wholesale');
      return;
    }

    if (pathname.startsWith('/admin/clients')) {
      setActiveArea('clients');
      return;
    }

    if (pathname.startsWith('/admin/analogs')) {
      setActiveArea('analogs');
      return;
    }

    if (pathname.startsWith('/admin/site')) {
      if (sessionRole !== 'admin') {
        setActiveArea('home');
        return;
      }
      setActiveArea('site');
      if (pathname.startsWith('/admin/site/users')) {
        setActiveSection('users');
      }
      return;
    }

    setActiveArea(initialArea);
  }, [canAccessCatalog, canAccessTopDashboard, initialArea, pathname, router, sessionReady, sessionRole]);

  useEffect(() => {
    if (pathname.startsWith('/admin/site/users')) {
      setActiveSection('users');
      return;
    }
    const section = searchParams.get('section');
    if (ADMIN_SECTIONS.includes(section as AdminSection)) {
      setActiveSection(section as AdminSection);
    }
  }, [pathname, searchParams]);

  useEffect(() => {
    if (sessionReady && !authenticated) {
      router.replace('/login?mode=employee', { scroll: false });
    }
  }, [authenticated, router, sessionReady]);

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


  if (!sessionReady) {
    return (
      <main className={styles.page}>
        <div className={styles.topbar}>
          <div>
            <p>Панель управления</p>
            <h1>Проверяем доступ</h1>
          </div>
        </div>
        <section className={styles.section}>
          <p className={styles.mutedText}>Проверяем авторизацию и восстанавливаем сессию...</p>
        </section>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className={styles.page}>
        <div className={styles.topbar}>
          <div>
            <p>Панель управления</p>
            <h1>Переходим на вход</h1>
          </div>
        </div>
        <section className={styles.section}>
          <p className={styles.mutedText}>Откроется единая страница входа для клиентов и сотрудников.</p>
        </section>
      </main>
    );
  }

  const topDashboardMode = canAccessTopDashboard
    ? canManageTopDashboard
      ? 'manage' as const
      : 'view' as const
    : null;

  const pageTitle =
    activeArea === 'top'
      ? topDashboardBlockId
        ? canManageTopDashboard
          ? 'Редактор HTML-страницы'
          : 'Готовый отчёт'
        : 'HTML-страницы и отчёты'
      : activeArea === 'site'
        ? 'Управление сайтом'
        : activeArea === 'wholesale'
          ? pathname.endsWith('/admin/wholesale/manager')
            ? 'Кабинет менеджера'
            : 'Индивидуальные прайсы'
          : activeArea === 'clients'
            ? 'Клиенты'
            : activeArea === 'analogs'
              ? 'Аналоги'
              : 'Панель управления';

  return (
    <main className={styles.page}>
      <AdminTopbar
        activeArea={activeArea}
        pageTitle={pageTitle}
        backLabel={activeArea === 'top' && topDashboardBlockId
          ? canManageTopDashboard
            ? 'К списку HTML-страниц'
            : 'К списку отчётов'
          : undefined}
        onBackToHome={() => {
          if (activeArea === 'top' && topDashboardBlockId) {
            router.push('/admin/top', { scroll: false });
            return;
          }
          switchArea('home');
        }}
        onLogout={async () => {
          if (!confirmLeave()) return;
          try {
            const response = await request('/api/admin/logout', { method: 'POST' });
            if (!response.ok) throw new Error('Не удалось завершить сеанс. Повторите выход.');
            if (draftScope) discardAdminDraftWorkspace(draftScope);
            setSessionRole(null);
            setReportSession(null);
            setCanAccessTopDashboard(false);
            setCanManageTopDashboard(false);
            setAuthenticated(false);
            setSessionReady(true);
          } catch (error) {
            showStatus(error instanceof Error ? error.message : 'Не удалось завершить сеанс');
          }
        }}
      />

      <AdminStatusToast message={status} />

      {activeArea === 'home' && (
        <AdminDashboard
          canAccessSite={sessionRole === 'admin'}
          canManageUsers={canAssignDashboardAccess(reportSession)}
          canReviewUsage={canReviewDashboardUsage(reportSession)}
          canAccessReportsCatalog={canAccessCatalog}
          topDashboardMode={topDashboardMode}
          managerDashboardMode={sessionRole === 'admin' || sessionRole === 'admintop' ? 'manage' : isManagerRole(sessionRole) ? 'view' : null}
          managerDashboardAudience={sessionRole === 'manager' ? 'development' : sessionRole === 'support_manager' ? 'support' : null}
          isTopAreaOnlyUser={isTopAreaOnlyRole(sessionRole)}
          wholesaleHref={isManagerRole(sessionRole) ? '/admin/wholesale/manager' : '/admin/wholesale/admin'}
        />
      )}

      {activeArea === 'analogs' && <AnalogFinder />}

      {activeArea === 'top' && (
        topDashboardBlockId ? (
          canManageTopDashboard ? (
            <AdminTopDashboardSection
              key={topDashboardBlockId}
              blockId={topDashboardBlockId}
              canAssignAccess={canAssignDashboardAccess(reportSession)}
              showStatus={showStatus}
            />
          ) : (
            <TopDashboardViewer
              key={topDashboardBlockId}
              blockId={topDashboardBlockId}
              showStatus={showStatus}
            />
          )
        ) : (
          <AdminTopDashboardCatalog
            key={JSON.stringify([reportSession?.role, reportSession?.adminUserId, reportSession?.managerId, reportSession?.dashboardAccess, canAccessTopDashboard])}
            canManage={canManageTopDashboard}
            canReviewUsage={canReviewDashboardUsage(reportSession)}
            canReadTopBlocks={canAccessTopDashboard}
            reportEntries={getReportEntries(reportSession)}
            showStatus={showStatus}
          />
        )
      )}

      {activeArea === 'wholesale' && (
        <AdminWholesaleGateway canManageWholesale={sessionRole === 'admin' || sessionRole === 'wholesale_admin'} onBack={() => switchArea('home')} />
      )}

      {activeArea === 'clients' &&
        (clientDetailId ? (
          <AdminClientDetailSection key={clientDetailId} clientId={clientDetailId} onBack={() => router.push('/admin/clients', { scroll: false })} />
        ) : (
          <AdminClientsSection onBack={() => switchArea('home')} />
        ))}

      {activeArea === 'site' && (
        <div className={styles.adminShell}>
          <AdminSiteSidebar activeSection={activeSection} onSwitchSection={switchSection} dirtySections={dirtySections} />

          <div className={styles.content}>
            {hasUnsaved && <p role="status" className={styles.draftNotice}>
              <strong>Есть несохранённые изменения.</strong> Разделы отмечены в меню. Можно переключаться между ними — черновики останутся в форме. Перед уходом сохраните нужные записи.
            </p>}
            {contentLoadError && <p role="alert">{contentLoadError}</p>}
            {!contentLoaded && <p>Данные сайта ещё не загружены. Сохранение недоступно.
              <button type="button" className={styles.secondary} onClick={() => void loadAdminData().catch((error) => setContentLoadError(error instanceof Error ? error.message : 'Не удалось загрузить данные сайта'))}>Повторить загрузку</button>
            </p>}
            <AdminSiteContent
              activeSection={activeSection}
              phone={phone}
              email={email}
              address={address}
              busy={busy || !contentLoaded}
              savedSetting={savedSetting}
              slideAdmin={slideAdmin}
              newsAdmin={newsAdmin}
              groupCompanyAdmin={groupCompanyAdmin}
              brandAdmin={brandAdmin}
              priceGroupAdmin={priceGroupAdmin}
              onPhoneChange={(value) => settingsDraft.setValue((current) => ({ ...current, phone: value }))}
              onEmailChange={(value) => settingsDraft.setValue((current) => ({ ...current, email: value }))}
              onAddressChange={(value) => settingsDraft.setValue((current) => ({ ...current, address: value }))}
              onSaveInfo={saveInfo}
              uploadImage={uploadImage}
              showStatus={showStatus}
            />
          </div>
        </div>
      )}
    </main>
  );
}
