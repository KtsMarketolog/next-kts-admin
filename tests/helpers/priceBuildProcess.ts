/** Used only by the guarded disposable PostgreSQL integration suite. */
import assert from 'node:assert/strict';
import { query } from '../../src/shared/lib/db/client';
import { markSiteSchemaReady } from '../../src/shared/lib/db/schema';
import { createSharedPriceBuildCoordinator } from '../../src/shared/lib/priceBuild/coordinator';
import { PriceBuildError } from '../../src/shared/lib/priceBuild/errors';

assert.equal(process.env.KTS_PRICE_BUILD_TEST, '1');
assert.equal(process.env.NODE_ENV, 'test');
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.pathname, '/kts_price_build_integration');
assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-price-build-postgres\.[A-Za-z0-9]+\/socket$/);
assert.equal(url.username, 'price_build_app');
markSiteSchemaReady();
const run = createSharedPriceBuildCoordinator({ queueWaitMs: 2_000, buildTimeoutMs: 3_000, leaseMs: 500, heartbeatMs: 100, pollMs: 25 });
const observers = new Map<string, AbortController>();
type Command = { id: string; key: string; delayMs?: number; fail?: boolean; cacheable?: boolean; abortId?: string; nullValue?: boolean };
async function command(message: Command) {
  if (message.abortId) { observers.get(message.abortId)?.abort(); return; }
  const observer = new AbortController(); observers.set(message.id, observer);
  try {
    const value = await run({ key: message.key, signal: observer.signal,
      decode: async encoded => JSON.parse(Buffer.from(encoded).toString('utf8')),
      build: async ({ signal }) => {
        await query(`insert into price_build_test_events(key,pid,kind) values($1,$2,'start')`, [message.key, process.pid]);
        process.send?.({ event: 'started', id: message.id, key: message.key, pid: process.pid });
        let interrupted = false;
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { interrupted = true; clearTimeout(timer); reject(new PriceBuildError('PRICE_BUILD_ABORTED')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, message.delayMs ?? 20);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
          if (message.fail) throw new PriceBuildError('PRICE_BUILD_FAILED');
          const result = message.nullValue ? null : { key: message.key, builtBy: process.pid };
          return { value: result, encoded: result ? Buffer.from(JSON.stringify(result)) : new Uint8Array(), cacheable: message.cacheable };
        } finally {
          await query(`insert into price_build_test_events(key,pid,kind) values($1,$2,$3)`,
            [message.key, process.pid, interrupted ? 'aborted' : 'end']);
        }
      },
    });
    process.send?.({ id: message.id, ok: true, value });
  } catch (error) {
    process.send?.({ id: message.id, ok: false, code: (error as { code?: string }).code, error: String(error) });
  } finally { observers.delete(message.id); }
}
process.on('message', (message: Command) => { void command(message); });
process.send?.({ event: 'ready', pid: process.pid });
