#!/usr/bin/env node
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node commissioning CLI; CommonJS also permits import-safe unit tests. */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseEnv } = require('node:util');

const BASE = '/home/kts/kts-next-admin';
const ENV_PATH = `${BASE}/.env.local`;
const SHARED = `${BASE}/shared`;
const BIN = `${SHARED}/bin`;
const WRAPPER = `${BIN}/manager-dashboard-check-email.cjs`;
const LOGS = `${SHARED}/logs`;
const LOG = `${LOGS}/manager-dashboard-mail.log`;
const BACKUPS = `${SHARED}/manager-dashboard-backups`;
const BEGIN = '# BEGIN KTS PERSONAL MANAGER DASHBOARD MAIL';
const END = '# END KTS PERSONAL MANAGER DASHBOARD MAIL';
const VALUES = Object.freeze({
  MANAGER_DASHBOARD_MAIL_ENABLED: 'true',
  MANAGER_DASHBOARD_MAIL_ALLOWED_FROM: 'ahmetshina.l@kts-impex.ru',
  MANAGER_DASHBOARD_MAIL_SCAN_LIMIT: '300',
  MANAGER_DASHBOARD_MAIL_LOOKBACK_DAYS: '14',
});
const ERROR_CODES = new Set([
  'INSTALL_USAGE', 'INSTALL_USER_GUARD', 'INSTALL_GROUP_GUARD', 'INSTALL_PATH_GUARD', 'INSTALL_CHANGED',
  'INSTALL_INVALID_TEXT', 'INSTALL_ENV_SYNTAX', 'INSTALL_ENV_PRESERVATION', 'INSTALL_CRON_MARKERS',
  'INSTALL_UNMANAGED_CRON', 'INSTALL_TIMEZONE_GUARD', 'INSTALL_NOT_CONFIGURED',
  'INSTALL_CRONTAB_READ', 'INSTALL_CRONTAB_WRITE', 'INSTALL_VERIFY',
]);

function fail(code) { const error = new Error(code); error.code = code; return error; }
function safeError(error) { return ERROR_CODES.has(error?.code) ? error.code : 'INSTALL_FAILED'; }
function validText(source) {
  if (typeof source !== 'string' || source.includes('\0') || Buffer.byteLength(source) > 1024 * 1024) throw fail('INSTALL_INVALID_TEXT');
}
function linesOf(source) {
  validText(source);
  return [...source.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)]
    .filter((match) => match[0] !== '').map((match) => ({ text: match[1], eol: match[2], raw: match[0] }));
}
function parsedEnv(source) {
  try { return parseEnv(source); }
  catch { throw fail('INSTALL_ENV_SYNTAX'); }
}
function verifyEnvValues(before, after) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (Object.prototype.hasOwnProperty.call(VALUES, key)) continue;
    if (Object.prototype.hasOwnProperty.call(before, key) !== Object.prototype.hasOwnProperty.call(after, key)
      || before[key] !== after[key]) throw fail('INSTALL_ENV_PRESERVATION');
  }
  for (const [key, value] of Object.entries(VALUES)) {
    if (!Object.prototype.hasOwnProperty.call(after, key) || after[key] !== value) throw fail('INSTALL_ENV_PRESERVATION');
  }
}

