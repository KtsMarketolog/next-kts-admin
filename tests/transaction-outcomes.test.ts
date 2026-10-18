import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as outcome from '../src/shared/lib/db/transactionOutcome';
import { runPostCommitTasks } from '../src/shared/lib/postCommitTasks';

function database(options: { fail?: string; rollbackCommand?: boolean } = {}) {
  const commands: string[] = [];
  const releases: unknown[] = [];
  const client = { async query(sql: string) {
    commands.push(sql);
    if (sql === options.fail || (options.fail === 'unlock' && sql.includes('pg_advisory_unlock'))) throw new Error('Synthetic connection failure');
    return { command: sql === 'commit' && options.rollbackCommand ? 'ROLLBACK' : sql.toUpperCase(), rows: [{ acquired: true }] };
  }, release(discard: unknown) { releases.push(discard); } };
  const compiled = ts.transpileModule(readFileSync(new URL('../src/shared/lib/db/client.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} as typeof import('../src/shared/lib/db/client') };
  new Function('require', 'module', 'exports', 'globalThis', 'process', compiled)(
    (name: string) => name === 'pg' ? {} : outcome,
    testModule, testModule.exports, { __ktsPgPool: { connect: async () => client } }, { env: { DATABASE_URL: 'synthetic' } },
  );
  return { ...testModule.exports, commands, releases };
}

test('confirmed transaction returns callback result and releases normally', async () => {
  const db = database();
  assert.equal(await db.withTransaction(async () => 7, { trackCommitOutcome: true }), 7);
  assert.deepEqual(db.commands, ['begin', 'commit']);
  assert.deepEqual(db.releases, [false]);
});

test('business error rolls back and retains original error', async () => {
  const db = database();
  const failure = new Error('Synthetic business error');
  await assert.rejects(db.withTransaction(async () => { throw failure; }, { trackCommitOutcome: true }), (error) => error === failure);
  assert.deepEqual(db.commands, ['begin', 'rollback']);
});

test('lost COMMIT acknowledgement is unknown, not a claim of failed save', async () => {
  const db = database({ fail: 'commit' });
  let applications = 0;
  await assert.rejects(db.withTransaction(async () => ++applications, { trackCommitOutcome: true }), outcome.TransactionCommitUnknownError);
  assert.equal(applications, 1, 'Unknown commits must not automatically retry');
  assert.deepEqual(db.releases, [true]);
});

test('silently aborted transaction is never reported saved', async () => {
  const db = database({ rollbackCommand: true });
  await assert.rejects(db.withTransaction(async () => 7, { trackCommitOutcome: true }), /Изменения не сохранены/);
});

test('legacy transaction callers retain their original COMMIT error', async () => {
  const db = database({ fail: 'commit' });
  await assert.rejects(db.withTransaction(async () => 7), /Synthetic connection failure/);
});

test('rollback failure discards the pooled connection', async () => {
  const db = database({ fail: 'rollback' });
  await assert.rejects(db.withTransaction(async () => { throw new Error('business'); }), /business/);
  assert.deepEqual(db.releases, [true]);
});

test('uncertain advisory unlock discards its session and release remains idempotent', async () => {
  const db = database({ fail: 'unlock' });
  const release = await db.tryAcquireSessionAdvisoryLock('synthetic');
  assert.ok(release);
  await assert.rejects(release(), /Synthetic/);
  await release();
  assert.deepEqual(db.releases, [true]);
});

test('secondary failures are isolated and return only safe warnings', async () => {
  const visited: number[] = [];
  const warnings = await runPostCommitTasks([
    { code: 'first', message: 'Сохранено, журнал требует проверки.', run() { visited.push(1); throw new Error('secret'); } },
    { code: 'second', message: 'Сохранено, уведомление требует проверки.', async run() { visited.push(2); throw new Error('credential'); } },
    { code: 'third', message: 'unused', run() { visited.push(3); } },
  ]);
  assert.deepEqual(visited, [1, 2, 3]);
  assert.deepEqual(warnings.map((warning) => warning.code), ['first', 'second']);
  assert.doesNotMatch(JSON.stringify(warnings), /secret|credential/);
});
