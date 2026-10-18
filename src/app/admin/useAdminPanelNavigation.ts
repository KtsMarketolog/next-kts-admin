'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { AdminSession } from '@/shared/lib/adminAuth';
import type { AdminSection } from '@/features/admin/types';
import { ADMIN_SECTIONS, isManagerRole, type AdminArea } from './adminPanelConfig';
import { isTopAreaOnlyRole, isTopDashboardPath } from './adminPanelAccess';

type NavigationOptions = {
  initialArea: AdminArea;
  initialSession: AdminSession | null;
  initialTopDashboardBlockId: number | null;
  sessionRole: AdminSession['role'] | null;
  sessionReady: boolean;
  canAccessCatalog: boolean;
  canAccessTopDashboard: boolean;
  confirmLeave: () => boolean;
};

export function useAdminPanelNavigation({
  initialArea, initialSession, initialTopDashboardBlockId, sessionRole, sessionReady,
  canAccessCatalog, canAccessTopDashboard, confirmLeave,
}: NavigationOptions) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeArea, setActiveArea] = useState<AdminArea>(() => {
    if (isTopAreaOnlyRole(initialSession?.role)) return initialArea === 'top' ? 'top' : 'home';
    return initialSession?.role !== 'admin' && initialArea === 'site' ? 'home' : initialArea;
  });
  const [activeSection, setActiveSection] = useState<AdminSection>('info');
  const clientDetailMatch = /^\/admin\/clients\/(\d+)(?:\/)?$/.exec(pathname);
  const clientDetailId = clientDetailMatch ? Number(clientDetailMatch[1]) : null;
  const topDashboardDetailMatch = /^\/admin\/top\/([1-9]\d*)(?:\/)?$/.exec(pathname);
  const matchedTopDashboardBlockId = topDashboardDetailMatch ? Number(topDashboardDetailMatch[1]) : null;
  const topDashboardBlockId = Number.isSafeInteger(matchedTopDashboardBlockId)
    ? matchedTopDashboardBlockId
    : initialTopDashboardBlockId;

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

  return { pathname, router, activeArea, setActiveArea, activeSection, clientDetailId, topDashboardBlockId, switchSection, switchArea };
}
