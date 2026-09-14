import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { parseEnv } from 'node:util';

const requireForInstall = createRequire(import.meta.url);
type GroupEvidence = {
  uid: number;
  gid: number;
  groups: Array<{ name: string; gid: number; members: string[] }>;
  users: Array<{ name: string; uid: number; gid: number }>;
};
const { updateEnv, updateCrontab, isPrivatePrimaryGroup, safeDirectoryMode, safeError, install, BEGIN, END, VALUES } = requireForInstall('../ops/manager-dashboard/install-mail.cjs') as {
  updateEnv(source: string): string;
  updateCrontab(source: string): string;
  isPrivatePrimaryGroup(evidence: GroupEvidence): boolean;
  safeDirectoryMode(mode: number, gid: number, privateGid?: number | null): boolean;
  safeError(error: unknown): string;
  install(args: string[]): unknown;
  BEGIN: string;
  END: string;
  VALUES: Record<string, string>;
};

const privateGroup: GroupEvidence = {
  uid: 1000, gid: 1000, groups: [{ name: 'root', gid: 0, members: [] }, { name: 'kts', gid: 1000, members: [] }],
  users: [{ name: 'root', uid: 0, gid: 0 }, { name: 'kts', uid: 1000, gid: 1000 }],
};

test('private primary group evidence accepts only kts, including an explicit self-membership', () => {
  assert.equal(isPrivatePrimaryGroup(privateGroup), true);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, groups: [{ name: 'kts', gid: 1000, members: ['kts'] }] }), true);
});

test('private primary group rejects extra primary/supplementary members, aliases and inconsistent identity', () => {
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, groups: [{ name: 'kts', gid: 1000, members: ['other'] }] }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, users: [...privateGroup.users, { name: 'other', uid: 1001, gid: 1000 }] }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, users: [...privateGroup.users, { name: 'alias', uid: 1000, gid: 1001 }] }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, groups: [{ name: 'users', gid: 1000, members: [] }] }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, groups: [{ name: 'kts', gid: 1001, members: [] }] }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, uid: 0 }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, gid: 1001 }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, users: [] }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, users: [...privateGroup.users, privateGroup.users[1]] }), false);
});

test('private primary group rejects hidden duplicate-gid aliases and conflicting kts group names', () => {
  const otherUser = { name: 'other', uid: 1001, gid: 1001 };
  assert.equal(isPrivatePrimaryGroup({
    ...privateGroup,
    users: [...privateGroup.users, otherUser],
    groups: [...privateGroup.groups, { name: 'shared', gid: 1000, members: ['other'] }],
  }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, groups: [...privateGroup.groups, { name: 'alias', gid: 1000, members: [] }] }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, groups: [...privateGroup.groups, { name: 'kts', gid: 1001, members: [] }] }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, groups: [...privateGroup.groups, privateGroup.groups[1]] }), false);
  assert.equal(isPrivatePrimaryGroup({ ...privateGroup, groups: [] }), false);
});

test('directory permissions allow 775 only for the independently validated private gid; world write is always denied', () => {
  assert.equal(safeDirectoryMode(0o775, 1000, 1000), true);
  assert.equal(safeDirectoryMode(0o775, 1001, 1000), false);
  assert.equal(safeDirectoryMode(0o775, 1000), false);
  assert.equal(safeDirectoryMode(0o777, 1000, 1000), false);
  assert.equal(safeDirectoryMode(0o757, 1000, 1000), false);
  assert.equal(safeDirectoryMode(0o755, 1001), true);
  assert.equal(safeDirectoryMode(0o700, 1000), true);
});

test('configure updates only approved env assignments and preserves all unrelated bytes', () => {
  const untouched = '# comment\r\nSTOCK_MAIL_PASSWORD="synthetic-not-a-credential"\r\nSTOCK_MAIL_ENABLED=true\r\n\r\n';
  const source = `${untouched} export MANAGER_DASHBOARD_MAIL_ENABLED = false # disabled\r\nMANAGER_DASHBOARD_MAIL_ALLOWED_FROM=old@example.test\r\nTAIL=keep exactly  \r\n`;
  const result = updateEnv(source);
  assert.ok(result.startsWith(untouched));
  assert.ok(result.includes('TAIL=keep exactly  \r\n'));
  for (const [key, value] of Object.entries(VALUES)) assert.ok(result.includes(`${key}=${value}\r\n`));
  assert.equal(updateEnv(result), result);
});

test('configure treats assignment-looking lines inside multiline values as unrelated data', () => {
  const multiline = 'UNRELATED_VALUE="first\nMANAGER_DASHBOARD_MAIL_ENABLED=false\nlast"\n';
  const result = updateEnv(multiline);
  assert.ok(result.startsWith(multiline));
  assert.ok(result.includes('\nMANAGER_DASHBOARD_MAIL_ENABLED=true\n'));
  assert.throws(() => updateEnv('UNRELATED_VALUE="unfinished\n'), /INSTALL_ENV_SYNTAX/);
});

