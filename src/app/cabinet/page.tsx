import { redirect } from 'next/navigation';

import { getClientSession } from '@/shared/lib/clientAuth';
import { getClientPortalProfile } from '@/shared/lib/db';
import { ClientCabinetShell } from './ClientCabinetShell';

export const dynamic = 'force-dynamic';

export default async function ClientCabinetPage() {
  const session = await getClientSession();
  if (!session) redirect('/cabinet/login');

  const profile = await getClientPortalProfile(session.clientUserId);
  if (!profile) redirect('/cabinet/login');

  return <ClientCabinetShell profile={profile} />;
}
