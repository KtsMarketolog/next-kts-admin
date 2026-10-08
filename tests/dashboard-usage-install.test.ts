import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const installer = path.resolve('ops/dashboard-usage/install.mjs');
const secret = 'unit_test_existing_secret_0000000000000000000000000000000000000000';

async function fixture(fn: (directory: string, appEnv: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kts-usage-install-test-'));
  const appEnv = path.join(directory, 'app/.env.local');
  await mkdir(path.dirname(appEnv), { mode: 0o700 });
  await writeFile(appEnv, '# Existing app configuration\r\nDATABASE_URL=postgres://local-test\r\nKEEP=value with spaces\r\n', { mode: 0o600 });
  try { await fn(directory, appEnv); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function run(directory: string, appEnv: string, apply = false) {
  return spawnSync(process.execPath, [installer, '--home', directory, '--app-env', appEnv, ...(apply ? ['--apply'] : [])], {
    encoding: 'utf8', timeout: 10_000,
  });
}

test('usage installer dry-run is default and makes no files or usable secret', async () => fixture(async (directory, appEnv) => {
  const original = await readFile(appEnv);
  const result = run(directory, appEnv);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'dry-run');
  assert.equal(output.applicationReloaded, false);
  assert.equal(output.timerEnabled, false);
  assert.equal(output.changedFiles.length, 5);
  assert.deepEqual(await readFile(appEnv), original);
  assert.deepEqual(await readdir(directory), ['app']);
  assert.equal(result.stdout.includes('DRY_RUN_NEW_SECRET'), false);
}));

test('apply preserves unrelated env bytes, writes private backups and user units, then is idempotent', async () => fixture(async (directory, appEnv) => {
  const original = await readFile(appEnv);
  const first = run(directory, appEnv, true);
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  const appText = await readFile(appEnv, 'utf8');
  assert.equal(appText.startsWith(original.toString()), true);
  const token = appText.match(/^DASHBOARD_USAGE_CRON_SECRET=([^\r\n]+)$/m)?.[1];
  assert.match(token!, /^[A-Za-z0-9_-]{64}$/);
  const config = await readFile(path.join(directory, '.config/kts-dashboard-usage.env'), 'utf8');
  assert.equal(config.includes(`DASHBOARD_USAGE_CRON_SECRET=${token}\n`), true);
  assert.equal(config.includes('DASHBOARD_USAGE_CRON_URL=http://127.0.0.1:3000/api/cron/dashboard-usage'), true);
  assert.equal(first.stdout.includes(token!), false);
  for (const relative of ['app/.env.local', '.config/kts-dashboard-usage.env', '.config/systemd/user/kts-dashboard-usage.service', '.config/systemd/user/kts-dashboard-usage.timer']) {
    assert.equal((await lstat(path.join(directory, relative))).mode & 0o777, 0o600);
  }
  assert.equal((await lstat(path.join(directory, '.local/lib/kts-dashboard-usage/prune.mjs'))).mode & 0o777, 0o700);
  assert.equal((await lstat(output.backupDirectory)).mode & 0o777, 0o700);
  const backups = await readdir(output.backupDirectory);
  assert.equal(backups.length, 1);
  assert.equal((await lstat(path.join(output.backupDirectory, backups[0]))).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(path.join(output.backupDirectory, backups[0])), original);
  const service = await readFile(path.join(directory, '.config/systemd/user/kts-dashboard-usage.service'), 'utf8');
  assert.doesNotMatch(service, /^(?:User|Group)=/m);
  assert.match(service, /^EnvironmentFile=%h\/\.config\/kts-dashboard-usage.env$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node %h\//m);
  const second = run(directory, appEnv, true);
  assert.equal(second.status, 0, second.stderr);
  const repeated = JSON.parse(second.stdout);
  assert.deepEqual(repeated.changedFiles, []);
  assert.equal(repeated.secret, 'reused');
  assert.equal(repeated.backupDirectory, null);
  assert.deepEqual(await readdir(path.dirname(output.backupDirectory)), [path.basename(output.backupDirectory)]);
}));

test('a configured secret is reused without rewriting app env or unrelated scheduler bytes', async () => fixture(async (directory, appEnv) => {
  const original = `# preserve exact app contents\nDASHBOARD_USAGE_CRON_SECRET=${secret}\nUNRELATED=unchanged\n`;
  await writeFile(appEnv, original);
  await mkdir(path.join(directory, '.config'), { mode: 0o700 });
  const configFile = path.join(directory, '.config/kts-dashboard-usage.env');
  const prefix = '# preserve scheduler note\nOTHER_SETTING=kept\n';
  await writeFile(configFile, prefix, { mode: 0o600 });
  const result = run(directory, appEnv, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(appEnv, 'utf8'), original);
  assert.equal((await readFile(configFile, 'utf8')).startsWith(prefix), true);
  assert.equal((await readFile(configFile, 'utf8')).includes(secret), true);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(JSON.parse(result.stdout).changedFiles.includes(appEnv), false);
}));

test('mismatched or duplicate secrets refuse all mutation and never print either value', async () => fixture(async (directory, appEnv) => {
  const original = `DASHBOARD_USAGE_CRON_SECRET=${secret}\n`;
  await writeFile(appEnv, original);
  await mkdir(path.join(directory, '.config'), { mode: 0o700 });
  const second = 'different_secret_00000000000000000000000000000000';
  const configFile = path.join(directory, '.config/kts-dashboard-usage.env');
  await writeFile(configFile, `DASHBOARD_USAGE_CRON_SECRET=${second}\n`, { mode: 0o600 });
  const conflict = run(directory, appEnv, true);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /secrets differ/);
  assert.equal(conflict.stderr.includes(secret) || conflict.stderr.includes(second), false);
  assert.equal(await readFile(appEnv, 'utf8'), original);
  assert.deepEqual((await readdir(directory)).sort(), ['.config', 'app']);
  await writeFile(appEnv, `${original}${original}`);
  const duplicate = run(directory, appEnv, true);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /Duplicate managed/);
}));

test('insecure environment permissions, symlink files and symlink parents are rejected', async () => fixture(async (directory, appEnv) => {
  await chmod(appEnv, 0o644);
  const insecure = run(directory, appEnv, true);
  assert.equal(insecure.status, 1);
  assert.match(insecure.stderr, /not be readable/);
  await chmod(appEnv, 0o600);
  const link = path.join(directory, 'app/.env.link');
  await symlink(appEnv, link);
  assert.equal(run(directory, link, true).status, 1);
  await mkdir(path.join(directory, 'other-config'), { mode: 0o700 });
  await symlink(path.join(directory, 'other-config'), path.join(directory, '.config'));
  const parent = run(directory, appEnv, true);
  assert.equal(parent.status, 1);
  assert.match(parent.stderr, /Symlink or non-directory parent/);
  assert.deepEqual(await readdir(path.join(directory, 'other-config')), []);
}));

test('usage timer catches up missed purges and runs every 15 minutes', async () => {
  const timer = await readFile(path.resolve('ops/dashboard-usage/kts-dashboard-usage.timer'), 'utf8');
  assert.match(timer, /^OnCalendar=\*-\*-\* \*:00\/15:00 Europe\/Moscow$/m);
  assert.match(timer, /^RandomizedDelaySec=0$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers.target$/m);
});