test('configure handles duplicate keys, quoted target values and files without final newline', () => {
  const result = updateEnv('UNCHANGED=yes\nMANAGER_DASHBOARD_MAIL_ENABLED="false"\nMANAGER_DASHBOARD_MAIL_ENABLED=false');
  assert.equal(result.match(/MANAGER_DASHBOARD_MAIL_ENABLED=true/g)?.length, 2);
  assert.ok(result.startsWith('UNCHANGED=yes\n'));
  assert.equal(updateEnv(result), result);
  const multilineTarget = updateEnv('MANAGER_DASHBOARD_MAIL_ALLOWED_FROM="\nold@example.test\n"\nOTHER=1\n');
  assert.ok(multilineTarget.startsWith(`MANAGER_DASHBOARD_MAIL_ALLOWED_FROM=${VALUES.MANAGER_DASHBOARD_MAIL_ALLOWED_FROM}\nOTHER=1\n`));
});

test('configure preserves a UTF-8 BOM and adds missing values to an empty file', () => {
  const result = updateEnv('\uFEFF# configuration\nOTHER=value');
  assert.ok(result.startsWith('\uFEFF# configuration\nOTHER=value\n'));
  const bomSetting = '\uFEFFMANAGER_DASHBOARD_MAIL_ENABLED=false\n';
  const updatedBom = updateEnv(bomSetting);
  assert.ok(updatedBom.startsWith(bomSetting));
  assert.equal(parseEnv(updatedBom)['\uFEFFMANAGER_DASHBOARD_MAIL_ENABLED'], 'false');
  assert.equal(parseEnv(updatedBom).MANAGER_DASHBOARD_MAIL_ENABLED, 'true');
  const quoted = '\uFEFFOTHER="first\nMANAGER_DASHBOARD_MAIL_ENABLED=false\nlast"\n';
  assert.ok(updateEnv(quoted).startsWith(quoted));
  assert.equal(Object.keys(VALUES).length, 4);
  for (const [key, value] of Object.entries(VALUES)) assert.ok(updateEnv('').includes(`${key}=${value}\n`));
});

function assertParsedPreservation(source: string, result: string) {
  const before = parseEnv(source);
  const after = parseEnv(result);
  const unrelated = (values: Record<string, string | undefined>) => Object.fromEntries(Object.entries(values).filter(([key]) => !(key in VALUES)));
  assert.deepEqual(unrelated(after), unrelated(before));
  for (const [key, value] of Object.entries(VALUES)) assert.equal(after[key], value);
}

test('configure follows real Node quote parsing and never deletes assignments after a backslash-quote', () => {
  const source = 'MANAGER_DASHBOARD_MAIL_ALLOWED_FROM="old\\"\nUNRELATED=keep\nNEXT="close"\n';
  const result = updateEnv(source);
  assert.ok(result.includes('UNRELATED=keep\nNEXT="close"\n'));
  assertParsedPreservation(source, result);
});

test('configure preserves multiline values under dotted, dashed, spaced and BOM keys', () => {
  for (const key of ['OTHER.KEY', 'OTHER-KEY', 'OTHER KEY', '"OTHER"', '\uFEFFOTHER']) {
    const source = `${key}="first\nMANAGER_DASHBOARD_MAIL_ENABLED=false\nlast"\n`;
    const result = updateEnv(source);
    assert.ok(result.startsWith(source));
    assertParsedPreservation(source, result);
  }
});

test('configure validates complete Node-parsed values for quote/comment/export edge cases', () => {
  const fixtures = [
    '# ignored="quote\nMANAGER_DASHBOARD_MAIL_ENABLED=false\n',
    'export OTHER.KEY=`first\nMANAGER_DASHBOARD_MAIL_ENABLED=false\nlast`\n',
    'OTHER="before\\"\nMANAGER_DASHBOARD_MAIL_ENABLED=false\nNEXT=keep\n',
    'OTHER=one # comment\nMANAGER_DASHBOARD_MAIL_ENABLED="false"\n',
    'OTHER="first\nMANAGER_DASHBOARD_MAIL_ALLOWED_FROM=not-a-setting\nlast"\nOTHER=final\n',
  ];
  for (const source of fixtures) assertParsedPreservation(source, updateEnv(source));
});

test('configure fails closed when unsupported syntax could rename an unrelated Node-parsed key', () => {
  const source = 'export\tMANAGER_DASHBOARD_MAIL_ENABLED=false\nOTHER=keep\n';
  assert.equal(parseEnv(source)['export\tMANAGER_DASHBOARD_MAIL_ENABLED'], 'false');
  assert.throws(() => updateEnv(source), /INSTALL_ENV_PRESERVATION/);
});

const stock = '# BEGIN STOCK IMPORT\n*/15 * * * * /usr/bin/node /srv/stock.cjs >> /srv/stock.log 2>&1\n# END STOCK IMPORT\n';

