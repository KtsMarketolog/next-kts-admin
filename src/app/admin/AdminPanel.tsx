'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminDashboard } from '@/features/admin/dashboard/AdminDashboard';
import { AnalogFinder } from '@/features/analogs/AnalogFinder';
import { AdminClientDetailSection } from '@/features/admin/clients/AdminClientDetailSection';
import { AdminClientsSection } from '@/features/admin/clients/AdminClientsSection';
import { useAdminBrandPortfolio } from '@/features/admin/model/useAdminBrandPortfolio';
import { useAdminGroupCompanies } from '@/features/admin/model/useAdminGroupCompanies';
import { useAdminNews } from '@/features/admin/model/useAdminNews';
import { useAdminPriceGroups } from '@/features/admin/model/useAdminPriceGroups';
import { useAdminSlides } from '@/features/admin/model/useAdminSlides';
import { AdminStatusToast } from '@/features/admin/shared/AdminStatusToast';
import { AdminTopDashboardCatalog } from '@/features/admin/top-dashboard/AdminTopDashboardCatalog';
import { AdminTopDashboardSection } from '@/features/admin/top-dashboard/AdminTopDashboardSection';
import { TopDashboardViewer } from '@/features/admin/top-dashboard/TopDashboardViewer';
import { AdminWholesaleGateway } from '@/features/admin/wholesale/AdminWholesaleGateway';
import type { AdminSection, SettingKey } from '@/features/admin/types';
import type { AdminSession } from '@/shared/lib/adminAuth';

import { AdminSiteContent } from './AdminSiteContent';
import { AdminSiteSidebar } from './AdminSiteSidebar';
import { AdminTopbar } from './AdminTopbar';
import { fetchAdminSessionWithRetry, normalizeSessionRole } from './adminSessionClient';
import { uploadAdminImage } from './adminUploadClient';
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
    || (isManagerRole(role) && explicitPermission === true);
}

function canRoleManageTopDashboard(
  role: AdminSession['role'] | null | undefined,
  explicitPermission: boolean | undefined,
) {
  return role === 'admin'
    || role === 'admintop'
    || (role === 'top' && explicitPermission === true);
}

