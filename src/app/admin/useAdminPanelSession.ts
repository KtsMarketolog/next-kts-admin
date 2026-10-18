'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { useRouter } from 'next/navigation';
import type { AdminSession } from '@/shared/lib/adminAuth';
import { canAccessReportsCatalog } from '@/shared/lib/dashboardAccess';
import type { AdminArea } from './adminPanelConfig';
import { canRoleAccessTopDashboard, canRoleManageTopDashboard, isTopAreaOnlyRole, isTopDashboardPath } from './adminPanelAccess';
import { fetchAdminSessionWithRetry, normalizeSessionRole } from './adminSessionClient';

export function useAdminPanelSession(initialSession: AdminSession | null) {
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
  const authenticatedRef = useRef(Boolean(initialSession));
  useEffect(() => {
    authenticatedRef.current = authenticated;
  }, [authenticated]);

  const recheckSessionAfterDenied = useCallback(async () => {
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
  }, []);

  return { authenticated, setAuthenticated, sessionReady, setSessionReady, sessionRole, setSessionRole,
    reportSession, setReportSession, canAccessTopDashboard, setCanAccessTopDashboard,
    canManageTopDashboard, setCanManageTopDashboard, authenticatedRef, recheckSessionAfterDenied };
}

type SessionVerificationOptions = {
  session: ReturnType<typeof useAdminPanelSession>;
  pathname: string;
  router: ReturnType<typeof useRouter>;
  setActiveArea: Dispatch<SetStateAction<AdminArea>>;
  loadAdminData: () => Promise<void>;
  setContentLoadError: Dispatch<SetStateAction<string>>;
};

/** Session rechecks never reload editors after their initial successful hydration. */
export function useAdminPanelSessionVerification({
  session, pathname, router, setActiveArea, loadAdminData, setContentLoadError,
}: SessionVerificationOptions) {
  const { authenticated, sessionReady, authenticatedRef, setSessionReady, setSessionRole,
    setReportSession, setCanAccessTopDashboard, setCanManageTopDashboard, setAuthenticated } = session;

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
  }, [loadAdminData, pathname, router, authenticatedRef, setActiveArea, setAuthenticated,
    setCanAccessTopDashboard, setCanManageTopDashboard, setContentLoadError, setReportSession,
    setSessionReady, setSessionRole]);

  useEffect(() => {
    if (sessionReady && !authenticated) {
      router.replace('/login?mode=employee', { scroll: false });
    }
  }, [authenticated, router, sessionReady]);

}