/** Rewrites only the four approved keys; all unrelated physical lines remain byte-for-byte unchanged. */
function updateEnv(source) {
  const lines = linesOf(source);
  const before = parsedEnv(source);
  const eol = lines.find((line) => line.eol)?.eol || '\n';
  const seen = new Set();
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const first = lines[index];
    // Node accepts dotted/other nonstandard keys and ends a quoted value at the
    // first matching quote, including a quote preceded by a backslash. Do not
    // treat the BOM as whitespace: parseEnv considers it part of a key.
    const assignment = first.text.trimStart().startsWith('#') ? null
      : first.text.match(/^[ \t]*(?:export[ \t]+)?([^=\r\n]+?)[ \t]*=[ \t]*(.*)$/);
    const group = [first];
    if (assignment && ['"', "'", '`'].includes(assignment[2][0])) {
      const quote = assignment[2][0];
      let closed = assignment[2].indexOf(quote, 1) !== -1;
      while (!closed && index + 1 < lines.length) {
        group.push(lines[++index]);
        closed = lines[index].text.includes(quote);
      }
      if (!closed) throw fail('INSTALL_ENV_SYNTAX');
    }
    if (assignment && Object.prototype.hasOwnProperty.call(VALUES, assignment[1])) {
      // Even discarded duplicate assignments must not hide unrelated variables.
      if (Object.keys(parsedEnv(group.map((line) => line.raw).join('')))
        .some((key) => !Object.prototype.hasOwnProperty.call(VALUES, key))) throw fail('INSTALL_ENV_PRESERVATION');
      seen.add(assignment[1]);
      output.push(`${assignment[1]}=${VALUES[assignment[1]]}${group.at(-1).eol}`);
    } else output.push(...group.map((line) => line.raw));
  }
  let next = output.join('');
  for (const [key, value] of Object.entries(VALUES)) {
    if (seen.has(key)) continue;
    if (next && !/[\r\n]$/.test(next)) next += eol;
    next += `${key}=${value}${eol}`;
  }
  validText(next);
  // The runtime parser is the final authority. Never write if any unrelated
  // parsed value changes or if an approved setting was not applied exactly.
  verifyEnvValues(before, parsedEnv(next));
  return next;
}

/** Replaces only our named block. Never rewrites, normalizes or removes stock/other job bytes. */
function updateCrontab(source) {
  const lines = linesOf(source);
  const starts = lines.flatMap((line, index) => line.text.trim() === BEGIN ? [index] : []);
  const ends = lines.flatMap((line, index) => line.text.trim() === END ? [index] : []);
  if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length
    || (starts.length && starts[0] >= ends[0])) throw fail('INSTALL_CRON_MARKERS');
  const outside = lines.filter((_, index) => !starts.length || index < starts[0] || index > ends[0]);
  for (const { text } of outside) {
    if (!text.trim() || text.trim().startsWith('#')) continue;
    if (/manager[-_]dashboard|import-manager-snapshots/i.test(text)) throw fail('INSTALL_UNMANAGED_CRON');
    const timezone = text.match(/^\s*(?:CRON_TZ|TZ)\s*=\s*(.*?)\s*$/);
    if (timezone && !/^(?:UTC|Etc\/UTC|"UTC"|"Etc\/UTC"|'UTC'|'Etc\/UTC')$/.test(timezone[1])) throw fail('INSTALL_TIMEZONE_GUARD');
  }
  const command = `umask 077; /usr/bin/node --env-file=${ENV_PATH} ${WRAPPER} >> ${LOG} 2>&1`;
  const block = [BEGIN, '# UTC: 07:00–11:55 MSK every 5 minutes; 12:00–18:00 MSK hourly.',
    `*/5 4-8 * * * ${command}`, `0 9-15 * * * ${command}`, END, ''].join('\n');
  const next = starts.length ? lines.slice(0, starts[0]).map((line) => line.raw).join('')
    + block + lines.slice(ends[0] + 1).map((line) => line.raw).join('')
    : source + (source && !/[\r\n]$/.test(source) ? '\n' : '') + block;
  validText(next);
  return next;
}

