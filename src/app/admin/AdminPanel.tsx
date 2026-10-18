'use client';

import { useCallback, useState } from 'react';
import { AdminDashboard } from '@/features/admin/dashboard/AdminDashboard';
import { AnalogFinder } from '@/features/analogs/AnalogFinder';
import { AdminClientDetailSection } from '@/features/admin/clients/AdminClientDetailSection';
import { AdminClientsSection } from '@/features/admin/clients/AdminClientsSection';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import { AdminStatusToast } from '@/features/admin/shared/AdminStatusToast';
import { AdminTopDashboardCatalog } from '@/features/admin/top-dashboard/AdminTopDashboardCatalog';
import { AdminTopDashboardSection } from '@/features/admin/top-dashboard/AdminTopDashboardSection';
import { TopDashboardViewer } from '@/features/admin/top-dashboard/TopDashboardViewer';
import { AdminWholesaleGateway } from '@/features/admin/wholesale/AdminWholesaleGateway';
import type { AdminSession } from '@/shared/lib/adminAuth';
import { canAccessReportsCatalog, canAssignDashboardAccess, getReportEntries } from '@/shared/lib/dashboardAccess';
import { canReviewDashboardUsage } from '@/shared/lib/dashboardUsageAccess';

import { AdminSiteContent } from './AdminSiteContent';
import { AdminSiteSidebar } from './AdminSiteSidebar';
import { AdminTopbar } from './AdminTopbar';
import styles from './admin.module.scss';

import { discardAdminDraftWorkspace } from '@/features/admin/model/useAdminDraftState';
import { useAdminUnsavedChanges } from '@/features/admin/model/useAdminUnsavedChanges';
import { isManagerRole, type AdminArea } from './adminPanelConfig';
import { isTopAreaOnlyRole } from './adminPanelAccess';
import { useAdminPanelSession, useAdminPanelSessionVerification } from './useAdminPanelSession';
import { useAdminPanelNavigation } from './useAdminPanelNavigation';
import { useAdminSiteContent } from './useAdminSiteContent';

type AdminPanelProps = {
  initialArea?: AdminArea;
  initialSession?: AdminSession | null;
  initialTopDashboardBlockId?: number | null;
};

export default function AdminPanel({
  initialArea = 'home',
  initialSession = null,
  initialTopDashboardBlockId = null,
}: AdminPanelProps) {
  const session = useAdminPanelSession(initialSession);
  const { authenticated, setAuthenticated, sessionReady, setSessionReady, sessionRole, setSessionRole,
    reportSession, setReportSession, canAccessTopDashboard, setCanAccessTopDashboard,
    canManageTopDashboard, setCanManageTopDashboard, recheckSessionAfterDenied } = session;
  const canAccessCatalog = canAccessReportsCatalog(reportSession);
  const draftScope = reportSession?.role === 'admin' ? `site-content:${reportSession.adminUserId ?? 'legacy-admin'}` : undefined;
  const [status, setStatus] = useState('');
  const { request, isActive } = useAdminRequestScope();

  const showStatus = useCallback((message: string) => {
    setStatus(message);
    window.setTimeout(() => {
      setStatus((current) => (current === message ? '' : current));
    }, 8000);
  }, []);

  const content = useAdminSiteContent({ draftScope, request, isActive, showStatus, recheckSessionAfterDenied, setAuthenticated });
  const { settingsDraft, phone, email, address, busy, contentLoaded, contentLoadError, setContentLoadError,
    savedSetting, uploadImage, slideAdmin, newsAdmin, groupCompanyAdmin, brandAdmin, priceGroupAdmin,
    dirtySections, hasUnsaved, loadAdminData, saveInfo } = content;
  const { confirmLeave } = useAdminUnsavedChanges(hasUnsaved || busy);
  const navigation = useAdminPanelNavigation({ initialArea, initialSession, initialTopDashboardBlockId,
    sessionRole, sessionReady, canAccessCatalog, canAccessTopDashboard, confirmLeave });
  const { pathname, router, activeArea, setActiveArea, activeSection, clientDetailId, topDashboardBlockId, switchSection, switchArea } = navigation;
  useAdminPanelSessionVerification({ session, pathname, router, setActiveArea, loadAdminData, setContentLoadError });

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
