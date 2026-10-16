import { createHash } from 'node:crypto';
import type { AdminSession } from './adminAuth';
import { recordDashboardUsage } from './db/dashboardUsageRepo';
import { withTransaction } from './db/client';

/** Call after a successful server save, never after mere file selection/validation.
 * A journal outage must not turn an already committed upload into a false failure.
 * Retries keep an immutable id derived from the saved resource, without file bytes.
 */
export async function recordDashboardUploadUsage(session: AdminSession, input: {
  dashboardKey: string; versionId: number | null; resourceKey: string;
  name: string; size: number; type: 'html' | 'data' | 'personal';
}): Promise<boolean> {
  const basename = input.name.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 255) || '';
  const name = !basename || basename === '.' || basename === '..' ? 'file' : basename;
  const id = `upload_${createHash('sha256').update(input.resourceKey).digest('hex')}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await recordDashboardUsage(session, { dashboardKey: input.dashboardKey, versionId: input.versionId,
        preview: false, events: [{ id, action: 'file_uploaded', upload: { name, size: input.size }, uploadType: input.type }] });
      return true;
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  console.error('DASHBOARD_UPLOAD_USAGE_WRITE_FAILED');
  return false;
}

/** Resolve the recipient's group from the account, never from an uploaded filename. */
export async function recordPersonalSnapshotUploadUsage(session: AdminSession, input: {
  managerId?: number; adminUserId?: number; snapshotId: number; name: string; size: number;
}): Promise<boolean> {
  try {
    const isLeader = input.adminUserId !== undefined;
    const id = isLeader ? input.adminUserId : input.managerId;
    if (!Number.isSafeInteger(id) || Number(id) < 1 || (isLeader && input.managerId !== undefined)) return false;
    const result = await withTransaction(async (client) => {
      await client.query("set local statement_timeout='3s'");
      await client.query("set local lock_timeout='1s'");
      return client.query<{ role: string }>(isLeader
        ? 'select role from admin_users where id=$1 and is_active'
        : 'select coalesce(nullif(role,\'\'),\'manager\') as role from wholesale_managers where id=$1', [id]);
    });
    const role = result.rows[0]?.role;
    if (isLeader ? !['admin', 'admintop', 'top'].includes(role) : role !== 'manager' && role !== 'support_manager') return false;
    return await recordDashboardUploadUsage(session, { dashboardKey: role === 'support_manager' ? 'manager:support' : 'manager:development',
      versionId: null, resourceKey: `personal-snapshot:${input.snapshotId}`, name: input.name, size: input.size, type: 'personal' });
  } catch {
    console.error('DASHBOARD_UPLOAD_USAGE_WRITE_FAILED');
    return false;
  }
}
