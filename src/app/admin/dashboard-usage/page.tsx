import { redirect } from 'next/navigation';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { DashboardUsageJournal } from '@/features/admin/dashboard-usage/DashboardUsageJournal';
import { canReviewDashboardUsage } from '@/shared/lib/dashboardUsageAccess';

export const dynamic = 'force-dynamic';

export default async function DashboardUsagePage() {
  const session = await getAdminSession();
  if (!canReviewDashboardUsage(session)) redirect('/admin');
  return <DashboardUsageJournal />;
}
