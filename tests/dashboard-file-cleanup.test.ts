import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { constants, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import { drainDashboardFileCleanup, enqueueDashboardFileCleanup } from '../src/shared/lib/dashboardFileCleanup';

const first = `aa/${'a'.repeat(64)}-11111111-1111-1111-1111-111111111111.bin`;
const second = `bb/${'b'.repeat(64)}-22222222-2222-2222-2222-222222222222.bin`;
const unlocked = async (action: () => Promise<number>) => action();
const pendingDirectory = (directory: string) => path.join(directory, '.incoming', '.pending-deletions');

async function fixture(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kts-dashboard-cleanup-'));
  try {
    for (const file of [first, second]) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), 'synthetic');
    }
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('busy backup defers file deletion and the next drain completes it', async () => fixture(async (directory) => {
  await enqueueDashboardFileCleanup(directory, [first, first, '../outside', `bb/${path.basename(first)}`]);
  const dependencies = { withLock: async () => null, referencedPaths: async () => new Set<string>() };
  assert.equal(await drainDashboardFileCleanup(directory, dependencies), true);
  assert.equal((await stat(path.join(directory, first))).isFile(), true);
  assert.deepEqual(await readdir(pendingDirectory(directory)), [path.basename(first)]);
  assert.equal(await drainDashboardFileCleanup(directory, { ...dependencies, withLock: unlocked }), false);
  await assert.rejects(stat(path.join(directory, first)), { code: 'ENOENT' });
  assert.equal((await stat(path.join(directory, second))).isFile(), true);
  assert.deepEqual(await readdir(pendingDirectory(directory)), []);
}));

test('restored/live database references cancel pending deletion instead of deleting a live file', async () => fixture(async (directory) => {
  await enqueueDashboardFileCleanup(directory, [first, second]);
  assert.equal(await drainDashboardFileCleanup(directory, {
    withLock: unlocked, referencedPaths: async (paths) => {
      assert.deepEqual(paths.sort(), [first, second]);
      return new Set([first]);
    },
  }), false);
  assert.equal((await stat(path.join(directory, first))).isFile(), true);
  await assert.rejects(stat(path.join(directory, second)), { code: 'ENOENT' });
  assert.deepEqual(await readdir(pendingDirectory(directory)), []);
}));

test('failed reference verification preserves both file and retry marker', async () => fixture(async (directory) => {
  await enqueueDashboardFileCleanup(directory, [first]);
  await assert.rejects(drainDashboardFileCleanup(directory, {
    withLock: unlocked, referencedPaths: async () => { throw new Error('database unavailable'); },
  }), /database unavailable/);
  assert.equal((await stat(path.join(directory, first))).isFile(), true);
  assert.deepEqual(await readdir(pendingDirectory(directory)), [path.basename(first)]);
}));

test('failed unlink preserves retry marker; concurrent or already completed deletion is idempotent', async () => fixture(async (directory) => {
  await enqueueDashboardFileCleanup(directory, [first]);
  await rm(path.join(directory, first));
  await mkdir(path.join(directory, first));
  const dependencies = { withLock: unlocked, referencedPaths: async () => new Set<string>() };
  await assert.rejects(drainDashboardFileCleanup(directory, dependencies));
  assert.deepEqual(await readdir(pendingDirectory(directory)), [path.basename(first)]);
  await rm(path.join(directory, first), { recursive: true });
  await Promise.all([drainDashboardFileCleanup(directory, dependencies), drainDashboardFileCleanup(directory, dependencies)]);
  assert.deepEqual(await readdir(pendingDirectory(directory)), []);
}));

test('durable database outbox recovers a crash before the post-commit filesystem marker was created', async () => fixture(async (directory) => {
  let queue = [first];
  assert.equal(await drainDashboardFileCleanup(directory, {
    withLock: unlocked, referencedPaths: async () => new Set(),
    pendingPaths: async () => queue,
    acknowledge: async (paths) => {
      assert.deepEqual(paths, [first]);
      await assert.rejects(stat(path.join(directory, first)), { code: 'ENOENT' });
      queue = [];
    },
  }), false);
  assert.deepEqual(queue, []);
  assert.deepEqual(await readdir(pendingDirectory(directory)), []);
  assert.equal((await stat(path.join(directory, second))).isFile(), true);
}));

test('failed outbox acknowledgement keeps the marker and safely retries an already removed file', async () => fixture(async (directory) => {
  let failAcknowledgement = true;
  const dependencies = {
    withLock: unlocked, referencedPaths: async () => new Set<string>(), pendingPaths: async () => [first],
    acknowledge: async () => { if (failAcknowledgement) throw new Error('acknowledgement unavailable'); },
  };
  await assert.rejects(drainDashboardFileCleanup(directory, dependencies), /acknowledgement unavailable/);
  assert.deepEqual(await readdir(pendingDirectory(directory)), [path.basename(first)]);
  failAcknowledgement = false;
  assert.equal(await drainDashboardFileCleanup(directory, dependencies), false);
  assert.deepEqual(await readdir(pendingDirectory(directory)), []);
}));

function lockFixture(exitCode: number) {
  const source = readFileSync(new URL('../src/shared/lib/dashboardFileCleanup.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  let closed = false;
  let helperExited = false;
  const modules: Record<string, unknown> = {
    'node:fs': { constants }, 'node:path': path, './db/client': {},
    'node:fs/promises': {
      lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      readFile: async () => 'kts-next-admin\n',
      open: async () => ({ fd: 21, close: async () => { closed = true; } }),
    },
    'node:child_process': { spawn: (command: string, args: string[], options: { stdio: unknown[] }) => {
      assert.equal(command, '/usr/bin/flock');
      assert.deepEqual(args, ['--shared', '--nonblock', '3']);
      assert.equal(options.stdio[3], 21, 'helper duplicates the parent-owned open descriptor');
      const child = new EventEmitter();
      queueMicrotask(() => { helperExited = true; child.emit('exit', exitCode); });
      return child;
    } },
  };
  const loaded = { exports: {} as typeof import('../src/shared/lib/dashboardFileCleanup') };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in modules, `Unexpected module ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  return { cleanup: loaded.exports, isClosed: () => closed, helperExited: () => helperExited };
}

test('backup flock remains on the parent descriptor after helper exits and through asynchronous cleanup', async () => {
  const fixture = lockFixture(0);
  assert.equal(await fixture.cleanup.withDashboardBackupLock(async () => {
    assert.equal(fixture.helperExited(), true);
    await Promise.resolve();
    assert.equal(fixture.isClosed(), false, 'parent keeps shared lock while waiting on database/files');
    return 123;
  }), 123);
  assert.equal(fixture.isClosed(), true);
});

test('busy backup prevents action; cleanup failure still releases the parent lock', async () => {
  const busy = lockFixture(1);
  assert.equal(await busy.cleanup.withDashboardBackupLock(async () => assert.fail('must not delete')), null);
  assert.equal(busy.isClosed(), true);
  const failing = lockFixture(0);
  await assert.rejects(failing.cleanup.withDashboardBackupLock(async () => { throw new Error('unlink failed'); }), /unlink failed/);
  assert.equal(failing.isClosed(), true);
});
