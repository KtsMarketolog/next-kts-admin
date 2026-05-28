import AdminPanel from '../../AdminPanel';
import { getAdminSession } from '@/shared/lib/adminAuth';

export const dynamic = 'force-dynamic';

export default async function AdminClientDetailPage() {
  const session = await getAdminSession();
  return <AdminPanel initialArea="clients" initialSession={session} />;
}
