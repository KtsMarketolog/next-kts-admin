import { drainDashboardUploadUsageOutbox } from './db/dashboardUploadUsageOutboxRepo';

type UploadUsageWorkerState = { timer?: ReturnType<typeof setInterval>; scheduled: boolean; running: Promise<void> | null };
declare global { var __ktsDashboardUploadUsageWorker: UploadUsageWorkerState | undefined; }

function state() {
  return globalThis.__ktsDashboardUploadUsageWorker ??= { scheduled: false, running: null };
}

/** One bounded batch per tick. Failed journal writes leave their durable intents untouched. */
export function requestDashboardUploadUsageDrain() {
  const worker = state();
  if (worker.running || worker.scheduled) return;
  worker.scheduled = true;
  const immediate = setImmediate(() => {
    worker.scheduled = false;
    worker.running = drainDashboardUploadUsageOutbox().then(() => undefined)
      .catch(() => { console.error('DASHBOARD_UPLOAD_USAGE_DRAIN_FAILED'); })
      .finally(() => { worker.running = null; });
  });
  immediate.unref();
}

/** Start only after runtime schema preparation, never as a module import/build side effect. */
export function startDashboardUploadUsageWorker() {
  const worker = state();
  if (worker.timer) return;
  worker.timer = setInterval(requestDashboardUploadUsageDrain, 30_000);
  worker.timer.unref();
  requestDashboardUploadUsageDrain();
}
