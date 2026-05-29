import { redirect } from 'next/navigation';

import { getAdminSession } from '@/shared/lib/adminAuth';
import { getClientSession } from '@/shared/lib/clientAuth';
import { getClientDocumentsForClient, getClientPortalProfile } from '@/shared/lib/db';
import { ClientCabinetShell } from './ClientCabinetShell';

export const dynamic = 'force-dynamic';

export default async function ClientCabinetPage() {
  const employeeSession = await getAdminSession();
  if (employeeSession) redirect('/admin/clients');

  const session = await getClientSession();
  if (!session) redirect('/cabinet/login');

  const profile = await getClientPortalProfile(session.clientUserId);
  if (!profile) redirect('/cabinet/login');
  const documents = await getClientDocumentsForClient(session.companyId);

  return <ClientCabinetShell documents={documents} profile={profile} />;
}
