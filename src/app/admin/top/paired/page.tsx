import { redirect } from 'next/navigation';
import { DashboardPair } from '@/features/admin/dashboard-pair/DashboardPair';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAccessReportsCatalog } from '@/shared/lib/dashboardAccess';

export const dynamic = 'force-dynamic';

export default async function PairedDashboardPage() {
  const session = await getAdminSession();
  if (!canAccessReportsCatalog(session)) redirect('/admin');
  return <DashboardPair />;
}
