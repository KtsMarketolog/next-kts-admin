import { performance } from 'node:perf_hooks';

/** CPU deltas are process-wide observations, not attribution to one concurrent request. */
export function createPricePerformanceTrace(operation: string) {
  const started = performance.now();
  const stages: Array<{ stage: string; wallMs: number; processCpuMs: number }> = [];
  let finished = false;
  const safeName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  function startStage(stage: string) {
    const start = performance.now();
    const cpu = process.cpuUsage();
    return () => {
      const delta = process.cpuUsage(cpu);
      stages.push({ stage: safeName(stage), wallMs: performance.now() - start, processCpuMs: (delta.user + delta.system) / 1000 });
    };
  }
  return {
    async measure<T>(stage: string, work: () => Promise<T>): Promise<T> {
      const end = startStage(stage);
      try { return await work(); } finally { end(); }
    },
    measureSync<T>(stage: string, work: () => T): T {
      const end = startStage(stage);
      try { return work(); } finally { end(); }
    },
    header() {
      return stages.map(({ stage, wallMs }) => `${stage};dur=${wallMs.toFixed(1)}`).join(', ');
    },
    finish(status: number | string) {
      if (finished) return;
      finished = true;
      const wallMs = performance.now() - started;
      // Log all slow operations, or opt into all samples during an investigation.
      // Never log tokens, client names, prices, submitted contents or query strings.
      if (wallMs < 250 && process.env.PRICE_PERFORMANCE_LOG !== '1') return;
      console.info(JSON.stringify({
        event: 'public_price_performance', operation: safeName(operation), status: safeName(String(status)),
        wallMs: Number(wallMs.toFixed(1)), cpuScope: 'process_interval_includes_concurrent_work',
        stages: stages.map((stage) => ({ ...stage, wallMs: Number(stage.wallMs.toFixed(1)), processCpuMs: Number(stage.processCpuMs.toFixed(1)) })),
      }));
    },
  };
}

export type PricePerformanceTrace = ReturnType<typeof createPricePerformanceTrace>;
