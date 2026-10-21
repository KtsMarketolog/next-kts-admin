import { createHash } from 'node:crypto';
import { failPriceBuild, failQueuedPriceBuild, heartbeatPriceBuild, invalidatePriceBuildResult, publishPriceBuild,
  readOrEnqueuePriceBuild, readPriceBuildJob, tryClaimPriceBuild,
  type PriceBuildArtifact, type PriceBuildJob, type PriceBuildLease } from '../db/priceBuildRepo';
import { PriceBuildError } from './errors';
import { PRICE_BUILD_CACHE_TTL_MS, readPriceBuildArtifact, removePriceBuildArtifact, writePriceBuildArtifact } from './sharedCache';

export type SharedPriceBuildOptions<T> = {
  key: string;
  build: (context: { signal: AbortSignal; deadlineAt: number }) => Promise<{ value: T; encoded: Uint8Array; cacheable?: boolean }>;
  decode: (encoded: Uint8Array, signal: AbortSignal) => Promise<T>;
  onState?: (state: 'hit' | 'queued' | 'shared' | 'build') => void;
  /** A cancelled observer detaches; it cannot cancel another process's coalesced work. */
  signal?: AbortSignal;
};
type Timings = { queueWaitMs: number; buildTimeoutMs: number; pollMs: number; heartbeatMs: number; leaseMs: number };
const DEFAULT_TIMINGS: Timings = { queueWaitMs: 30_000, buildTimeoutMs: 60_000, pollMs: 350, heartbeatMs: 3_000, leaseMs: 15_000 };

function errorOf(error: unknown) {
  if (error instanceof PriceBuildError) return error;
  const failure = new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
  // Keep the original diagnostic server-side; user responses use only the safe typed message.
  Object.defineProperty(failure, 'cause', { value: error });
  return failure;
}
function throwIfAborted(signal: AbortSignal) { if (signal.aborted) throw errorOf(signal.reason); }
function emit<T>(options: SharedPriceBuildOptions<T>, state: Parameters<NonNullable<SharedPriceBuildOptions<T>['onState']>>[0]) {
  try { options.onState?.(state); } catch { /* Telemetry never changes admission or saved data. */ }
}

