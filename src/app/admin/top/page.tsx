import { redirect } from 'next/navigation';

import { getAdminSession } from '@/shared/lib/adminAuth';

import AdminPanel from '../AdminPanel';

export const dynamic = 'force-dynamic';

export default async function AdminTopPage() {
  const session = await getAdminSession();
  if (session && session.role !== 'admin' && session.role !== 'top') {
    redirect('/admin');
  }

  return <AdminPanel initialArea="top" initialSession={session} />;
}
