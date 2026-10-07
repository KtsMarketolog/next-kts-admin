import { redirect } from 'next/navigation';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { DashboardUsageJournal } from '@/features/admin/dashboard-usage/DashboardUsageJournal';

export const dynamic = 'force-dynamic';

export default async function DashboardUsagePage() {
  const session = await getAdminSession();
  if (!session?.sessionId || session.role !== 'admin') redirect('/admin');
  return <DashboardUsageJournal />;
}
