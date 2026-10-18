import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as outcome from '../src/shared/lib/db/transactionOutcome';
import * as policy from '../src/shared/lib/db/transactionPolicy';

const clientSource = ts.transpileModule(readFileSync(new URL('../src/shared/lib/db/client.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function sqlError(code: string) { return Object.assign(new Error(`Synthetic ${code}`), { code }); }

function database(options: {
  fail?: (sql: string, attempt: number) => unknown;
  command?: (sql: string, attempt: number) => string | undefined;
} = {}) {
  const operations: string[] = [];
  const diagnostics: string[] = [];
  const clients: { attempt: number; query: (sql: string) => Promise<{ command: string; rows: object[] }>; release: (discard: unknown) => void }[] = [];
  let poolOptions: Record<string, unknown> = {};
  class FakePool {
    constructor(config: Record<string, unknown>) { poolOptions = config; }
    on() {}
    async query(sql: string) { operations.push(`pool:${sql}`); return { rows: [] }; }
    async connect() {
      const attempt = clients.length + 1;
      operations.push(`connect:${attempt}`);
      const client = {
        attempt,
        async query(sql: string) {
          operations.push(`${attempt}:${sql}`);
          const error = options.fail?.(sql, attempt);
          if (error) throw error;
          return { command: options.command?.(sql, attempt) ?? sql.toUpperCase(), rows: [] };
        },
        release(discard: unknown) { operations.push(`release:${attempt}:${discard}`); },
      };
      clients.push(client);
      return client;
    }
  }
  const testModule = { exports: {} as typeof import('../src/shared/lib/db/client') };
  new Function('require', 'module', 'exports', 'globalThis', 'process', 'console', clientSource)(
    (name: string) => name === 'pg' ? { Pool: FakePool }
      : name === './transactionPolicy' ? {
        ...policy,
        async waitBeforeTransactionRetry(attempt: number) { operations.push(`wait:${attempt}`); },
      } : outcome,
    testModule, testModule.exports, {}, { env: { DATABASE_URL: 'synthetic' } }, {
      warn(message: string) { diagnostics.push(message); },
      error(message: string) { diagnostics.push(message); },
    },
  );
  return { ...testModule.exports, operations, diagnostics, clients, get poolOptions() { return poolOptions; } };
}

test('pool config sends finite server deadlines even for standalone queries', async () => {
  const db = database();
  await db.query('select 1');
  assert.equal(db.poolOptions.statement_timeout, 60_000);
  assert.equal(db.poolOptions.lock_timeout, 10_000);
  assert.equal(db.poolOptions.idle_in_transaction_session_timeout, 60_000);
  assert.equal(db.poolOptions.query_timeout, undefined, 'A JS timer cannot cancel server work');
  assert.deepEqual(db.operations, ['pool:select 1']);
});

for (const profile of Object.keys(policy.DATABASE_OPERATION_PROFILES) as policy.DatabaseOperationProfile[]) {
  test(`${profile} profile applies local deadlines before callback SQL`, async () => {
    const db = database();
    await db.withTransaction(async (client) => { await client.query('select work'); }, { profile });
    const config = policy.DATABASE_OPERATION_PROFILES[profile];
    const deadlineSQL = db.operations[2];
    assert.match(deadlineSQL, new RegExp(`SET LOCAL statement_timeout = '${config.statementTimeoutMs}ms'`));
    assert.match(deadlineSQL, new RegExp(`SET LOCAL lock_timeout = '${config.lockTimeoutMs}ms'`));
    assert.match(deadlineSQL, new RegExp(`SET LOCAL idle_in_transaction_session_timeout = '${config.idleTransactionTimeoutMs}ms'`));
    assert.doesNotMatch(deadlineSQL, /select/i, 'Must allow callback SET TRANSACTION before its first data query');
    assert.equal(db.operations[3], '1:select work');
    assert.equal(db.operations.at(-1), 'release:1:false');
  });
}

test('invalid runtime profile fails without acquiring a database connection', async () => {
  const db = database();
  await assert.rejects(db.withTransaction(async () => 1, { profile: 'unlimited' as policy.DatabaseOperationProfile }), /Unknown database operation/);
  assert.deepEqual(db.operations, []);
});

for (const code of ['40P01', '40001']) {
  test(`${code} does not replay legacy callbacks unless explicitly opted in`, async () => {
    const db = database();
    let calls = 0;
    const failure = sqlError(code);
    await assert.rejects(db.withTransaction(async () => { calls += 1; throw failure; }), (error) => error === failure);
    assert.equal(calls, 1);
    assert.equal(db.clients.length, 1);
    assert.equal(db.operations.at(-1), 'release:1:false');
    assert.ok(!db.operations.some((value) => value.startsWith('wait:')));
  });

  test(`${code} retry rolls back, releases, waits, then reacquires before callback replay`, async () => {
    const db = database();
    let calls = 0;
    const value = await db.withTransaction(async (client) => {
      calls += 1;
      await client.query('select work');
      if (calls === 1) throw sqlError(code);
      return 17;
    }, { retryOnConflict: true, profile: 'import', trackCommitOutcome: true });
    assert.equal(value, 17);
    assert.equal(calls, 2);
    assert.notEqual(db.clients[0], db.clients[1]);
    const rollback = db.operations.indexOf('1:rollback');
    assert.deepEqual(db.operations.slice(rollback, rollback + 4), ['1:rollback', 'release:1:false', 'wait:1', 'connect:2']);
    assert.equal(db.operations.filter((value) => value.endsWith(':commit')).length, 1);
    assert.deepEqual(db.diagnostics.map((entry) => JSON.parse(entry)), [{
      event: 'postgres_transaction_retry', profile: 'import', attempt: 1, sqlstate: code,
    }]);
    assert.doesNotMatch(db.diagnostics.join(''), /Synthetic|select work|synthetic/i);
  });

  test(`${code} is bounded to three complete attempts`, async () => {
    const db = database();
    const failure = sqlError(code);
    let calls = 0;
    await assert.rejects(db.withTransaction(async () => { calls += 1; throw failure; }, { retryOnConflict: true }), (error) => error === failure);
    assert.equal(calls, 3);
    assert.equal(db.clients.length, 3);
    assert.equal(db.operations.filter((value) => value.endsWith(':rollback')).length, 3);
    assert.deepEqual(db.operations.filter((value) => value.startsWith('wait:')), ['wait:1', 'wait:2']);
  });

  test(`COMMIT ${code} is a known abort and can retry after rollback confirmation`, async () => {
    const db = database({ fail: (sql, attempt) => sql === 'commit' && attempt === 1 ? sqlError(code) : undefined });
    let calls = 0;
    assert.equal(await db.withTransaction(async () => ++calls, { retryOnConflict: true, trackCommitOutcome: true }), 2);
    assert.equal(calls, 2);
    assert.equal(db.operations.filter((value) => value.endsWith(':rollback')).length, 1);
    assert.ok(db.operations.includes('release:1:false'));
  });

  test(`COMMIT ${code} without retries is not mislabeled an unknown save`, async () => {
    const failure = sqlError(code);
    const db = database({ fail: (sql) => sql === 'commit' ? failure : undefined });
    await assert.rejects(db.withTransaction(async () => 1, { trackCommitOutcome: true }), (error) => error === failure);
    assert.equal(db.clients.length, 1);
  });
}

for (const code of ['55P03', '57014', '23505', 'ECONNRESET', 'EPIPE', '08006']) {
  test(`${code} callback failure never retries even when opted in`, async () => {
    const db = database();
    const failure = sqlError(code);
    let calls = 0;
    await assert.rejects(db.withTransaction(async () => { calls += 1; throw failure; }, { retryOnConflict: true, trackCommitOutcome: true }), (error) => error === failure);
    assert.equal(calls, 1);
    assert.equal(db.clients.length, 1);
  });
}

test('connection loss during COMMIT never replays even after ROLLBACK succeeds', async () => {
  const db = database({ fail: (sql) => sql === 'commit' ? sqlError('ECONNRESET') : undefined });
  let calls = 0;
  await assert.rejects(db.withTransaction(async () => ++calls, { retryOnConflict: true, trackCommitOutcome: true }), outcome.TransactionCommitUnknownError);
  assert.equal(calls, 1);
  assert.equal(db.clients.length, 1);
  assert.equal(db.operations.at(-1), 'release:1:true');
});

test('unknown COMMIT retains legacy error shape without enabling replay', async () => {
  const failure = sqlError('ECONNRESET');
  const db = database({ fail: (sql) => sql === 'commit' ? failure : undefined });
  let calls = 0;
  await assert.rejects(db.withTransaction(async () => ++calls, { retryOnConflict: true }), (error) => error === failure);
  assert.equal(calls, 1);
  assert.equal(db.operations.at(-1), 'release:1:true');
});

for (const commitFailure of [false, true]) {
  test(`rollback connection failure prevents retry after ${commitFailure ? 'COMMIT' : 'callback'} conflict`, async () => {
    const conflict = sqlError('40P01');
    const db = database({ fail: (sql) => sql === 'rollback' ? sqlError('ECONNRESET') : commitFailure && sql === 'commit' ? conflict : undefined });
    let calls = 0;
    await assert.rejects(db.withTransaction(async () => {
      calls += 1;
      if (!commitFailure) throw conflict;
      return 1;
    }, { retryOnConflict: true, trackCommitOutcome: true }), (error) => error === conflict);
    assert.equal(calls, 1);
    assert.equal(db.operations.at(-1), 'release:1:true');
  });
}

test('unconfirmed rollback command discards connection and does not retry', async () => {
  const db = database({ command: (sql) => sql === 'rollback' ? 'UNKNOWN' : undefined });
  const conflict = sqlError('40001');
  await assert.rejects(db.withTransaction(async () => { throw conflict; }, { retryOnConflict: true }), (error) => error === conflict);
  assert.equal(db.clients.length, 1);
  assert.equal(db.operations.at(-1), 'release:1:true');
});

test('silently rolled-back COMMIT is not reported saved or retried', async () => {
  const db = database({ command: (sql) => sql === 'commit' ? 'ROLLBACK' : undefined });
  await assert.rejects(db.withTransaction(async () => 1, { retryOnConflict: true, trackCommitOutcome: true }), /Изменения не сохранены/);
  assert.equal(db.clients.length, 1);
});

test('deadline setup failure rolls back before callback and does not retry timeout', async () => {
  const failure = sqlError('57014');
  const db = database({ fail: (sql) => sql.startsWith('SET LOCAL') ? failure : undefined });
  let calls = 0;
  await assert.rejects(db.withTransaction(async () => ++calls, { retryOnConflict: true }), (error) => error === failure);
  assert.equal(calls, 0);
  assert.equal(db.operations.at(-2), '1:rollback');
});

test('retry jitter stays bounded on every attempt without real blocking waits', async () => {
  const compiled = ts.transpileModule(readFileSync(new URL('../src/shared/lib/db/transactionPolicy.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const delays: number[] = [];
  let random = 0;
  const testModule = { exports: {} as typeof policy };
  new Function('module', 'exports', 'Math', 'setTimeout', compiled)(testModule, testModule.exports,
    { min: Math.min, max: Math.max, floor: Math.floor, random: () => random },
    (callback: () => void, delay: number) => { delays.push(delay); callback(); },
  );
  for (const attempt of [1, 2, 100]) {
    random = 0;
    await testModule.exports.waitBeforeTransactionRetry(attempt);
    random = 0.999999;
    await testModule.exports.waitBeforeTransactionRetry(attempt);
  }
  assert.deepEqual(delays, [25, 74, 50, 149, 50, 149]);
});
