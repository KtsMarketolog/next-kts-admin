import type { AdminSession, AdminSessionRole } from './adminAuth';

/** Captured from an already authorized server session; never supplied by a request body. */
export type DashboardUploadUsageActor = { actorKey: string; actorRole: AdminSessionRole };
export type DashboardUploadUsageInput = {
  dashboardKey: string; versionId: number | null; resourceKey: string;
  name: string; size: number; type: 'html' | 'data' | 'personal';
};

export function getDashboardUploadUsageActor(session: AdminSession): DashboardUploadUsageActor {
  if (!session.sessionId) throw new Error('Invalid upload actor');
  const manager = session.role === 'manager' || session.role === 'support_manager';
  const id = manager ? session.managerId : session.adminUserId;
  if (Number.isSafeInteger(id) && Number(id) > 0) {
    return { actorKey: `${manager ? 'manager' : 'admin'}:${id}`, actorRole: session.role };
  }
  if (!manager && session.role === 'admin' && session.adminUserId === undefined) return { actorKey: 'admin:primary', actorRole: session.role };
  throw new Error('Invalid upload actor');
}

/** The durable intent already committed with the saved resource. This is only a low-latency nudge. */
export function scheduleDashboardUploadUsageDrain() {
  void import('./dashboardUploadUsageWorker').then(({ requestDashboardUploadUsageDrain }) => {
    requestDashboardUploadUsageDrain();
  }).catch(() => { console.error('DASHBOARD_UPLOAD_USAGE_DRAIN_SCHEDULE_FAILED'); });
}
