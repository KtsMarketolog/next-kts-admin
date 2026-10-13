import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';

import { CurrencyDashboard } from '@/features/admin/currency-dashboard/CurrencyDashboard';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAssignDashboardAccess } from '@/shared/lib/dashboardPermissions';
import { canAccessCurrencyDashboard, canManageCurrencyDashboard } from '@/shared/lib/currencyDashboardAccess';
import { currencyDashboardDeviceScope } from '@/shared/lib/currencyDashboardDeviceState';

export const dynamic = 'force-dynamic';

export default async function CurrencyDashboardPage() {
  const session = await getAdminSession();
  if (!canAccessCurrencyDashboard(session)) redirect('/admin');
  return <CurrencyDashboard nonce={randomUUID()} deviceScope={currencyDashboardDeviceScope(session)} canManage={canManageCurrencyDashboard(session)} canAssignAccess={canAssignDashboardAccess(session)} />;
}
