import { redirect } from 'next/navigation';

import { getClientSession } from '@/shared/lib/clientAuth';
import { ClientLoginForm } from './ClientLoginForm';

export const dynamic = 'force-dynamic';

export default async function ClientLoginPage() {
  const session = await getClientSession();
  if (session) redirect('/cabinet');

  return <ClientLoginForm />;
}