/** The factory's timing seam is restricted to disposable tests; runtime limits are not request-controlled. */
export function createSharedPriceBuildCoordinator(testTimings?: Partial<Timings>) {
  if (testTimings && (process.env.NODE_ENV !== 'test' || process.env.KTS_PRICE_BUILD_TEST !== '1')) throw new Error('Price build timing overrides are test-only');
  const timings = { ...DEFAULT_TIMINGS, ...testTimings };
  if (Object.values(timings).some(value => !Number.isSafeInteger(value) || value <= 0)
    || timings.heartbeatMs >= timings.leaseMs) throw new Error('Invalid price build deadlines');
  const pending = new Map<string, Promise<unknown>>();

  async function execute<T>(options: SharedPriceBuildOptions<T>): Promise<T> {
    const keyHash = createHash('sha256').update(options.key).digest('hex');
    const queuedDeadline = Date.now() + timings.queueWaitMs;
    let job = await readOrEnqueuePriceBuild(keyHash, timings.queueWaitMs);
    let waited = false;
    let cacheRepairAttempted = false;
    try { while (true) {
      if (job.state === 'failed') throw new PriceBuildError(job.error_code ?? 'PRICE_BUILD_UNAVAILABLE');
      if (job.state === 'ready') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new PriceBuildError('PRICE_BUILD_TIMEOUT')), timings.buildTimeoutMs);
        try {
          const encoded = await readPriceBuildArtifact(job, controller.signal);
          if (encoded) {
            const value = await options.decode(encoded, controller.signal);
            throwIfAborted(controller.signal);
            emit(options, waited ? 'shared' : 'hit');
            return value;
          }
        } catch (error) {
          // An interrupted read is not evidence that the immutable artifact is corrupt.
          if (controller.signal.aborted) throw errorOf(error);
          // Failed decoding/hash/open: invalidate this derived receipt, then bounded rebuild.
        } finally { clearTimeout(timer); }
        if (cacheRepairAttempted) throw new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
        cacheRepairAttempted = true;
        await invalidatePriceBuildResult(job);
        if (job.result_file) await removePriceBuildArtifact(job.result_file).catch(() => {});
        job = await readOrEnqueuePriceBuild(keyHash, timings.queueWaitMs);
        continue;
      }
      if (job.state === 'queued' && Date.now() >= queuedDeadline) throw new PriceBuildError('PRICE_BUILD_TIMEOUT');
      const controller = new AbortController();
      const lease = await tryClaimPriceBuild(job, { buildTimeoutMs: timings.buildTimeoutMs, leaseMs: timings.leaseMs,
        onDisconnect: () => controller.abort(new PriceBuildError('PRICE_BUILD_UNAVAILABLE')) });
      if (lease) return buildOwned(options, lease, controller);
      if (!waited) { emit(options, 'queued'); waited = true; }
      // Active work has its own 60s hard deadline; a follower does not cut it to the queue's 30s.
      if (job.state === 'active' && job.deadline_at && Date.now() >= job.deadline_at.getTime() + timings.leaseMs) {
        throw new PriceBuildError('PRICE_BUILD_TIMEOUT');
      }
      await new Promise<void>(resolve => setTimeout(resolve, timings.pollMs + Math.floor(Math.random() * timings.pollMs / 4)));
      const latest: PriceBuildJob | null = await readPriceBuildJob(keyHash);
      if (!latest || latest.generation !== job.generation) throw new PriceBuildError('PRICE_BUILD_TIMEOUT');
      job = latest;
    } } catch (error) {
      const failure = errorOf(error);
      // Exact generation + queued-only CAS cannot abort work another process claimed.
      await failQueuedPriceBuild(job, failure.code).catch(() => {});
      throw failure;
    }
  }

  async function buildOwned<T>(options: SharedPriceBuildOptions<T>, lease: PriceBuildLease, controller: AbortController): Promise<T> {
    emit(options, 'build');
    let artifact: PriceBuildArtifact | null = null;
    let published = false;
    let heartbeat: Promise<void> | null = null;
    const deadline = lease.job.deadline_at!.getTime();
    const timer = setTimeout(() => controller.abort(new PriceBuildError('PRICE_BUILD_TIMEOUT')), Math.max(1, deadline - Date.now()));
    const interval = setInterval(() => {
      if (heartbeat || controller.signal.aborted) return;
      heartbeat = heartbeatPriceBuild(lease, timings.leaseMs)
        .catch(() => { controller.abort(new PriceBuildError('PRICE_BUILD_UNAVAILABLE')); })
        .finally(() => { heartbeat = null; });
    }, timings.heartbeatMs);
    try {
      throwIfAborted(controller.signal);
      // The supplied worker promise must settle only after the worker has stopped,
      // including abort. Never race it and release admission with CPU still running.
      const result = await options.build({ signal: controller.signal, deadlineAt: deadline });
      throwIfAborted(controller.signal);
      if (result.cacheable !== false && result.value !== null && result.value !== undefined) {
        artifact = await writePriceBuildArtifact(lease.job.key_hash, lease.ownerId, result.encoded, controller.signal);
      }
      throwIfAborted(controller.signal);
      if (artifact) {
        await publishPriceBuild(lease, artifact, PRICE_BUILD_CACHE_TTL_MS);
        published = true;
      } else {
        // A changed-revision/null/oversized result is returned to this owner only,
        // never advertised as a valid shared result for an outdated key.
        await failPriceBuild(lease, 'PRICE_BUILD_UNAVAILABLE');
      }
      return result.value;
    } catch (error) {
      const failure = controller.signal.aborted ? errorOf(controller.signal.reason) : errorOf(error);
      controller.abort(failure);
      await failPriceBuild(lease, failure.code).catch(() => {});
      throw failure;
    } finally {
      clearTimeout(timer); clearInterval(interval);
      await heartbeat;
      if (artifact && !published) await removePriceBuildArtifact(artifact.file).catch(() => {});
      await lease.close();
    }
  }

  return function run<T>(options: SharedPriceBuildOptions<T>): Promise<T> {
    if (!options.key || options.key.length > 2048) return Promise.reject(new PriceBuildError('PRICE_BUILD_UNAVAILABLE'));
    if (options.signal?.aborted) return Promise.reject(new PriceBuildError('PRICE_BUILD_ABORTED'));
    let work = pending.get(options.key) as Promise<T> | undefined;
    if (work) emit(options, 'shared');
    else {
      work = execute(options).catch(error => { throw errorOf(error); }).finally(() => { pending.delete(options.key); });
      pending.set(options.key, work);
    }
    const signal = options.signal;
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new PriceBuildError('PRICE_BUILD_ABORTED'));
      signal.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  };
}

export const runSharedPriceBuild = createSharedPriceBuildCoordinator();