/** NSS evidence must show that no other account can write through kts's primary group. */
function isPrivatePrimaryGroup({ uid, gid, groups, users }) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0
    || !Array.isArray(groups) || !groups.length || !Array.isArray(users) || !users.length) return false;
  if (groups.some((group) => !group || typeof group.name !== 'string' || !group.name
    || !Number.isSafeInteger(group.gid) || group.gid < 0 || !Array.isArray(group.members)
    || group.members.some((member) => typeof member !== 'string' || !member))) return false;
  // Numeric getent lookup alone can hide an alias with the same gid and other members.
  const matchingGid = groups.filter((group) => group.gid === gid);
  const matchingName = groups.filter((group) => group.name === 'kts');
  if (matchingGid.length !== 1 || matchingName.length !== 1 || matchingGid[0] !== matchingName[0]
    || matchingGid[0].members.some((member) => member !== 'kts')) return false;
  if (users.some((user) => !user || typeof user.name !== 'string' || !user.name
    || !Number.isSafeInteger(user.uid) || user.uid < 0 || !Number.isSafeInteger(user.gid) || user.gid < 0)) return false;
  const account = users.filter((user) => user.name === 'kts');
  return account.length === 1 && account[0].uid === uid && account[0].gid === gid
    && users.every((user) => (user.gid !== gid && user.uid !== uid) || user.name === 'kts');
}
function safeDirectoryMode(mode, gid, privateGid = null) {
  return Number.isSafeInteger(mode) && mode >= 0 && !(mode & 0o002)
    && (!(mode & 0o020) || (Number.isSafeInteger(privateGid) && privateGid > 0 && gid === privateGid));
}
function privatePrimaryGroup(uid, gid) {
  const readRecords = (args, group) => {
    let bytes;
    try {
      bytes = execFileSync('/usr/bin/getent', args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 10000 });
      // Retain only names, uid/gid and explicit group members. Never print NSS output.
      return textOf(bytes).split('\n').filter(Boolean).map((line) => {
        const fields = line.split(':');
        if (fields.length !== (group ? 4 : 7) || !/^\d+$/.test(fields[2]) || (!group && !/^\d+$/.test(fields[3]))) throw fail('INSTALL_GROUP_GUARD');
        return group ? { name: fields[0], gid: Number(fields[2]), members: fields[3] ? fields[3].split(',') : [] }
          : { name: fields[0], uid: Number(fields[2]), gid: Number(fields[3]) };
      });
    } catch { throw fail('INSTALL_GROUP_GUARD'); }
    finally { if (bytes) bytes.fill(0); }
  };
  const groups = readRecords(['group'], true);
  const users = readRecords(['passwd'], false);
  if (!isPrivatePrimaryGroup({ uid, gid, groups, users })) throw fail('INSTALL_GROUP_GUARD');
  return gid;
}
function guardedDirectory(directory, uid, create = false, privateMode = false, privateGid = null) {
  if (create && !fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || !safeDirectoryMode(stat.mode, stat.gid, privateGid)
    || (privateMode && (stat.mode & 0o777) !== 0o700) || fs.realpathSync(directory) !== directory) throw fail('INSTALL_PATH_GUARD');
}
function statIsOwnedFile(stat, uid) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1;
}
function readOwnedFile(filename, uid, maxBytes = 1024 * 1024) {
  const before = fs.lstatSync(filename);
  if (!statIsOwnedFile(before, uid) || before.size > maxBytes || fs.realpathSync(filename) !== filename) throw fail('INSTALL_PATH_GUARD');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!statIsOwnedFile(stat, uid) || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) throw fail('INSTALL_PATH_GUARD');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > maxBytes) throw fail('INSTALL_PATH_GUARD');
    return { bytes, stat };
  } finally { fs.closeSync(fd); }
}
function textOf(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw fail('INSTALL_INVALID_TEXT'); }
}
function sameFile(original, current) {
  return original.stat.dev === current.stat.dev && original.stat.ino === current.stat.ino
    && original.stat.mtimeMs === current.stat.mtimeMs && original.stat.ctimeMs === current.stat.ctimeMs
    && original.bytes.equals(current.bytes);
}
function privateBackup(label, bytes, uid) {
  guardedDirectory(BACKUPS, uid, true, true);
  const filename = `${BACKUPS}/${label}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.bak`;
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const dirFd = fs.openSync(BACKUPS, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  return filename;
}
function atomicPrivateWrite(filename, bytes, uid, original, privateGid) {
  const directory = path.dirname(filename);
  guardedDirectory(directory, uid, false, false, privateGid);
  const temporary = `${directory}/.manager-dashboard-${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    guardedDirectory(directory, uid, false, false, privateGid);
    if (original) {
      if (!sameFile(original, readOwnedFile(filename, uid))) throw fail('INSTALL_CHANGED');
    } else {
      try { fs.lstatSync(filename); throw fail('INSTALL_CHANGED'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fs.renameSync(temporary, filename);
    const dirFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    const written = readOwnedFile(filename, uid);
    if ((written.stat.mode & 0o777) !== 0o600 || !written.bytes.equals(bytes)) throw fail('INSTALL_VERIFY');
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function existingFile(filename, uid) {
  try { return readOwnedFile(filename, uid); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function ensurePrivateLog(uid, privateGid) {
  guardedDirectory(LOGS, uid, true, false, privateGid);
  let before = null;
  try {
    before = fs.lstatSync(LOG);
    if (!statIsOwnedFile(before, uid) || fs.realpathSync(LOG) !== LOG) throw fail('INSTALL_PATH_GUARD');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const flags = before ? fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW
    : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(LOG, flags, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!statIsOwnedFile(stat, uid) || (before && (stat.ino !== before.ino || stat.dev !== before.dev))) throw fail('INSTALL_PATH_GUARD');
    fs.fchmodSync(fd, 0o600);
  } finally { fs.closeSync(fd); }
}
function readCrontab() {
  try { return textOf(execFileSync('/usr/bin/crontab', ['-l'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 1024 * 1024, timeout: 10000 })); }
  catch (error) {
    if (error.status === 1 && /^no crontab for kts\s*$/.test(String(error.stderr).trim())) return '';
    throw fail('INSTALL_CRONTAB_READ');
  }
}
function install(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['configure', 'schedule'].includes(args[0])) throw fail('INSTALL_USAGE');
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0
    || process.geteuid() !== process.getuid() || process.getegid() !== process.getgid() || os.userInfo().username !== 'kts') throw fail('INSTALL_USER_GUARD');
  process.umask(0o077);
  const uid = process.getuid();
  const privateGid = privatePrimaryGroup(uid, process.getgid());
  guardedDirectory(BASE, uid, false, false, privateGid);
  guardedDirectory(SHARED, uid, false, false, privateGid);
  const original = readOwnedFile(ENV_PATH, uid);
  const nextEnv = Buffer.from(updateEnv(textOf(original.bytes)));
  const source = readOwnedFile(path.join(__dirname, 'check-email.cjs'), uid, 256 * 1024);
  const backups = [];
  if (args[0] === 'configure') {
    guardedDirectory(BIN, uid, true, false, privateGid);
    const oldWrapper = existingFile(WRAPPER, uid);
    if (!oldWrapper || !oldWrapper.bytes.equals(source.bytes) || (oldWrapper.stat.mode & 0o777) !== 0o600) {
      if (oldWrapper) backups.push(privateBackup('wrapper', oldWrapper.bytes, uid));
      atomicPrivateWrite(WRAPPER, source.bytes, uid, oldWrapper, privateGid);
    }
    ensurePrivateLog(uid, privateGid);
    if (!nextEnv.equals(original.bytes) || (original.stat.mode & 0o777) !== 0o600) {
      backups.push(privateBackup('env', original.bytes, uid));
      atomicPrivateWrite(ENV_PATH, nextEnv, uid, original, privateGid);
    }
    return { mode: 'configure', configured: true, scheduleChanged: false, backups };
  }
  // Schedule is a separate explicit operation, to be run only after a successful manual probe.
  if (!nextEnv.equals(original.bytes) || (original.stat.mode & 0o777) !== 0o600) throw fail('INSTALL_NOT_CONFIGURED');
  guardedDirectory(BIN, uid, false, false, privateGid);
  const installed = readOwnedFile(WRAPPER, uid);
  if (!installed.bytes.equals(source.bytes) || (installed.stat.mode & 0o777) !== 0o600) throw fail('INSTALL_NOT_CONFIGURED');
  const timezone = execFileSync('/usr/bin/timedatectl', ['show', '--property=Timezone', '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
  if (!['UTC', 'Etc/UTC'].includes(timezone)) throw fail('INSTALL_TIMEZONE_GUARD');
  const before = readCrontab();
  const after = updateCrontab(before);
  ensurePrivateLog(uid, privateGid);
  if (after === before) return { mode: 'schedule', changed: false, backups };
  backups.push(privateBackup('crontab', Buffer.from(before), uid));
  // Detect another editor before replacement. The backup also preserves the full prior crontab.
  if (readCrontab() !== before) throw fail('INSTALL_CHANGED');
  try { execFileSync('/usr/bin/crontab', ['-'], { input: after, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }); }
  catch { throw fail('INSTALL_CRONTAB_WRITE'); }
  if (readCrontab() !== after) throw fail('INSTALL_VERIFY');
  return { mode: 'schedule', changed: true, backups };
}

if (require.main === module) {
  try { console.log(JSON.stringify(install())); }
  catch (error) { console.error(safeError(error)); process.exitCode = 1; }
}

module.exports = { updateEnv, updateCrontab, isPrivatePrimaryGroup, safeDirectoryMode, safeError, install, BASE, BEGIN, END, VALUES };
