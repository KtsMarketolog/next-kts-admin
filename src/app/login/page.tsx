import { LoginPanel } from '@/features/auth/LoginPanel';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { getClientSession } from '@/shared/lib/clientAuth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

type LoginPageProps = {
  searchParams?: Promise<{
    mode?: string | string[];
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [employeeSession, clientSession, params] = await Promise.all([
    getAdminSession(),
    getClientSession(),
    searchParams ?? Promise.resolve({} as { mode?: string | string[] }),
  ]);

  if (employeeSession) redirect('/admin/clients');
  if (clientSession) redirect('/cabinet');

  const modeParam = Array.isArray(params.mode) ? params.mode[0] : params.mode;
  const defaultMode = modeParam === 'employee' ? 'employee' : 'client';

  return <LoginPanel defaultMode={defaultMode} />;
}
