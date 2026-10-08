import { redirect } from 'next/navigation';

import AdminPanel from '../../AdminPanel';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAssignDashboardAccess } from '@/shared/lib/dashboardPermissions';
import { UsersAdministration } from './UsersAdministration';

export const dynamic = 'force-dynamic';

export default async function AdminSiteUsersPage() {
  const session = await getAdminSession();
  if (session && !canAssignDashboardAccess(session)) {
    redirect('/admin');
  }

  if (session?.role === 'admintop') return <UsersAdministration />;

  return <AdminPanel initialArea="site" initialSession={session} />;
}
