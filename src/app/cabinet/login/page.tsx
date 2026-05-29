import { redirect } from 'next/navigation';

import { getAdminSession } from '@/shared/lib/adminAuth';
import { getClientSession } from '@/shared/lib/clientAuth';
import { ClientLoginForm } from './ClientLoginForm';

export const dynamic = 'force-dynamic';

export default async function ClientLoginPage() {
  const employeeSession = await getAdminSession();
  if (employeeSession) redirect('/admin/clients');

  const session = await getClientSession();
  if (session) redirect('/cabinet');

  return <ClientLoginForm />;
}
