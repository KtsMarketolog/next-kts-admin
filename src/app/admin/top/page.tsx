import { redirect } from 'next/navigation';

import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAccessReportsCatalog } from '@/shared/lib/dashboardAccess';

import AdminPanel from '../AdminPanel';

export const dynamic = 'force-dynamic';

export default async function AdminTopPage() {
  const session = await getAdminSession();
  if (session && !canAccessReportsCatalog(session)) {
    redirect('/admin');
  }

  return <AdminPanel initialArea="top" initialSession={session} />;
}
