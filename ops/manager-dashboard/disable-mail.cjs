#!/usr/bin/env node
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone, import-safe operations CLI. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BEGIN = '# BEGIN KTS PERSONAL MANAGER DASHBOARD MAIL';
const END = '# END KTS PERSONAL MANAGER DASHBOARD MAIL';
const BASE = '/home/kts/kts-next-admin';
const COMMAND = `umask 077; /usr/bin/node --env-file=${BASE}/.env.local ${BASE}/shared/bin/manager-dashboard-check-email.cjs >> ${BASE}/shared/logs/manager-dashboard-mail.log 2>&1`;
const OWN_JOBS = new Set([`*/5 4-8 * * * ${COMMAND}`, `0 9-15 * * * ${COMMAND}`]);
const ERROR_CODES = new Set(['DISABLE_USAGE', 'DISABLE_USER_GUARD', 'DISABLE_INVALID_TEXT',
  'DISABLE_CRON_MARKERS', 'DISABLE_UNKNOWN_BLOCK_CONTENT', 'DISABLE_CRONTAB_READ',
  'DISABLE_CHANGED', 'DISABLE_CRONTAB_WRITE', 'DISABLE_VERIFY']);

function fail(code) { const error = new Error(code); error.code = code; return error; }
function safeError(error) { return ERROR_CODES.has(error?.code) ? error.code : 'DISABLE_FAILED'; }

/** Refuse lossy decoding; keep a UTF-8 BOM so backups retain the original bytes. */
function decodeCrontab(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw fail('DISABLE_INVALID_TEXT'); }
}

/** Remove only this installer's exact block; preserve every byte outside it. */
function removeDashboardMailCrontab(source) {
  if (typeof source !== 'string' || source.includes('\0') || Buffer.byteLength(source) > 1024 * 1024) throw fail('DISABLE_INVALID_TEXT');
  const lines = [...source.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)].filter((match) => match[0] !== '');
  const starts = lines.flatMap((line, index) => line[1].trim() === BEGIN ? [index] : []);
  const ends = lines.flatMap((line, index) => line[1].trim() === END ? [index] : []);
  if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length
    || (starts.length && starts[0] >= ends[0])) throw fail('DISABLE_CRON_MARKERS');
  if (!starts.length) return source;
  for (const line of lines.slice(starts[0] + 1, ends[0])) {
    const content = line[1].trim();
    if (content && !content.startsWith('#') && !OWN_JOBS.has(content)) throw fail('DISABLE_UNKNOWN_BLOCK_CONTENT');
  }
  return lines.filter((_, index) => index < starts[0] || index > ends[0]).map((line) => line[0]).join('');
}

/** Separated from OS operations to test preservation and dry-run behavior without running cron. */
function disableCrontab(io, apply) {
  const before = io.read();
  const after = removeDashboardMailCrontab(before);
  const outsideJobs = after.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')
    && /manager[-_]dashboard|import-manager-snapshots/i.test(line)).length;
  const summary = { mode: apply ? 'apply' : 'dry-run', changed: false, blockFound: before !== after,
    unmanagedDashboardJobs: outsideJobs, backup: null };
  if (!apply || before === after) return summary;
  summary.backup = io.backup(before);
  // Refuse to overwrite a crontab changed after inspection/backup.
  if (io.read() !== before) throw fail('DISABLE_CHANGED');
  io.write(after);
  if (io.read() !== after) throw fail('DISABLE_VERIFY');
  return { ...summary, changed: true };
}

function readCrontab() {
  let bytes;
  try {
    bytes = execFileSync('/usr/bin/crontab', ['-l'], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 1024 * 1024, timeout: 10000 });
  } catch (error) {
    if (error.status === 1 && /^no crontab for kts\s*$/.test(String(error.stderr).trim())) return '';
    throw fail('DISABLE_CRONTAB_READ');
  }
  return decodeCrontab(bytes);
}

function disable(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['--dry-run', '--apply'].includes(args[0])) throw fail('DISABLE_USAGE');
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0
    || process.geteuid() !== process.getuid() || os.userInfo().username !== 'kts') throw fail('DISABLE_USER_GUARD');
  return disableCrontab({
    read: readCrontab,
    backup(source) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-dashboard-cron-backup-'));
      fs.chmodSync(directory, 0o700);
      const filename = path.join(directory, 'crontab.before');
      const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(descriptor, source); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      return filename;
    },
    write(source) {
      try { execFileSync('/usr/bin/crontab', ['-'], { input: source, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }); }
      catch { throw fail('DISABLE_CRONTAB_WRITE'); }
    },
  }, args[0] === '--apply');
}

module.exports = { BEGIN, END, COMMAND, decodeCrontab, removeDashboardMailCrontab, disableCrontab, disable, safeError };

if (require.main === module) {
  try { console.log(JSON.stringify(disable())); }
  catch (error) { console.error(safeError(error)); process.exitCode = 1; }
}
