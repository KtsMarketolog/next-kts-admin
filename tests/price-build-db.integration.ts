/** Run only through scripts/test-price-build-postgres.sh (synthetic local data). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { markSiteSchemaReady } from '../src/shared/lib/db/schema';
import { applyPriceBuildMigration } from '../src/shared/lib/db/priceBuildMigration';
import { heartbeatPriceBuild, publishPriceBuild, readOrEnqueuePriceBuild, tryClaimPriceBuild } from '../src/shared/lib/db/priceBuildRepo';
import { priceBuildCacheDirectory } from '../src/shared/lib/priceBuild/sharedCache';

function guard() {
  assert.equal(process.env.KTS_PRICE_BUILD_TEST, '1'); assert.equal(process.env.NODE_ENV, 'test');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, 'localhost'); assert.equal(url.pathname, '/kts_price_build_integration');
  assert.equal(url.username, 'price_build_app'); assert.equal(url.password, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['host','port']);
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-price-build-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55487');
  assert.equal(priceBuildCacheDirectory(), path.join(path.dirname(url.searchParams.get('host')!), 'cache'));
}
type Result = { ok: boolean; value?: { key: string; builtBy: number } | null; code?: string };
type Options = { delayMs?: number; fail?: boolean; cacheable?: boolean; nullValue?: boolean };
type WorkerProcess = { child: ChildProcess; run: (key: string, options?: Options) => { id: string; result: Promise<Result> }; abort: (id: string) => void; close: () => Promise<void> };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const expires = Date.now() + timeoutMs;
  while (!(await check())) { assert.ok(Date.now() < expires, 'condition timed out'); await pause(20); }
}
async function startProcess(): Promise<WorkerProcess> {
  const child = fork(path.resolve('tests/helpers/priceBuildProcess.ts'), [], { execArgv: ['--import','tsx'], silent: true, env: process.env });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk; });
  const pending = new Map<string, (value: Result) => void>();
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message: { event?: string; id?: string } & Result) => {
      if (message.event === 'ready') resolve();
      else if (message.id && !message.event) { pending.get(message.id)?.(message); pending.delete(message.id); }
    });
    child.once('exit', (code, signal) => {
      for (const done of pending.values()) done({ ok: false, code: 'PROCESS_EXIT' });
      pending.clear(); reject(new Error(`child exited ${code}/${signal}: ${stderr}`));
    });
  });
  await ready;
  return { child, run(key, options = {}) {
    const id = randomUUID();
    const result = new Promise<Result>(resolve => { pending.set(id, resolve); });
    child.send({ id, key, ...options }); return { id, result };
  }, abort(id) { child.send({ abortId: id }); }, close: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL'); });
  } };
}
const key = (label: string) => `integration:${label}:${randomUUID()}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function started(value: string) {
  await until(async () => Number((await query(`select count(*) from price_build_test_events where key=$1 and kind='start'`, [value])).rows[0].count) > 0);
}
async function reset() { await query('delete from price_build_jobs'); await query('delete from price_build_test_events'); }
async function maxActive() {
  return Number((await query(`select coalesce(max(running),0) as peak from (select sum(case when kind='start' then 1 else -1 end)
    over(order by id) as running from price_build_test_events) q`)).rows[0].peak);
}

test('shared price builds: bounded real PostgreSQL admission across two Node processes', { timeout: 90_000 }, async t => {
  guard();
  const processes: WorkerProcess[] = [];
  try {
    await withTransaction(applyPriceBuildMigration);
    markSiteSchemaReady();
    await query(`create table price_build_test_events(id bigserial primary key,key text not null,pid integer not null,kind text not null,at timestamptz default clock_timestamp());
      create table wholesale_price_lists(id integer primary key,title text,comment text);
      create table wholesale_price_list_items(id integer primary key,price_list_id integer,custom_price numeric,visible boolean);
      insert into wholesale_price_lists values(1,'Saved manager price','Must remain');
      insert into wholesale_price_list_items values(1,1,123.45,true),(2,1,99.50,false);`);
    const savedPrices = (await query('select row_to_json(p) as value from wholesale_price_lists p order by id')).rows;
    const savedItems = (await query('select row_to_json(p) as value from wholesale_price_list_items p order by id')).rows;
    let a = await startProcess(); const b = await startProcess(); processes.push(a,b);

    await t.test('one global active build, FIFO for distinct keys, shared same-key result and disk cache across processes', async () => {
      await reset();
      const first = key('first'); const second = key('second'); const third = key('third');
      const one = a.run(first, { delayMs: 350 }); await started(first);
      const shared = b.run(first, { delayMs: 10 });
      const two = b.run(second, { delayMs: 70 });
      await until(async () => (await query(`select count(*) from price_build_jobs where state='queued'`)).rows[0].count === '1');
      const three = a.run(third, { delayMs: 40 });
      const results = await Promise.all([one.result, shared.result, two.result, three.result]);
      assert.ok(results.every(value => value.ok), JSON.stringify(results));
      assert.deepEqual(results[0].value, results[1].value);
      assert.equal(await maxActive(), 1);
      assert.deepEqual((await query(`select key from price_build_test_events where kind='start' order by id`)).rows.map(row => row.key), [first,second,third]);
      const hit = await b.run(first).result; assert.deepEqual(hit.value, results[0].value);
      assert.equal((await query(`select count(*) from price_build_test_events where key=$1 and kind='start'`, [first])).rows[0].count, '1');
      const receipt = (await query('select * from price_build_jobs where key_hash=$1', [hash(first)])).rows[0];
      assert.equal((await lstat(priceBuildCacheDirectory())).mode & 0o777, 0o700);
      assert.equal((await lstat(path.join(priceBuildCacheDirectory(), receipt.result_file))).mode & 0o777, 0o600);
    });

    await t.test('eight waiting unique jobs plus one active; ninth waiter is busy while same-key followers do not consume capacity', async () => {
      await reset();
      const hot = key('capacity-ready'); const primed = await a.run(hot).result; assert.equal(primed.ok, true);
      const active = key('capacity-active'); const one = a.run(active, { delayMs: 1_100 }); await started(active);
      const waiting = Array.from({ length: 8 }, (_, index) => (index % 2 ? a : b).run(key(`queue-${index}`), { delayMs: 10 }));
      await until(async () => (await query(`select count(*) from price_build_jobs where state='queued'`)).rows[0].count === '8');
      const busy = await b.run(key('too-many')).result; assert.equal(busy.code, 'PRICE_BUILD_BUSY');
      // Process B has no local result: even a shared-disk hit bypasses a full queue.
      const diskHit = await b.run(hot).result; assert.deepEqual(diskHit.value, primed.value);
      assert.equal((await query('select state from price_build_jobs where key_hash=$1', [hash(active)])).rows[0].state, 'active');
      assert.equal((await query(`select count(*) from price_build_jobs where state='queued'`)).rows[0].count, '8');
      const follower = b.run(active);
      const all = await Promise.all([one.result, follower.result, ...waiting.map(item => item.result)]);
      assert.ok(all.every(value => value.ok), JSON.stringify(all)); assert.equal(await maxActive(), 1);
    });

    await t.test('expired lease does not admit a second worker while a SIGSTOP owner still holds its session lock', async () => {
      await reset(); const first = key('paused-owner'); const second = key('pause-follower');
      const one = a.run(first, { delayMs: 1_100 }); await started(first);
      a.child.kill('SIGSTOP');
      try {
        await pause(650);
        assert.equal((await query(`select lease_until<clock_timestamp() as expired from price_build_jobs where key_hash=$1`, [hash(first)])).rows[0].expired, true);
        const two = b.run(second);
        await pause(350);
        assert.equal((await query(`select count(*) from price_build_test_events where key=$1 and kind='start'`, [second])).rows[0].count, '0');
        a.child.kill('SIGCONT');
        assert.equal((await one.result).ok, true); assert.equal((await two.result).ok, true);
        assert.equal(await maxActive(), 1);
      } finally { a.child.kill('SIGCONT'); }
    });

    await t.test('dedicated connection termination aborts its worker; a later job can acquire the common slot', async () => {
      await reset(); const first = key('disconnect'); const one = a.run(first, { delayMs: 2_000 }); await started(first);
      await query(`select pg_terminate_backend(pid) from pg_stat_activity where application_name='kts-price-build-active' and datname=current_database()`);
      const failure = await one.result; assert.equal(failure.code, 'PRICE_BUILD_UNAVAILABLE');
      assert.equal((await query(`select count(*) from price_build_test_events where key=$1 and kind='aborted'`, [first])).rows[0].count, '1');
      assert.equal((await b.run(key('after-disconnect')).result).ok, true);
      assert.equal((await query(`select state from price_build_jobs where key_hash=$1`, [hash(first)])).rows[0].state, 'failed');
    });

    await t.test('crashed process releases session lock and stale same-key job can be reclaimed without a false cached result', async () => {
      await reset(); const first = key('killed-owner'); const one = a.run(first, { delayMs: 2_000 }); await started(first);
      await a.close(); assert.equal((await one.result).code, 'PROCESS_EXIT');
      const recovered = await b.run(first).result; assert.equal(recovered.ok, true);
      assert.equal(recovered.value?.builtBy, b.child.pid);
      a = await startProcess(); processes.push(a);
    });

    await t.test('queue wait and build timeouts release admission and do not publish a failed result', async () => {
      await reset(); const first = key('timeout-owner'); const second = key('timeout-queued');
      const one = a.run(first, { delayMs: 5_000 }); await started(first);
      const two = b.run(second);
      assert.equal((await two.result).code, 'PRICE_BUILD_TIMEOUT');
      assert.equal((await one.result).code, 'PRICE_BUILD_TIMEOUT');
      assert.equal((await b.run(key('after-timeout')).result).ok, true);
      assert.equal((await query(`select state,result_file from price_build_jobs where key_hash=$1`, [hash(first)])).rows[0].result_file, null);
      assert.equal((await query(`select count(*) from pg_stat_activity where application_name='kts-price-build-active' and datname=current_database()`)).rows[0].count, '0');
    });

    await t.test('observer cancellation does not delete or interrupt work shared by another process', async () => {
      await reset(); const first = key('abort-observer'); const one = a.run(first, { delayMs: 400 }); await started(first);
      const follower = b.run(first); a.abort(one.id);
      assert.equal((await one.result).code, 'PRICE_BUILD_ABORTED');
      assert.equal((await follower.result).ok, true);
      assert.equal((await query(`select count(*) from price_build_test_events where key=$1 and kind='start'`, [first])).rows[0].count, '1');
    });

    await t.test('missing, corrupt and undecodable cache artifacts rebuild under admission rather than causing permanent failures', async () => {
      for (const kind of ['missing','corrupt','decode']) {
        await reset(); const first = key(kind); assert.equal((await a.run(first).result).ok, true);
        const row = (await query(`select * from price_build_jobs where key_hash=$1`, [hash(first)])).rows[0];
        const location = path.join(priceBuildCacheDirectory(), row.result_file);
        if (kind === 'missing') await unlink(location);
        else {
          const invalid = Buffer.from('not valid JSON'); await writeFile(location, invalid, { mode: 0o600 });
          if (kind === 'decode') await query(`update price_build_jobs set result_bytes=$2,result_sha256=$3 where key_hash=$1`,
            [hash(first), invalid.byteLength, createHash('sha256').update(invalid).digest('hex')]);
        }
        assert.equal((await b.run(first).result).ok, true);
        assert.equal((await query(`select count(*) from price_build_test_events where key=$1 and kind='start'`, [first])).rows[0].count, '2');
        assert.equal(await maxActive(), 1);
      }
    });

    await t.test('failed and changed-revision builds are not shared as valid old-key results; null remains uncached', async () => {
      await reset(); const failed = key('failed'); const one = a.run(failed, { fail: true, delayMs: 200 }); await started(failed);
      const follower = b.run(failed);
      assert.equal((await one.result).code, 'PRICE_BUILD_FAILED'); assert.equal((await follower.result).code, 'PRICE_BUILD_FAILED');
      const changed = key('uncacheable'); const changedOwner = a.run(changed, { cacheable: false, delayMs: 200 }); await started(changed);
      const changedFollower = b.run(changed);
      assert.equal((await changedOwner.result).ok, true); assert.equal((await changedFollower.result).code, 'PRICE_BUILD_UNAVAILABLE');
      const nothing = key('null'); assert.deepEqual((await a.run(nothing, { nullValue: true }).result).value, null);
      assert.equal((await query(`select count(*) from price_build_jobs where state='ready'`)).rows[0].count, '0');
    });

    await t.test('fencing rejects heartbeat and publication by an obsolete owner without altering source price data', async () => {
      await reset(); const first = key('fenced'); const row = await readOrEnqueuePriceBuild(hash(first), 2_000);
      const lease = await tryClaimPriceBuild(row, { buildTimeoutMs: 3_000, leaseMs: 1_000, onDisconnect: () => {} }); assert.ok(lease);
      try {
        await query('update price_build_jobs set owner_id=$2 where key_hash=$1', [hash(first),randomUUID()]);
        await assert.rejects(heartbeatPriceBuild(lease, 1_000), { code: 'PRICE_BUILD_UNAVAILABLE' });
        await assert.rejects(publishPriceBuild(lease, { file: `${hash(first)}-${lease.ownerId}.bin`, bytes: 2, sha256: hash('[]') }, 300_000), { code: 'PRICE_BUILD_UNAVAILABLE' });
      } finally { await lease.close(); }
      assert.deepEqual((await query('select row_to_json(p) as value from wholesale_price_lists p order by id')).rows, savedPrices);
      assert.deepEqual((await query('select row_to_json(p) as value from wholesale_price_list_items p order by id')).rows, savedItems);
    });

    await t.test('cache cleanup only removes owned derived artifact names; unrelated private files survive', async () => {
      await reset(); const directory = priceBuildCacheDirectory();
      const unrelated = path.join(directory, 'keep-private-document.txt'); await writeFile(unrelated, 'preserved'); await chmod(unrelated, 0o600);
      assert.equal((await b.run(key('cleanup')).result).ok, true);
      assert.equal(await readFile(unrelated, 'utf8'), 'preserved');
      assert.ok((await readdir(directory)).every(name => !name.endsWith('.tmp')));
    });

    await t.test('a refused dedicated connection fails its queued generation immediately instead of stranding the FIFO head', async () => {
      await reset();
      const extra: Client[] = [];
      try {
        // Fill only this test cluster. Existing ordinary pool connections remain
        // available for short queue SQL, just as with a concurrent manager writer.
        let exhausted = false;
        for (let index = 0; index < 40; index += 1) {
          const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 500 });
          try { await client.connect(); extra.push(client); }
          catch (error) {
            await client.end().catch(() => {});
            assert.equal((error as { code?: string }).code, '53300'); exhausted = true; break;
          }
        }
        assert.ok(exhausted, 'synthetic connection cap reached');
        const refused = key('connection-refused');
        assert.equal((await a.run(refused).result).code, 'PRICE_BUILD_UNAVAILABLE');
        assert.equal((await query('select state from price_build_jobs where key_hash=$1', [hash(refused)])).rows[0].state, 'failed');
        assert.equal((await query(`select count(*) from price_build_jobs where state='queued'`)).rows[0].count, '0');
        await extra.pop()!.end();
        assert.equal((await b.run(key('after-connection-cap')).result).ok, true);
      } finally { await Promise.all(extra.map(client => client.end())); }
    });

    await t.test('blocked control SQL has a short server deadline and starts no worker', async () => {
      await reset(); const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      try {
        await blocker.query('begin'); await blocker.query('lock table price_build_jobs in access exclusive mode');
        const first = key('blocked-control'); const before = Date.now();
        assert.equal((await a.run(first).result).code, 'PRICE_BUILD_UNAVAILABLE');
        assert.ok(Date.now() - before < 4_000);
        assert.equal((await query(`select count(*) from price_build_test_events where key=$1`, [first])).rows[0].count, '0');
      } finally { await blocker.query('rollback'); await blocker.end(); }
      assert.equal((await b.run(key('after-control-lock')).result).ok, true);
    });
  } finally {
    await Promise.all(processes.map(process => process.close()));
    await globalThis.__ktsPgPool?.end(); globalThis.__ktsPgPool = undefined;
  }
});
