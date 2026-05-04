import AdminPanel from '../AdminPanel';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function AdminWholesalePage() {
  const session = await getAdminSession();
  if (session?.role === 'admin' || session?.role === 'wholesale_admin') {
    redirect('/admin/wholesale/admin');
  }
  if (session?.role === 'manager') {
    redirect('/admin/wholesale/manager');
  }

  return <AdminPanel initialArea="wholesale" initialSession={session} />;
}
