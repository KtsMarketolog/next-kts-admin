import type { AdminSession } from './adminAuth';
import { canViewDashboardKey, hasDashboardManagementRight } from './dashboardPermissions';

/** Read-only grants do not imply permission to edit shared currency inputs. */
export function canAccessCurrencyDashboard(
  session: AdminSession | null | undefined,
): session is AdminSession & { sessionId: string } {
  return canViewDashboardKey(session, 'currency-rates');
}

/** TOP and managers keep their existing management grant; viewing alone never grants writes. */
export function canManageCurrencyDashboard(session: AdminSession | null | undefined): boolean {
  return hasDashboardManagementRight(session, 'currency-rates');
}

export const CURRENCY_PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
} as const;
