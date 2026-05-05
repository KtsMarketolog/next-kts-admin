import { redirect } from 'next/navigation';

import AdminPanel from '../../AdminPanel';
import { getAdminSession } from '@/shared/lib/adminAuth';

export const dynamic = 'force-dynamic';

export default async function AdminSiteUsersPage() {
  const session = await getAdminSession();
  if (session && session.role !== 'admin') {
    redirect('/admin');
  }

  return <AdminPanel initialArea="site" initialSession={session} />;
}
