import { tryAcquireSessionAdvisoryLock } from './db/client';

declare global {
  var __ktsTopDashboardDataUploadInFlight: boolean | undefined;
}

export function acquireTopDashboardDataUploadSlot() {
  if (globalThis.__ktsTopDashboardDataUploadInFlight) return null;

  globalThis.__ktsTopDashboardDataUploadInFlight = true;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    globalThis.__ktsTopDashboardDataUploadInFlight = false;
  };
}

export async function acquireDistributedTopDashboardDataUploadSlot() {
  const releaseLocalSlot = acquireTopDashboardDataUploadSlot();
  if (!releaseLocalSlot) return null;

  let releaseDatabaseSlot: Awaited<ReturnType<typeof tryAcquireSessionAdvisoryLock>>;
  try {
    releaseDatabaseSlot = await tryAcquireSessionAdvisoryLock(
      'kts_top_dashboard_data_upload',
    );
  } catch (error) {
    releaseLocalSlot();
    throw error;
  }
  if (!releaseDatabaseSlot) {
    releaseLocalSlot();
    return null;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await releaseDatabaseSlot();
    } finally {
      releaseLocalSlot();
    }
  };
}
