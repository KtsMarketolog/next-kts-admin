/** Synthetic workload report, not a latency gate. No application DB or customer data. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { buildPublicWholesalePriceInWorker, freezePrice } from '../src/shared/lib/priceBuild/client';
import { loadLegacyPriceAssembly, priceBuildWorkload } from './helpers/priceBuildWorkload';

const round = (value: number) => Number(value.toFixed(2));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function main() {
  execFileSync(process.execPath, ['scripts/build-price-worker.mjs'], { stdio: 'pipe' });
  const legacy = loadLegacyPriceAssembly();
  for (const productCount of [7_562, 15_000]) {
    const source = priceBuildWorkload(productCount);
    // Baseline intentionally runs synchronously in this measurement-only process.
    const legacyStarted = performance.now();
    const expected = legacy(source);
    const legacyWallMs = performance.now() - legacyStarted;
    await tick();
    const lagSamples: number[] = [];
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      lagSamples.push(Math.max(0, now - lastTick - 5));
      lastTick = now;
    }, 5);
    let built: Awaited<ReturnType<typeof buildPublicWholesalePriceInWorker>>;
    const started = performance.now();
    let wallMs: number;
    try {
      built = await buildPublicWholesalePriceInWorker(source);
      wallMs = performance.now() - started;
      // Observe the timer delayed by the final deserialize callback before
      // removing it; a setImmediate alone can run before the next timer phase.
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    } finally { clearInterval(timer); }
    assert.deepEqual(built.price, expected, 'all resulting fields must match the pre-refactor implementation');
    assert.equal(built.price.categories.reduce((sum, category) => sum + category.products.length, 0), productCount);
    const freezeStarted = performance.now();
    await freezePrice(built.price);
    const freezeWallMs = performance.now() - freezeStarted;
    const sorted = [...lagSamples].sort((a, b) => a - b);
    console.log(JSON.stringify({
      event: 'synthetic_price_worker_scale', productCount, itemRows: source.rows.length,
      exactLegacyParity: true, legacyMainThreadAssemblyMs: round(legacyWallMs), workerRoundTripMs: round(wallMs!),
      workerTimings: Object.fromEntries(Object.entries(built.timings).map(([name, value]) => [name, round(value)])),
      mainThreadTimings: Object.fromEntries(Object.entries(built.mainThreadTimings!).map(([name, value]) => [name, round(value)])),
      cooperativeFreezeWallMs: round(freezeWallMs), serializedBytes: built.cacheBytes,
      timerSamples: lagSamples.length, maxEventLoopLagMs: round(sorted.at(-1) ?? 0),
      p95EventLoopLagMs: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      scope: 'local synthetic observation; CPU not attributed from process-wide concurrent counters',
    }));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
