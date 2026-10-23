import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { QueryResultRow } from 'pg';
import { query } from '../../client';

type Stage = { stage: string; wallMs: number };
const traces = new AsyncLocalStorage<{ stages: Stage[]; cache: string }>();

/** Timings only: never emit SQL, query parameters, actors, session IDs or results. */
export async function measureAnalytics<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await work(); }
  finally { traces.getStore()?.stages.push({ stage, wallMs: Number((performance.now() - start).toFixed(2)) }); }
}

export function analyticsQuery<T extends QueryResultRow = QueryResultRow>(stage: string, sql: string, params?: unknown[]) {
  return measureAnalytics(stage, () => query<T>(sql, params));
}

export function analyticsCacheState(cache: 'hit' | 'miss' | 'coalesced' | 'bypass') {
  const trace = traces.getStore();
  if (trace) trace.cache = cache;
}

export async function traceAnalytics<T>(operation: 'admin' | 'manager' | 'extended', work: () => Promise<T>) {
  // Extended analytics calls the base report internally; keep a single trace.
  if (traces.getStore()) return work();
  const start = performance.now();
  const cpu = process.cpuUsage();
  const trace = { stages: [] as Stage[], cache: 'bypass' };
  let status = 'ok';
  return traces.run(trace, async () => {
    try { return await work(); }
    catch (error) { status = 'error'; throw error; }
    finally {
      const wallMs = performance.now() - start;
      if (wallMs >= 250 || process.env.WHOLESALE_ANALYTICS_PERFORMANCE_LOG === '1') {
        const usage = process.cpuUsage(cpu);
        console.info(JSON.stringify({ event: 'wholesale_analytics_performance', operation, status,
          wallMs: Number(wallMs.toFixed(2)), processCpuMs: (usage.user + usage.system) / 1000,
          cpuScope: 'process_interval_includes_concurrent_work', cache: trace.cache, stages: trace.stages }));
      }
    }
  });
}
