import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';

import { CurrencyDashboard } from '@/features/admin/currency-dashboard/CurrencyDashboard';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAccessCurrencyDashboard } from '@/shared/lib/currencyDashboardAccess';

export const dynamic = 'force-dynamic';

export default async function CurrencyDashboardPage() {
  const session = await getAdminSession();
  if (!canAccessCurrencyDashboard(session)) redirect('/admin');
  return <CurrencyDashboard nonce={randomUUID()} />;
}
