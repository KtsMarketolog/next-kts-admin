import { getAdminSession } from '@/shared/lib/adminAuth';
import AdminPanel from '@/app/admin/AdminPanel';

export default async function AdminWholesaleManagerAnalyticsPage() {
  const session = await getAdminSession();
  return <AdminPanel initialArea="wholesale" initialSession={session} />;
}
