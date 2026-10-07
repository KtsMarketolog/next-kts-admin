import type { AdminSession } from './adminAuth';
import type { SharedDashboardViewer } from './db/supportSharedDashboardRepo';
import { canViewDashboardKey, hasDashboardIdentity, validDashboardKey } from './dashboardPermissions';
export { canViewDashboardKey as canViewDashboard } from './dashboardPermissions';

/** Only use after the report guard; the repository rechecks the persisted identity and viewing authority. */
export function getSharedDashboardViewer(session: AdminSession): SharedDashboardViewer {
  if (session.role === 'admin' && !session.adminUserId) return {adminSessionId: session.sessionId ?? ''};
  return session.role === 'manager' || session.role === 'support_manager'
    ? session.managerId! : {adminUserId: session.adminUserId!};
}

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
  { key: 'currency-rates', title: 'Курсы валют и медь', href: '/admin/top/currency-rates', description: 'Курсы ЦБ, биржевые котировки, прогнозы и сводка по месяцам.' },
];

// Legacy subset retained for clients importing this constant; the universal editor uses DASHBOARD_REPORT_OPTIONS.
export const PURCHASER_DASHBOARD_REPORT_OPTIONS: DashboardAccessOption[] = DASHBOARD_REPORT_OPTIONS.filter(({ key }) => key === 'route-planner');

export function parseDashboardAccess(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  for (const key of value) {
    if (typeof key !== 'string') return null;
    if (!validDashboardKey(key)) return null;
    keys.push(key);
  }
  return [...new Set(keys)].sort();
}

export function hasPurchaserDashboardAccess(session: AdminSession | null | undefined, key: string) {
  return session?.role === 'purchaser'
    && !key.startsWith('manager:')
    && parseDashboardAccess([key]) !== null
    && Boolean(session.sessionId)
    && Number.isSafeInteger(session.adminUserId) && Number(session.adminUserId) > 0
    && Array.isArray(session.dashboardAccess) && session.dashboardAccess.includes(key);
}

/** Call only after the ordinary TOP session guard. A grant never implies management. */
export function canReadTopDashboardBlock(session: AdminSession, blockId: number) {
  return Number.isSafeInteger(blockId) && blockId > 0 && canViewDashboardKey(session, `top:${blockId}`);
}

export function canAccessRoutePlanner(session: AdminSession | null | undefined) {
  return canViewDashboardKey(session, 'route-planner');
}

export function getReportEntries(session: AdminSession | null | undefined): DashboardAccessOption[] {
  if (!session?.sessionId) return [];
  return DASHBOARD_REPORT_OPTIONS.filter(({key}) => canViewDashboardKey(session, key));
}

/** Catalog visibility is distinct from permission to read any individual report. */
export function canAccessReportsCatalog(session: AdminSession | null | undefined) {
  return hasDashboardIdentity(session);
}
