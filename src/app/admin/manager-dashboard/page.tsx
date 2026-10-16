import { redirect } from 'next/navigation';

import { ManagerDashboard } from '@/features/admin/manager-dashboard/ManagerDashboard';
import { ManagerDashboardReview } from '@/features/admin/manager-dashboard/ManagerDashboardReview';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAssignDashboardAccess } from '@/shared/lib/dashboardPermissions';
import { getPersonalDashboardAudience, parsePersonalDashboardAudience } from '@/shared/lib/managerDashboardAudience';
import { canReviewPersonalDevelopmentDashboards, canViewOwnPersonalDevelopmentDashboard, personalDashboardMode } from '@/shared/lib/managerDashboardSecurity';

export const dynamic = 'force-dynamic';

export default async function ManagerDashboardPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await getAdminSession();
  const query = await searchParams;
  const canViewOwn = canViewOwnPersonalDevelopmentDashboard(session);
  const canReviewTeam = canReviewPersonalDevelopmentDashboards(session);
  if (canViewOwn && (query.view === 'personal' || canReviewTeam && query.view !== 'team')) {
    if (query.audience !== undefined && query.audience !== 'development') redirect('/admin/manager-dashboard?view=personal&audience=development');
    return <ManagerDashboard mode="view" audience="development" own ownReturn={canReviewTeam ? 'team' : 'manage'} />;
  }
  if (canReviewTeam) {
    if (query.audience !== undefined && query.audience !== 'development') redirect('/admin/manager-dashboard?audience=development');
    return <ManagerDashboardReview canViewOwn={canViewOwn} />;
  }
  const mode = personalDashboardMode(session);
  if (!mode) redirect('/admin');

  const requestedAudience = parsePersonalDashboardAudience(query.audience);
  // The URL selects an administrator's presentation, never a manager's access.
  const audience = mode === 'view' ? getPersonalDashboardAudience(session!.role) : requestedAudience;
  if (query.audience !== undefined && (!requestedAudience || requestedAudience !== audience)) {
    redirect(mode === 'view' && audience ? `/admin/manager-dashboard?audience=${audience}` : '/admin/manager-dashboard');
  }

  return <ManagerDashboard mode={mode} audience={audience} canAssignAccess={canAssignDashboardAccess(session)} canViewOwn={canViewOwn} />;
}
