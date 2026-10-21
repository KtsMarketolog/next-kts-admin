import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { deserialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { PriceBuildError } from './errors';
import type { PriceBuildInput, PriceBuildResult, PriceBuildWorkerMessage } from './types';

export type PriceBuildExecutionOptions = {
  signal?: AbortSignal;
  /** Absolute wall-clock deadline, including worker startup and transfer. */
  deadlineAt?: number;
  timeoutMs?: number;
};

export const PRICE_BUILD_DEFAULT_TIMEOUT_MS = 60_000;

function checkInterrupted(options: Pick<PriceBuildExecutionOptions, 'signal' | 'deadlineAt'>) {
  if (options.signal?.aborted) throw new PriceBuildError('PRICE_BUILD_ABORTED');
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw new PriceBuildError('PRICE_BUILD_TIMEOUT');
}

function decodeResult(message: PriceBuildWorkerMessage, input: PriceBuildInput): PriceBuildResult {
  if (!message || message.ok !== true) throw new PriceBuildError('PRICE_BUILD_FAILED');
  const { serialized, cacheBytes, timings } = message.result ?? {};
  if (!(serialized instanceof Uint8Array) || !serialized.byteLength || cacheBytes !== serialized.byteLength
    || !timings || !['assemblyMs', 'analogsMs', 'serializationMs', 'totalMs'].every((key) => {
      const value = timings[key as keyof typeof timings];
      return Number.isFinite(value) && value >= 0;
    })) throw new PriceBuildError('PRICE_BUILD_FAILED');
  const started = performance.now();
  const price = deserialize(Buffer.from(serialized.buffer, serialized.byteOffset, serialized.byteLength));
  const deserializationMs = performance.now() - started;
  if (!price || price.id !== input.metadata.id || price.token !== input.metadata.token || price.cacheRevision !== input.revision
    || !Array.isArray(price.categories)) throw new PriceBuildError('PRICE_BUILD_FAILED');
  return { price, serialized, cacheBytes, timings, mainThreadTimings: { inputTransferMs: 0, deserializationMs } };
}

/** Factory is a test seam; runtime uses the fixed bundled entry point below. */
export function createPriceBuildWorkerClient(options: {
  spawn?: (input: PriceBuildInput) => Worker;
  maxActiveWorkers?: number;
} = {}) {
  const maxActiveWorkers = options.maxActiveWorkers ?? 2;
  if (!Number.isSafeInteger(maxActiveWorkers) || maxActiveWorkers < 1 || maxActiveWorkers > 2) {
    throw new Error('Invalid price worker concurrency');
  }
  const spawn = options.spawn ?? ((input: PriceBuildInput) => new Worker(
    path.join(process.cwd(), '.runtime-build', 'price-build-worker.cjs'), {
      workerData: input,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 64 },
    },
  ));
  let active = 0;

  return async function build(input: PriceBuildInput, execution: PriceBuildExecutionOptions = {}): Promise<PriceBuildResult> {
    checkInterrupted(execution);
    if (active >= maxActiveWorkers) throw new PriceBuildError('PRICE_BUILD_BUSY');
    const timeoutMs = Number.isFinite(execution.timeoutMs) && Number(execution.timeoutMs) > 0
      ? Number(execution.timeoutMs) : PRICE_BUILD_DEFAULT_TIMEOUT_MS;
    const deadlineAt = Math.min(Date.now() + timeoutMs, execution.deadlineAt ?? Infinity);
    active += 1;
    return new Promise<PriceBuildResult>((resolve, reject) => {
      let worker: Worker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let inputTransferMs = 0;
      const settle = async (error?: PriceBuildError, result?: PriceBuildResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        execution.signal?.removeEventListener('abort', abort);
        // Do not return the admission slot until the native worker has stopped.
        // This also covers message success, crash, premature exit and cancellation.
        try { await worker?.terminate(); }
        catch { error = new PriceBuildError('PRICE_BUILD_FAILED'); }
        finally { active -= 1; }
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () => { void settle(new PriceBuildError('PRICE_BUILD_ABORTED')); };
      try {
        const started = performance.now();
        worker = spawn(input);
        inputTransferMs = performance.now() - started;
        worker.once('message', (message: PriceBuildWorkerMessage) => {
          if (settled) return;
          try {
            checkInterrupted({ signal: execution.signal, deadlineAt });
            const result = decodeResult(message, input);
            result.mainThreadTimings!.inputTransferMs = inputTransferMs;
            checkInterrupted({ signal: execution.signal, deadlineAt });
            void settle(undefined, result);
          } catch (error) {
            void settle(error instanceof PriceBuildError ? error : new PriceBuildError('PRICE_BUILD_FAILED'));
          }
        });
        worker.once('error', () => { void settle(new PriceBuildError('PRICE_BUILD_FAILED')); });
        worker.once('exit', () => { void settle(new PriceBuildError('PRICE_BUILD_FAILED')); });
        execution.signal?.addEventListener('abort', abort, { once: true });
        checkInterrupted({ signal: execution.signal, deadlineAt });
        timer = setTimeout(() => { void settle(new PriceBuildError('PRICE_BUILD_TIMEOUT')); }, Math.max(1, deadlineAt - Date.now()));
      } catch (error) {
        void settle(error instanceof PriceBuildError ? error : new PriceBuildError('PRICE_BUILD_FAILED'));
      }
    });
  };
}

export const buildPublicWholesalePriceInWorker = createPriceBuildWorkerClient();

/** Worker structured-cloning/deserialize does not preserve Object.freeze. */
export async function freezePrice<T extends object>(value: T, options: Pick<PriceBuildExecutionOptions, 'signal' | 'deadlineAt'> = {}): Promise<T> {
  const pending: object[] = [value];
  const seen = new WeakSet<object>();
  let work = 0;
  checkInterrupted(options);
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (child && typeof child === 'object') pending.push(child);
      if (++work >= 512) {
        work = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
        checkInterrupted(options);
      }
    }
    Object.freeze(current);
  }
  checkInterrupted(options);
  return value;
}
