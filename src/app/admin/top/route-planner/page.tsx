import { redirect } from 'next/navigation';

import { ManagerDashboard } from '@/features/admin/manager-dashboard/ManagerDashboard';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAccessRoutePlanner } from '@/shared/lib/dashboardAccess';
import { personalDashboardMode } from '@/shared/lib/managerDashboardSecurity';

export const dynamic = 'force-dynamic';

export default async function RoutePlannerPage() {
  const session = await getAdminSession();
  if (!canAccessRoutePlanner(session)) redirect('/admin/top');
  return <ManagerDashboard section="shared" mode={personalDashboardMode(session) === 'manage' ? 'manage' : 'view'} />;
}
