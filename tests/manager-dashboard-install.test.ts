import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const requireOps = createRequire(import.meta.url);
type CronIo = {read(): string; backup(source: string): string; write(source: string): void};
type DisableResult = {mode: string; changed: boolean; blockFound: boolean; unmanagedDashboardJobs: number; backup: string | null};
const {BEGIN, END, COMMAND, decodeCrontab, removeDashboardMailCrontab, disableCrontab, disable, safeError} = requireOps('../ops/manager-dashboard/disable-mail.cjs') as {
  BEGIN: string; END: string; COMMAND: string;
  decodeCrontab(bytes: Uint8Array): string;
  removeDashboardMailCrontab(source: string): string;
  disableCrontab(io: CronIo, apply: boolean): DisableResult;
  disable(args: string[]): unknown;
  safeError(error: unknown): string;
};
const stock = '# BEGIN STOCK IMPORT\n*/15 * * * * /usr/bin/node /srv/stock.cjs >> /srv/stock.log 2>&1\n# END STOCK IMPORT\n';
const block = [BEGIN, '# Dashboard mail job', '*/5 4-8 * * * ' + COMMAND, '0 9-15 * * * ' + COMMAND, END, ''].join('\n');

test('retired mail installer cannot configure env, schedule cron, or re-enable import', () => {
  const installer = fileURLToPath(new URL('../ops/manager-dashboard/install-mail.cjs', import.meta.url));
  for (const argument of ['configure', 'schedule']) {
    const child = spawnSync(process.execPath, [installer, argument], {
      env: {NODE_ENV: 'test', MANAGER_DASHBOARD_MAIL_ENABLED: 'true'}, encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    assert.equal(JSON.parse(child.stdout).reason, 'manual_only');
    assert.equal(child.stderr, '');
  }
  const {install} = requireOps(installer);
  const forbidden = new Proxy([], {get() { assert.fail('Retired installer must ignore arguments'); }});
  assert.equal(install(forbidden).status, 'disabled');
});

test('disable transform removes only owned cron block and preserves stock, notification and timezone bytes', () => {
  const prefix = 'MAILTO="operator@example.test"\nCRON_TZ=Europe/Moscow\n' + stock + '\n';
  const suffix = '# Keep notification schedule\n0 8 * * * /usr/bin/node /srv/send-mail.cjs';
  assert.equal(removeDashboardMailCrontab(prefix + block + suffix), prefix + suffix);
  assert.equal(removeDashboardMailCrontab(prefix + suffix), prefix + suffix);
  assert.equal(removeDashboardMailCrontab(block), '');
  assert.equal(removeDashboardMailCrontab(''), '');
});

test('disable transform preserves CRLF and no-final-newline content exactly and is idempotent', () => {
  const prefix = stock.replaceAll('\n', '\r\n');
  const source = prefix + block.replaceAll('\n', '\r\n') + '# Keep last line';
  const removed = removeDashboardMailCrontab(source);
  assert.equal(removed, prefix + '# Keep last line');
  assert.equal(removeDashboardMailCrontab(removed), removed);
  assert.equal(removeDashboardMailCrontab(block.trimEnd()), '');
});

test('ambiguous markers or unrelated commands inside the owned block fail without altering source', () => {
  for (const source of [BEGIN, END, END + '\n' + BEGIN, BEGIN + '\n' + BEGIN + '\n' + END]) {
    assert.throws(() => removeDashboardMailCrontab(source), /DISABLE_CRON_MARKERS/);
  }
  for (const line of ['*/15 * * * * node /srv/stock.cjs', 'MAILTO=changed@example.test',
    '*/5 4-8 * * * ' + COMMAND + '; node /srv/other.cjs']) {
    assert.throws(() => removeDashboardMailCrontab(BEGIN + '\n' + line + '\n' + END), /DISABLE_UNKNOWN_BLOCK_CONTENT/);
  }
});

function ioFor(source: string) {
  let value = source;
  const backups: string[] = [];
  const writes: string[] = [];
  const io: CronIo = {
    read: () => value,
    backup: (before) => {backups.push(before); return '/private/test-backup';},
    write: (after) => {writes.push(after); value = after;},
  };
  return {io, backups, writes};
}

test('crontab decoding preserves valid UTF-8 including BOM and rejects malformed bytes before backup/write', () => {
  const bytes = Buffer.from('\uFEFF# Комментарий\r\n' + stock + block);
  assert.deepEqual(Buffer.from(decodeCrontab(bytes)), bytes);
  for (const invalid of [Buffer.from([0xff]), Buffer.from([0xc3, 0x28]), Buffer.from([0xe2, 0x82])]) {
    for (const apply of [false, true]) {
      const h = ioFor(block);
      h.io.read = () => decodeCrontab(Buffer.concat([Buffer.from(stock + block), invalid]));
      assert.throws(() => disableCrontab(h.io, apply), {code: 'DISABLE_INVALID_TEXT'});
      assert.deepEqual(h.backups, []);
      assert.deepEqual(h.writes, []);
    }
  }
});

test('dry-run never creates backup or writes; apply saves exact backup and repeated apply is a no-op', () => {
  const original = stock + block;
  const h = ioFor(original);
  assert.deepEqual(disableCrontab(h.io, false), {
    mode: 'dry-run', changed: false, blockFound: true, unmanagedDashboardJobs: 0, backup: null,
  });
  assert.deepEqual(h.backups, []);
  assert.deepEqual(h.writes, []);
  assert.equal(disableCrontab(h.io, true).changed, true);
  assert.deepEqual(h.backups, [original]);
  assert.deepEqual(h.writes, [stock]);
  assert.equal(disableCrontab(h.io, true).changed, false);
  assert.equal(h.backups.length, 1);
  assert.equal(h.writes.length, 1);
});

test('unmanaged dashboard jobs outside marker are reported and preserved', () => {
  const unrelated = '0 * * * * node /custom/manager-dashboard-import.cjs\n';
  const h = ioFor(stock + unrelated + block);
  const result = disableCrontab(h.io, true);
  assert.equal(result.unmanagedDashboardJobs, 1);
  assert.deepEqual(h.writes, [stock + unrelated]);
});

test('concurrent cron change and post-write verification failure surface safe errors', () => {
  let reads = 0;
  const h = ioFor(block);
  h.io.read = () => ++reads === 1 ? block : stock + block;
  assert.throws(() => disableCrontab(h.io, true), /DISABLE_CHANGED/);
  assert.deepEqual(h.writes, []);
  const ignoredWrite = ioFor(block);
  ignoredWrite.io.write = () => {};
  assert.throws(() => disableCrontab(ignoredWrite.io, true), /DISABLE_VERIFY/);
});

test('cleanup rejects invalid text/usage and never prints arbitrary sensitive errors', () => {
  assert.throws(() => removeDashboardMailCrontab('x\0y'), /DISABLE_INVALID_TEXT/);
  assert.throws(() => removeDashboardMailCrontab('x'.repeat(1024 * 1024 + 1)), /DISABLE_INVALID_TEXT/);
  assert.throws(() => disable([]), /DISABLE_USAGE/);
  assert.throws(() => disable(['--apply', '--user=root']), /DISABLE_USAGE/);
  assert.equal(safeError(new Error('private token or command')), 'DISABLE_FAILED');
  assert.equal(safeError({code: 'DISABLE_CHANGED', message: 'private token'}), 'DISABLE_CHANGED');
});
