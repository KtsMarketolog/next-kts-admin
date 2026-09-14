type ClientRealtimeSyncOptions = {
  eventsEndpoint: string;
  eventTypes: string[];
  refresh: (signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
};

/** SSE is a fast path only: each worker has its own event bus. Re-read authorized
 * endpoints periodically so a missed event, reconnect or another worker converges. */
export function startClientRealtimeSync({
  eventsEndpoint, eventTypes, refresh, onError, intervalMs = 15_000,
}: ClientRealtimeSyncOptions) {
  let stopped = false;
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let events: EventSource | undefined;

  const canRefresh = () => document.visibilityState !== 'hidden' && navigator.onLine !== false;
  const schedule = (delay: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => { void run(); }, delay);
  };
  const run = async () => {
    if (stopped) return;
    if (!canRefresh()) { schedule(intervalMs); return; }
    if (running) { pending = true; return; }
    running = true;
    controller = new AbortController();
    const activeController = controller;
    const timeout = setTimeout(() => activeController.abort(), 10_000);
    try {
      await refresh(activeController.signal);
    } catch (error) {
      if (!stopped) onError?.(error);
    } finally {
      clearTimeout(timeout);
      activeController.abort();
      running = false;
      if (!stopped) {
        // Coalesce bursts (including read-receipt events) instead of concurrent fetches.
        schedule(pending ? 250 : intervalMs);
        pending = false;
      }
    }
  };
  const requestRefresh = () => {
    if (stopped || !canRefresh()) return;
    if (running) pending = true;
    else schedule(250);
  };

  // An unsupported/blocked SSE connection must not disable the polling fallback.
  try {
    events = new EventSource(eventsEndpoint);
    for (const type of [...eventTypes, 'connected', 'open']) events.addEventListener(type, requestRefresh);
  } catch { /* The authenticated refresh remains available. */ }
  window.addEventListener('focus', requestRefresh);
  window.addEventListener('online', requestRefresh);
  document.addEventListener('visibilitychange', requestRefresh);
  void run();

  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    events?.close();
    window.removeEventListener('focus', requestRefresh);
    window.removeEventListener('online', requestRefresh);
    document.removeEventListener('visibilitychange', requestRefresh);
  };
}
