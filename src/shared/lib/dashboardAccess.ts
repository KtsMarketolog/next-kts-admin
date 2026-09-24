import type { AdminSession } from './adminAuth';

export type DashboardAccessOption = {
  key: string;
  title: string;
  description?: string;
  href?: string;
};

export const DASHBOARD_REPORT_OPTIONS: DashboardAccessOption[] = [
  { key: 'manager:development', title: 'Дашборды МР', href: '/admin/manager-dashboard?audience=development', description: 'Личные отчёты менеджеров по развитию.' },
  { key: 'manager:support', title: 'Дашборды МС', href: '/admin/manager-dashboard?audience=support', description: 'Личные отчёты менеджеров по сопровождению.' },
  { key: 'route-planner', title: 'Компоновщик рейсов', href: '/admin/top/route-planner', description: 'Общий отчёт с опубликованным файлом данных.' },
];

// Personal MR/MS dashboards remain available to their existing roles only.
// Purchasers can be assigned common reports, never private manager snapshots.
export const PURCHASER_DASHBOARD_REPORT_OPTIONS: DashboardAccessOption[] = DASHBOARD_REPORT_OPTIONS.filter(({ key }) => key === 'route-planner');

export function parseDashboardAccess(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  for (const key of value) {
    if (typeof key !== 'string') return null;
    if (!PURCHASER_DASHBOARD_REPORT_OPTIONS.some((option) => option.key === key)) {
      if (!/^top:[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key.slice(4)))) return null;
    }
    keys.push(key);
  }
  return [...new Set(keys)].sort();
}

export function hasPurchaserDashboardAccess(session: AdminSession | null | undefined, key: string) {
  return session?.role === 'purchaser'
    && parseDashboardAccess([key]) !== null
    && Boolean(session.sessionId)
    && Number.isSafeInteger(session.adminUserId) && Number(session.adminUserId) > 0
    && Array.isArray(session.dashboardAccess) && session.dashboardAccess.includes(key);
}

/** Call only after the ordinary TOP session guard. A grant never implies management. */
export function canReadTopDashboardBlock(session: AdminSession, blockId: number) {
  return session.role !== 'purchaser' || hasPurchaserDashboardAccess(session, `top:${blockId}`);
}

export function canAccessRoutePlanner(session: AdminSession | null | undefined) {
  if (!session?.sessionId) return false;
  if (session.role === 'admin') return true;
  if (session.role === 'admintop') return Number.isSafeInteger(session.adminUserId) && Number(session.adminUserId) > 0;
  if (session.role === 'support_manager') return Number.isSafeInteger(session.managerId) && Number(session.managerId) > 0;
  return hasPurchaserDashboardAccess(session, 'route-planner');
}

export function getReportEntries(session: AdminSession | null | undefined): DashboardAccessOption[] {
  if (!session?.sessionId) return [];
  return DASHBOARD_REPORT_OPTIONS.filter(({key}) => {
    if (key === 'route-planner') return canAccessRoutePlanner(session);
    if (session.role === 'admin' || (session.role === 'admintop' && Number(session.adminUserId) > 0)) return true;
    if (session.role === 'manager' && Number(session.managerId) > 0) return key === 'manager:development';
    if (session.role === 'support_manager' && Number(session.managerId) > 0) return key === 'manager:support';
    return false;
  });
}

/** Catalog visibility is distinct from permission to read any individual report. */
export function canAccessReportsCatalog(session: AdminSession | null | undefined) {
  if (!session) return false;
  if (session.role === 'admin') return true;
  if (session.role === 'top' || session.role === 'admintop') return Number.isSafeInteger(session.adminUserId) && Number(session.adminUserId) > 0;
  if (session.role === 'purchaser') return Boolean(session.sessionId) && Number.isSafeInteger(session.adminUserId) && Number(session.adminUserId) > 0;
  return getReportEntries(session).length > 0;
}
