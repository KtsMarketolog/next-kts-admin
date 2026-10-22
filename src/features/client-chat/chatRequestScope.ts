/** AbortSignal.any is not available in the older Safari versions supported by
 * the site. Keep cancellation/deadline wiring local and release every listener. */
export function createChatRequestScope(signals: Array<AbortSignal | undefined>, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  for (const signal of active) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      for (const signal of active) signal.removeEventListener('abort', abort);
    },
  };
}
