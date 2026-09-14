import { redirect } from 'next/navigation';

import { ManagerDashboard } from '@/features/admin/manager-dashboard/ManagerDashboard';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { personalDashboardMode } from '@/shared/lib/managerDashboardSecurity';

export const dynamic = 'force-dynamic';

export default async function ManagerDashboardPage() {
  const session = await getAdminSession();
  const mode = personalDashboardMode(session);
  if (!mode) redirect('/admin');

  return <ManagerDashboard mode={mode} />;
}