function isTopAreaOnlyRole(role: AdminSession['role'] | null | undefined) {
  return role === 'top' || role === 'admintop';
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
  const [canAccessTopDashboard, setCanAccessTopDashboard] = useState(
    canRoleAccessTopDashboard(initialSession?.role, initialSession?.canAccessTopDashboard),
  );
  const [canManageTopDashboard, setCanManageTopDashboard] = useState(
    canRoleManageTopDashboard(initialSession?.role, initialSession?.canManageTopDashboard),
  );
  const [activeArea, setActiveArea] = useState<AdminArea>(() => {
    if (isTopAreaOnlyRole(initialSession?.role)) return initialArea === 'top' ? 'top' : 'home';
    return initialSession?.role !== 'admin' && initialArea === 'site' ? 'home' : initialArea;
  });
  const [activeSection, setActiveSection] = useState<AdminSection>('info');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedSetting, setSavedSetting] = useState<SettingKey | null>(null);
  const loadAdminDataRef = useRef<() => Promise<void>>(async () => {});
  const authenticatedRef = useRef(Boolean(initialSession));
  const clientDetailMatch = /^\/admin\/clients\/(\d+)(?:\/)?$/.exec(pathname);
  const clientDetailId = clientDetailMatch ? Number(clientDetailMatch[1]) : null;
  const topDashboardDetailMatch = /^\/admin\/top\/([1-9]\d*)(?:\/)?$/.exec(pathname);
  const matchedTopDashboardBlockId = topDashboardDetailMatch ? Number(topDashboardDetailMatch[1]) : null;
  const topDashboardBlockId = Number.isSafeInteger(matchedTopDashboardBlockId)
    ? matchedTopDashboardBlockId
    : initialTopDashboardBlockId;

  const showStatus = (message: string) => {
    setStatus(message);
    window.setTimeout(() => {
      setStatus((current) => (current === message ? '' : current));
    }, 2000);
  };

  const reloadAdminData = useCallback(() => loadAdminDataRef.current(), []);

  const slideAdmin = useAdminSlides({ setBusy, showStatus, reloadAdminData });
  const newsAdmin = useAdminNews({ setBusy, showStatus, reloadAdminData });
  const groupCompanyAdmin = useAdminGroupCompanies({ setBusy, showStatus, reloadAdminData });
  const brandAdmin = useAdminBrandPortfolio({ setBusy, showStatus, reloadAdminData });
  const priceGroupAdmin = useAdminPriceGroups({ setBusy, showStatus, reloadAdminData });
  const { setSlides } = slideAdmin;
  const { setNews } = newsAdmin;
  const { setGroupCompanies } = groupCompanyAdmin;
  const { setBrandCategories, setBrands, setBrandDraft } = brandAdmin;
  const { setPriceGroups } = priceGroupAdmin;

  const switchSection = (section: AdminSection) => {
    setActiveSection(section);
    if (section === 'users') {
      router.replace('/admin/site/users', { scroll: false });
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete('area');
    params.set('section', section);
    router.replace(`/admin/site?${params.toString()}`, { scroll: false });
  };

  const switchArea = (area: AdminArea) => {
    if (area === 'top') {
      if (!canAccessTopDashboard) return;
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
    const [settingsRes, slidesRes, newsRes, groupCompaniesRes, brandsRes, priceGroupsRes] = await Promise.all([
      fetch('/api/admin/settings', { cache: 'no-store' }),
      fetch('/api/admin/slides', { cache: 'no-store' }),
      fetch('/api/admin/news', { cache: 'no-store' }),
      fetch('/api/admin/group-companies', { cache: 'no-store' }),
      fetch('/api/admin/brand-categories', { cache: 'no-store' }),
      fetch('/api/admin/price-groups', { cache: 'no-store' }),
    ]);

    const responses = [settingsRes, slidesRes, newsRes, groupCompaniesRes, brandsRes, priceGroupsRes];

    if (responses.some((response) => response.status === 401 || response.status === 403)) {
      const session = await fetchAdminSessionWithRetry().catch((error) => {
        console.error('Failed to recheck admin session after protected data response', error);
        return null;
      });

      if (!session?.authenticated) {
        setSessionRole(null);
        setCanAccessTopDashboard(false);
        setCanManageTopDashboard(false);
        setAuthenticated(false);
      } else {
        const nextRole = normalizeSessionRole(session.role);
        setSessionRole(nextRole);
        setCanAccessTopDashboard(
          canRoleAccessTopDashboard(nextRole, session.canAccessTopDashboard),
        );
        setCanManageTopDashboard(
          canRoleManageTopDashboard(nextRole, session.canManageTopDashboard),
        );
        setAuthenticated(Boolean(nextRole));
      }
      return;
    }

    if (responses.some((response) => !response.ok)) {
      console.error(
        'Failed to load admin data',
        responses.map((response) => response.status).join(', '),
      );
      return;
    }

    const settings = await settingsRes.json();
    const slideData = await slidesRes.json();
    const newsData = await newsRes.json();
    const groupCompanyData = await groupCompaniesRes.json();
    const brandData = await brandsRes.json();
    const priceGroupData = await priceGroupsRes.json();
    const nextBrandCategories = Array.isArray(brandData.categories) ? brandData.categories : [];

    setPhone(settings.phone ?? '');
    setEmail(settings.email ?? '');
    setAddress(settings.address ?? '');
    setSlides(Array.isArray(slideData.slides) ? slideData.slides : []);
    setNews(Array.isArray(newsData.news) ? newsData.news : []);
    setGroupCompanies(Array.isArray(groupCompanyData.companies) ? groupCompanyData.companies : []);
    setBrandCategories(nextBrandCategories);
    setBrands(Array.isArray(brandData.brands) ? brandData.brands : []);
    setPriceGroups(Array.isArray(priceGroupData.groups) ? priceGroupData.groups : []);
    setBrandDraft((current) => ({ ...current, categoryId: current.categoryId || nextBrandCategories[0]?.id || 0 }));
    setAuthenticated(true);
  }, [setBrandCategories, setBrandDraft, setBrands, setGroupCompanies, setNews, setPriceGroups, setSlides]);

  useEffect(() => {
    loadAdminDataRef.current = loadAdminData;
  }, [loadAdminData]);

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
            setCanAccessTopDashboard(false);
            setCanManageTopDashboard(false);
            setAuthenticated(false);
            setSessionReady(true);
            return;
          }
          const nextCanAccessTopDashboard = canRoleAccessTopDashboard(
            nextRole,
            data.canAccessTopDashboard,
          );
          setSessionRole(nextRole);
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
            return;
          }
          if (nextRole !== 'admin') {
            if (isTopDashboardPath(pathname) && !nextCanAccessTopDashboard) {
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
          });
        } else {
          setSessionRole(null);
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
      return;
    }

    if (isTopDashboardPath(pathname)) {
      setActiveArea(canAccessTopDashboard ? 'top' : 'home');
      if (sessionReady && sessionRole && !canAccessTopDashboard) {
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
  }, [canAccessTopDashboard, initialArea, pathname, router, sessionReady, sessionRole]);

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
    setBusy(true);
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, email, address }),
    });
    setBusy(false);
    showStatus(res.ok ? 'Информация сохранена' : 'Не удалось сохранить информацию');
    if (res.ok) {
      setSavedSetting(target);
      window.setTimeout(() => {
        setSavedSetting((current) => (current === target ? null : current));
      }, 2000);
    }
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
        : canManageTopDashboard
          ? 'HTML-страницы и отчёты'
          : 'Готовые отчёты'
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
          await fetch('/api/admin/logout', { method: 'POST' });
          setSessionRole(null);
          setCanAccessTopDashboard(false);
          setCanManageTopDashboard(false);
          setAuthenticated(false);
          setSessionReady(true);
        }}
      />

      <AdminStatusToast message={status} />

      {activeArea === 'home' && (
        <AdminDashboard
          canAccessSite={sessionRole === 'admin'}
          topDashboardMode={topDashboardMode}
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
            canManage={canManageTopDashboard}
            showStatus={showStatus}
          />
        )
      )}

      {activeArea === 'wholesale' && (
        <AdminWholesaleGateway canManageWholesale={sessionRole === 'admin' || sessionRole === 'wholesale_admin'} onBack={() => switchArea('home')} />
      )}

      {activeArea === 'clients' &&
        (clientDetailId ? (
          <AdminClientDetailSection clientId={clientDetailId} onBack={() => router.push('/admin/clients', { scroll: false })} />
        ) : (
          <AdminClientsSection onBack={() => switchArea('home')} />
        ))}

      {activeArea === 'site' && (
        <div className={styles.adminShell}>
          <AdminSiteSidebar activeSection={activeSection} onSwitchSection={switchSection} />

          <div className={styles.content}>
            <AdminSiteContent
              activeSection={activeSection}
              phone={phone}
              email={email}
              address={address}
              busy={busy}
              savedSetting={savedSetting}
              slideAdmin={slideAdmin}
              newsAdmin={newsAdmin}
              groupCompanyAdmin={groupCompanyAdmin}
              brandAdmin={brandAdmin}
              priceGroupAdmin={priceGroupAdmin}
              onPhoneChange={setPhone}
              onEmailChange={setEmail}
              onAddressChange={setAddress}
              onSaveInfo={saveInfo}
              uploadImage={uploadAdminImage}
              showStatus={showStatus}
            />
          </div>
        </div>
      )}
    </main>
  );
}
