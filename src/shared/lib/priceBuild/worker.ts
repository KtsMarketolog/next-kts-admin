import { parentPort, workerData } from 'node:worker_threads';
import { assemblePriceBuild } from './assemble';
import type { PriceBuildInput, PriceBuildWorkerMessage } from './types';

if (!parentPort) throw new Error('Price assembly requires a worker thread');
try {
  const result = assemblePriceBuild(workerData as PriceBuildInput);
  const { serialized, cacheBytes, timings } = result;
  parentPort.postMessage({ ok: true, result: { serialized, cacheBytes, timings } } satisfies PriceBuildWorkerMessage,
    [serialized.buffer as ArrayBuffer]);
} catch {
  // Never serialize raw input, tokens, prices, customer details or stack traces.
  parentPort.postMessage({ ok: false } satisfies PriceBuildWorkerMessage);
} finally {
  parentPort.close();
}