test('schedule adds the exact UTC jobs in one named block without changing stock bytes', () => {
  const source = `MAILTO=""\n${stock}\n# keep trailing comment\n`;
  const result = updateCrontab(source);
  assert.ok(result.startsWith(source));
  assert.equal(result.split(BEGIN).length, 2);
  assert.equal(result.split(END).length, 2);
  assert.match(result, /^\*\/5 4-8 \* \* \* umask 077; \/usr\/bin\/node --env-file=\/home\/kts\/kts-next-admin\/\.env\.local \/home\/kts\/kts-next-admin\/shared\/bin\/manager-dashboard-check-email\.cjs >> \/home\/kts\/kts-next-admin\/shared\/logs\/manager-dashboard-mail\.log 2>&1$/m);
  assert.match(result, /^0 9-15 \* \* \* /m);
  assert.doesNotMatch(result, /\/current\/|CRON_SECRET|PASSWORD/);
  assert.equal(updateCrontab(result), result);
});

test('schedule replaces only its own existing block and preserves bytes before and after it', () => {
  const prefix = `${stock}\n`;
  const suffix = '\n# keep suffix exactly  \n1 1 * * * /srv/other-job\n';
  const result = updateCrontab(`${prefix}${BEGIN}\nold personal command\n${END}\n${suffix}`);
  assert.ok(result.startsWith(prefix));
  assert.ok(result.endsWith(suffix));
  assert.doesNotMatch(result, /old personal command/);
});

test('schedule preserves CRLF stock lines and safely appends after a missing final newline', () => {
  const crlf = stock.replaceAll('\n', '\r\n');
  assert.ok(updateCrontab(crlf).startsWith(crlf));
  assert.equal(updateCrontab(updateCrontab(crlf)), updateCrontab(crlf));
  assert.ok(updateCrontab('# no final newline').startsWith('# no final newline\n'));
});

test('schedule rejects malformed blocks, unmanaged duplicate jobs and conflicting timezone declarations', () => {
  for (const source of [BEGIN, END, `${END}\n${BEGIN}\n`, `${BEGIN}\n${BEGIN}\n${END}\n`]) {
    assert.throws(() => updateCrontab(source), /INSTALL_CRON_MARKERS/);
  }
  assert.throws(() => updateCrontab('0 * * * * node /tmp/manager-dashboard/check-email.cjs\n'), /INSTALL_UNMANAGED_CRON/);
  assert.throws(() => updateCrontab('CRON_TZ=Europe/Moscow\n'), /INSTALL_TIMEZONE_GUARD/);
  assert.throws(() => updateCrontab('TZ="Europe/Moscow"\n'), /INSTALL_TIMEZONE_GUARD/);
  assert.ok(updateCrontab('CRON_TZ=Etc/UTC\n').startsWith('CRON_TZ=Etc/UTC\n'));
});

test('pure transforms reject binary/oversized content and diagnostic output never exposes arbitrary errors', () => {
  for (const transform of [updateEnv, updateCrontab]) {
    assert.throws(() => transform('value\0hidden'), /INSTALL_INVALID_TEXT/);
    assert.throws(() => transform('x'.repeat(1024 * 1024 + 1)), /INSTALL_INVALID_TEXT/);
  }
  assert.equal(safeError(new Error('synthetic sensitive detail')), 'INSTALL_FAILED');
  assert.equal(safeError({ code: 'INSTALL_PATH_GUARD', message: 'synthetic sensitive detail' }), 'INSTALL_PATH_GUARD');
  assert.throws(() => install([]), /INSTALL_USAGE/);
  assert.throws(() => install(['configure', '--base=/tmp']), /INSTALL_USAGE/);
});

test('pure transforms reject oversized resulting text before any filesystem or crontab write', () => {
  const max = 1024 * 1024;
  const envAtInputLimit = `OTHER=${'x'.repeat(max - 'OTHER='.length)}`;
  const cronAtInputLimit = `#${'x'.repeat(max - 1)}`;
  assert.equal(Buffer.byteLength(envAtInputLimit), max);
  assert.equal(Buffer.byteLength(cronAtInputLimit), max);
  assert.throws(() => updateEnv(envAtInputLimit), /INSTALL_INVALID_TEXT/);
  assert.throws(() => updateCrontab(cronAtInputLimit), /INSTALL_INVALID_TEXT/);
  const envPrefix = `OTHER=${'x'.repeat(max - Buffer.byteLength(updateEnv('')) - 'OTHER=\n'.length)}\n`;
  assert.equal(Buffer.byteLength(updateEnv(envPrefix)), max);
  const cronPrefix = `#${'x'.repeat(max - Buffer.byteLength(updateCrontab('')) - '#\n'.length)}\n`;
  assert.equal(Buffer.byteLength(updateCrontab(cronPrefix)), max);
});
