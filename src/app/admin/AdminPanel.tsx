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
import { useAdminSlides } from '@/features/admin/model/useAdminSlides';
import { AdminNewsSection } from '@/features/admin/news/AdminNewsSection';
import { AdminStatusToast } from '@/features/admin/shared/AdminStatusToast';
import { AdminSliderSection } from '@/features/admin/slider/AdminSliderSection';
import { AdminWholesaleGateway } from '@/features/admin/wholesale/AdminWholesaleGateway';
import type { AdminSection, SettingKey } from '@/features/admin/types';
import { AdminUsersSection } from '@/features/admin/users/AdminUsersSection';
import { LoginPanel } from '@/features/auth/LoginPanel';
import type { AdminSession } from '@/shared/lib/adminAuth';

import styles from './admin.module.scss';

const ADMIN_SECTIONS: AdminSection[] = ['info', 'slider', 'news', 'groupCompanies', 'brands', 'catalog', 'users'];

type AdminArea = 'home' | 'site' | 'wholesale';

type AdminPanelProps = {
  initialArea?: AdminArea;
  initialSession?: AdminSession | null;
};

export default function AdminPanel({ initialArea = 'home', initialSession = null }: AdminPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [authenticated, setAuthenticated] = useState(Boolean(initialSession));
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
  const { setSlides } = slideAdmin;
  const { setNews } = newsAdmin;
  const { setGroupCompanies } = groupCompanyAdmin;
  const { setBrandCategories, setBrands, setBrandDraft } = brandAdmin;

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
      router.replace(sessionRole === 'manager' ? '/admin/wholesale/manager' : '/admin/wholesale/admin', { scroll: false });
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
    const [settingsRes, slidesRes, newsRes, groupCompaniesRes, brandsRes] = await Promise.all([
      fetch('/api/admin/settings', { cache: 'no-store' }),
      fetch('/api/admin/slides', { cache: 'no-store' }),
      fetch('/api/admin/news', { cache: 'no-store' }),
      fetch('/api/admin/group-companies', { cache: 'no-store' }),
      fetch('/api/admin/brand-categories', { cache: 'no-store' }),
    ]);

    if (
      settingsRes.status === 401 ||
      slidesRes.status === 401 ||
      newsRes.status === 401 ||
      groupCompaniesRes.status === 401 ||
      brandsRes.status === 401
    ) {
      setAuthenticated(false);
      return;
    }

    const settings = await settingsRes.json();
    const slideData = await slidesRes.json();
    const newsData = await newsRes.json();
    const groupCompanyData = await groupCompaniesRes.json();
    const brandData = await brandsRes.json();
    const nextBrandCategories = Array.isArray(brandData.categories) ? brandData.categories : [];

    setPhone(settings.phone ?? '');
    setEmail(settings.email ?? '');
    setAddress(settings.address ?? '');
    setSlides(Array.isArray(slideData.slides) ? slideData.slides : []);
    setNews(Array.isArray(newsData.news) ? newsData.news : []);
    setGroupCompanies(Array.isArray(groupCompanyData.companies) ? groupCompanyData.companies : []);
    setBrandCategories(nextBrandCategories);
    setBrands(Array.isArray(brandData.brands) ? brandData.brands : []);
    setBrandDraft((current) => ({ ...current, categoryId: current.categoryId || nextBrandCategories[0]?.id || 0 }));
    setAuthenticated(true);
  }, [setBrandCategories, setBrandDraft, setBrands, setGroupCompanies, setNews, setSlides]);

  useEffect(() => {
    loadAdminDataRef.current = loadAdminData;
  }, [loadAdminData]);

  useEffect(() => {
    fetch('/api/admin/session', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated) {
          const nextRole: AdminSession['role'] =
            data.role === 'manager' ? 'manager' : data.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin';
          setSessionRole(nextRole);
          if (nextRole !== 'admin') {
            setAuthenticated(true);
            if (pathname.startsWith('/admin/site')) {
              router.replace('/admin', { scroll: false });
            }
            return;
          }
          void loadAdminData().catch(() => setAuthenticated(false));
        } else {
          setSessionRole(null);
          setAuthenticated(false);
        }
      })
      .catch(() => {
        setSessionRole(null);
        setAuthenticated(false);
      });
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

  const uploadImage = async (file: File, kind: 'image' | 'brandLogo' = 'image') => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('kind', kind);
    const res = await fetch('/api/admin/uploads', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не удалось загрузить файл');
    return data.url as string;
  };

  if (!authenticated) {
    return (
      <LoginPanel
        defaultMode="employee"
        onEmployeeAuthenticated={async (role) => {
          setSessionRole(role);
          setAuthenticated(true);
          if (role === 'admin') {
            await loadAdminData();
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
          <aside className={styles.sidebar}>
            <p>Дашборд</p>
            <button
              className={activeSection === 'info' ? styles.navActive : undefined}
              onClick={() => switchSection('info')}
            >
              Информация
            </button>
            <button
              className={activeSection === 'slider' ? styles.navActive : undefined}
              onClick={() => switchSection('slider')}
            >
              Слайдер
            </button>
            <button
              className={activeSection === 'news' ? styles.navActive : undefined}
              onClick={() => switchSection('news')}
            >
              Новости
            </button>
            <button
              className={activeSection === 'groupCompanies' ? styles.navActive : undefined}
              onClick={() => switchSection('groupCompanies')}
            >
              Группа компаний
            </button>
            <button
              className={activeSection === 'brands' ? styles.navActive : undefined}
              onClick={() => switchSection('brands')}
            >
              Портфель брендов
            </button>
            <button
              className={activeSection === 'catalog' ? styles.navActive : undefined}
              onClick={() => switchSection('catalog')}
            >
              Каталог
            </button>
            <button
              className={activeSection === 'users' ? styles.navActive : undefined}
              onClick={() => switchSection('users')}
            >
              Пользователи и доступы
            </button>
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

            {activeSection === 'users' && <AdminUsersSection showStatus={showStatus} />}
          </div>
        </div>
      )}
    </main>
  );
}
