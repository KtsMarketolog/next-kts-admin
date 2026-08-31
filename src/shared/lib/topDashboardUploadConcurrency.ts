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
