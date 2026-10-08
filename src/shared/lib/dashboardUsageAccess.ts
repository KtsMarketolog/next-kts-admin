import type { AdminSession } from './adminAuth';
import { hasDashboardIdentity } from './dashboardPermissions';

/** Journal visibility is a distinct permission, never inherited from a report checkbox. */
export function canReviewDashboardUsage(session: AdminSession | null | undefined): boolean {
  return hasDashboardIdentity(session) && ['admin', 'admintop', 'top'].includes(session.role);
}
