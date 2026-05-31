import { redirect } from 'next/navigation';

import { getAdminSession } from '@/shared/lib/adminAuth';
import { getClientSession } from '@/shared/lib/clientAuth';
import { getClientDocumentsForClient, getClientPortalProfile, getClientPriceRequestsForClient } from '@/shared/lib/db';
import { ClientCabinetShell } from './ClientCabinetShell';

export const dynamic = 'force-dynamic';

export default async function ClientCabinetPage() {
  const employeeSession = await getAdminSession();
  if (employeeSession) redirect('/admin/clients');

  const session = await getClientSession();
  if (!session) redirect('/login?mode=client');

  const profile = await getClientPortalProfile(session.clientUserId);
  if (!profile) redirect('/login?mode=client');
  const [documents, requests] = await Promise.all([
    getClientDocumentsForClient(session.companyId),
    getClientPriceRequestsForClient(session.companyId),
  ]);

  return <ClientCabinetShell documents={documents} profile={profile} requests={requests} />;
}
