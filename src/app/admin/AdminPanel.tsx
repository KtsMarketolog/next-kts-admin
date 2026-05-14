'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminBrandPortfolioSection } from '@/features/admin/brand-portfolio/AdminBrandPortfolioSection';
import { AdminCatalogSection } from '@/features/admin/catalog/AdminCatalogSection';
import { AdminDashboard } from '@/features/admin/dashboard/AdminDashboard';
import { AdminGroupCompaniesSection } from '@/features/admin/group-companies/AdminGroupCompaniesSection';
import { AdminInfoSection } from '@/features/admin/info/AdminInfoSection';
import { useAdminBrandPortfolio } from '@/features/admin/model/useAdminBrandPortfolio';
import { useAdminGroupCompanies } from '@/features/admin/model/useAdminGroupCompanies';
import { useAdminNews } from '@/features/admin/model/useAdminNews';
import { useAdminPriceGroups } from '@/features/admin/model/useAdminPriceGroups';
import { useAdminSlides } from '@/features/admin/model/useAdminSlides';
import { AdminNewsSection } from '@/features/admin/news/AdminNewsSection';
import { AdminPriceGroupsSection } from '@/features/admin/price-groups/AdminPriceGroupsSection';
import { AdminStatusToast } from '@/features/admin/shared/AdminStatusToast';
import { AdminSliderSection } from '@/features/admin/slider/AdminSliderSection';
import { AdminWholesaleGateway } from '@/features/admin/wholesale/AdminWholesaleGateway';
import type { AdminSection, SettingKey } from '@/features/admin/types';
import { AdminUsersSection } from '@/features/admin/users/AdminUsersSection';
import { LoginPanel } from '@/features/auth/LoginPanel';
import type { AdminSession } from '@/shared/lib/adminAuth';

import styles from './admin.module.scss';

const ADMIN_SECTIONS: AdminSection[] = ['info', 'slider', 'news', 'groupCompanies', 'brands', 'catalog', 'priceGroups', 'users'];

const SITE_NAV_ITEMS: Array<{ value: AdminSection; label: string; description: string }> = [
  { value: 'info', label: 'Информация', description: 'Телефон, email и адрес' },
  { value: 'slider', label: 'Слайдер', description: 'Главные слайды сайта' },
  { value: 'news', label: 'Новости', description: 'Публикации и даты' },
  { value: 'groupCompanies', label: 'Группа компаний', description: 'Логотипы и ссылки' },
  { value: 'brands', label: 'Портфель брендов', description: 'Бренды и категории' },
  { value: 'catalog', label: 'Каталог', description: 'Товары и импорт' },
  { value: 'priceGroups', label: 'Ценовая группа', description: 'Картинки ценовых групп' },
  { value: 'users', label: 'Пользователи и доступы', description: 'Роли и права' },
];

type AdminArea = 'home' | 'site' | 'wholesale';

function isManagerRole(role: AdminSession['role'] | string | null | undefined) {
  return role === 'manager' || role === 'support_manager';
}

type AdminPanelProps = {
  initialArea?: AdminArea;
  initialSession?: AdminSession | null;
};

type AdminSessionResponse = {
  authenticated?: boolean;
  role?: AdminSession['role'] | null;
};

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function fetchAdminSessionSnapshot(): Promise<AdminSessionResponse> {
  const response = await fetch('/api/admin/session', { cache: 'no-store', credentials: 'same-origin' });

  if (!response.ok) {
    throw new Error(`Admin session check failed: ${response.status}`);
  }

  return response.json();
}

async function fetchAdminSessionWithRetry(attempts = 4) {
  let lastError: unknown = null;

  for (let index = 0; index < attempts; index += 1) {
    try {
      const data = await fetchAdminSessionSnapshot();
      if (data.authenticated || index === attempts - 1) return data;
    } catch (error) {
      lastError = error;
      if (index === attempts - 1) throw error;
    }

    await wait([250, 500, 900][index] ?? 1200);
  }

  if (lastError) throw lastError;
  return { authenticated: false, role: null };
}

function normalizeSessionRole(role: AdminSessionResponse['role']) {
  return isManagerRole(role) ? (role as AdminSession['role']) : role === 'wholesale_admin' ? 'wholesale_admin' : 'admin';
}

export default function AdminPanel({ initialArea = 'home', initialSession = null }: AdminPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [authenticated, setAuthenticated] = useState(Boolean(initialSession));
  const [sessionReady, setSessionReady] = useState(Boolean(initialSession));
  const [sessionRole, setSessionRole] = useState<AdminSession['role'] | null>(initialSession?.role ?? null);
  const [activeArea, setActiveArea] = useState<AdminArea>(
    initialSession?.role !== 'admin' && initialArea === 'site' ? 'home' : initialArea,
  );
  const [activeSection, setActiveSection] = useState<AdminSection>('info');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedSetting, setSavedSetting] = useState<SettingKey | null>(null);
  const loadAdminDataRef = useRef<() => Promise<void>>(async () => {});
  const authenticatedRef = useRef(Boolean(initialSession));

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
    if (area === 'wholesale') {
      router.replace(isManagerRole(sessionRole) ? '/admin/wholesale/manager' : '/admin/wholesale/admin', { scroll: false });
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
        setAuthenticated(false);
      } else {
        setSessionRole(normalizeSessionRole(session.role));
        setAuthenticated(true);
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
          setSessionRole(nextRole);
          setAuthenticated(true);
          setSessionReady(true);
          if (nextRole !== 'admin') {
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
          setAuthenticated(false);
          setSessionReady(true);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to verify admin session', error);
        if (!authenticatedRef.current) {
          setSessionRole(null);
          setAuthenticated(false);
        }
        setSessionReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [loadAdminData, pathname, router]);

  useEffect(() => {
    if (pathname.startsWith('/admin/wholesale')) {
      setActiveArea('wholesale');
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
  }, [initialArea, pathname, sessionRole]);

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

  const uploadImage = async (file: File, kind: 'image' | 'brandLogo' | 'priceGroup' = 'image') => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('kind', kind);
    const res = await fetch('/api/admin/uploads', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не удалось загрузить файл');
    return data.url as string;
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
      <LoginPanel
        defaultMode="employee"
        onEmployeeAuthenticated={async (role) => {
          setSessionRole(role);
          setAuthenticated(true);
          setSessionReady(true);
          if (role === 'admin') {
            await loadAdminData().catch((error) => {
              console.error('Failed to load admin data after login', error);
            });
          }
          if (pathname.startsWith('/admin/wholesale')) {
            setActiveArea('home');
            router.replace('/admin', { scroll: false });
          } else if (pathname.startsWith('/admin/site') && role !== 'admin') {
            router.replace('/admin', { scroll: false });
          }
        }}
      />
    );
  }

  const pageTitle =
    activeArea === 'site'
      ? 'Управление сайтом'
      : activeArea === 'wholesale'
        ? 'Индивидуальные прайсы'
        : 'Панель управления';

  return (
    <main className={styles.page}>
      <div className={styles.topbar}>
        <div>
          <p>Панель управления</p>
          <h1>{pageTitle}</h1>
        </div>
        <div className={styles.topbarActions}>
          {activeArea === 'site' && (
            <button className={styles.secondary} onClick={() => switchArea('home')}>
              Вернуться в панель управления
            </button>
          )}
          <button
            className={styles.secondary}
            onClick={async () => {
              await fetch('/api/admin/logout', { method: 'POST' });
              setSessionRole(null);
              setAuthenticated(false);
              setSessionReady(true);
            }}
          >
            Выйти
          </button>
        </div>
      </div>

      <AdminStatusToast message={status} />

      {activeArea === 'home' && (
        <AdminDashboard
          canAccessSite={sessionRole === 'admin'}
          onOpenSiteSettings={() => switchArea('site')}
          onOpenWholesale={() => switchArea('wholesale')}
        />
      )}

      {activeArea === 'wholesale' && (
        <AdminWholesaleGateway canManageWholesale={sessionRole === 'admin' || sessionRole === 'wholesale_admin'} onBack={() => switchArea('home')} />
      )}

      {activeArea === 'site' && (
        <div className={styles.adminShell}>
          <aside className={styles.analyticsSidebar}>
            <div className={styles.analyticsSidebarHeader}>
              <span>Дашборд</span>
              <strong>Разделы</strong>
            </div>
            <nav className={styles.analyticsSideNav} aria-label="Разделы управления сайтом">
              {SITE_NAV_ITEMS.map((item) => (
                <button
                  key={item.value}
                  className={activeSection === item.value ? styles.analyticsSideNavActive : styles.analyticsSideNavItem}
                  type="button"
                  onClick={() => switchSection(item.value)}
                >
                  <span>{item.label}</span>
                  <small>{item.description}</small>
                </button>
              ))}
            </nav>
          </aside>

          <div className={styles.content}>
            {activeSection === 'info' && (
              <AdminInfoSection
                phone={phone}
                email={email}
                address={address}
                busy={busy}
                savedSetting={savedSetting}
                onPhoneChange={setPhone}
                onEmailChange={setEmail}
                onAddressChange={setAddress}
                onSave={saveInfo}
              />
            )}

            {activeSection === 'slider' && (
              <AdminSliderSection
                slides={slideAdmin.slides}
                draft={slideAdmin.draft}
                nextSlideOrder={slideAdmin.nextSlideOrder}
                draggedSlideId={slideAdmin.draggedSlideId}
                busy={busy}
                savedSlideId={slideAdmin.savedSlideId}
                setDraft={slideAdmin.setDraft}
                setDraggedSlideId={slideAdmin.setDraggedSlideId}
                updateSlide={slideAdmin.updateSlide}
                moveSlide={slideAdmin.moveSlide}
                createSlide={slideAdmin.createSlide}
                saveSlide={slideAdmin.saveSlide}
                deleteSlide={slideAdmin.deleteSlide}
                uploadImage={uploadImage}
                showStatus={showStatus}
              />
            )}

            {activeSection === 'news' && (
              <AdminNewsSection
                news={newsAdmin.news}
                newsDraft={newsAdmin.newsDraft}
                nextNewsOrder={newsAdmin.nextNewsOrder}
                draggedNewsId={newsAdmin.draggedNewsId}
                busy={busy}
                newsCreated={newsAdmin.newsCreated}
                savedNewsId={newsAdmin.savedNewsId}
                setNewsDraft={newsAdmin.setNewsDraft}
                setDraggedNewsId={newsAdmin.setDraggedNewsId}
                updateNews={newsAdmin.updateNews}
                moveNews={newsAdmin.moveNews}
                createNews={newsAdmin.createNews}
                saveNews={newsAdmin.saveNews}
                deleteNews={newsAdmin.deleteNews}
                uploadImage={uploadImage}
                showStatus={showStatus}
              />
            )}

            {activeSection === 'groupCompanies' && (
              <AdminGroupCompaniesSection
                groupCompanies={groupCompanyAdmin.groupCompanies}
                groupCompanyDraft={groupCompanyAdmin.groupCompanyDraft}
                nextGroupCompanyOrder={groupCompanyAdmin.nextGroupCompanyOrder}
                draggedGroupCompanyId={groupCompanyAdmin.draggedGroupCompanyId}
                busy={busy}
                groupCompanyCreated={groupCompanyAdmin.groupCompanyCreated}
                savedGroupCompanyId={groupCompanyAdmin.savedGroupCompanyId}
                setGroupCompanyDraft={groupCompanyAdmin.setGroupCompanyDraft}
                setDraggedGroupCompanyId={groupCompanyAdmin.setDraggedGroupCompanyId}
                updateGroupCompany={groupCompanyAdmin.updateGroupCompany}
                moveGroupCompany={groupCompanyAdmin.moveGroupCompany}
                createGroupCompany={groupCompanyAdmin.createGroupCompany}
                saveGroupCompany={groupCompanyAdmin.saveGroupCompany}
                deleteGroupCompany={groupCompanyAdmin.deleteGroupCompany}
                uploadImage={uploadImage}
                showStatus={showStatus}
              />
            )}

            {activeSection === 'brands' && (
              <AdminBrandPortfolioSection
                brandCategories={brandAdmin.brandCategories}
                brands={brandAdmin.brands}
                brandCategoryDraft={brandAdmin.brandCategoryDraft}
                brandDraft={brandAdmin.brandDraft}
                draggedBrandCategoryId={brandAdmin.draggedBrandCategoryId}
                busy={busy}
                savedBrandCategoryId={brandAdmin.savedBrandCategoryId}
                savedBrandId={brandAdmin.savedBrandId}
                brandCategoryCreated={brandAdmin.brandCategoryCreated}
                setBrandCategoryDraft={brandAdmin.setBrandCategoryDraft}
                setBrandDraft={brandAdmin.setBrandDraft}
                setDraggedBrandCategoryId={brandAdmin.setDraggedBrandCategoryId}
                updateBrandCategory={brandAdmin.updateBrandCategory}
                moveBrandCategory={brandAdmin.moveBrandCategory}
                createBrandCategoryItem={brandAdmin.createBrandCategoryItem}
                saveBrandCategory={brandAdmin.saveBrandCategory}
                deleteBrandCategoryItem={brandAdmin.deleteBrandCategoryItem}
                updateBrand={brandAdmin.updateBrand}
                createBrand={brandAdmin.createBrand}
                saveBrand={brandAdmin.saveBrand}
                deleteBrand={brandAdmin.deleteBrand}
                uploadImage={(file) => uploadImage(file, 'brandLogo')}
                showStatus={showStatus}
              />
            )}

            {activeSection === 'catalog' && <AdminCatalogSection showStatus={showStatus} />}

            {activeSection === 'priceGroups' && (
              <AdminPriceGroupsSection
                priceGroups={priceGroupAdmin.priceGroups}
                savedPriceGroupTitle={priceGroupAdmin.savedPriceGroupTitle}
                busy={busy}
                updatePriceGroup={priceGroupAdmin.updatePriceGroup}
                savePriceGroup={priceGroupAdmin.savePriceGroup}
                uploadImage={(file) => uploadImage(file, 'priceGroup')}
                showStatus={showStatus}
              />
            )}

            {activeSection === 'users' && <AdminUsersSection showStatus={showStatus} />}
          </div>
        </div>
      )}
    </main>
  );
}
