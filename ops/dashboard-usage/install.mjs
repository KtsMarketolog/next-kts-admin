#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_KEY = 'DASHBOARD_USAGE_CRON_SECRET';
const URL_KEY = 'DASHBOARD_USAGE_CRON_URL';
const DEFAULT_URL = 'http://127.0.0.1:3000/api/cron/dashboard-usage';
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

function argumentsFor(input) {
  const options = { apply: false, appEnv: '', taskHome: os.homedir() };
  for (let i = 0; i < input.length; i++) {
    const value = input[i];
    if (value === '--apply') options.apply = true;
    else if (value === '--dry-run') options.apply = false;
    else if (value === '--app-env' && input[i + 1]) options.appEnv = input[++i];
    else if (value === '--home' && input[i + 1]) options.taskHome = input[++i];
    else throw new Error('Usage: install.mjs --app-env /absolute/.env.local [--home /absolute/user-home] [--dry-run | --apply]');
  }
  if (!path.isAbsolute(options.appEnv) || !path.isAbsolute(options.taskHome) || !path.basename(options.appEnv).startsWith('.env')) {
    throw new Error('Use an explicit absolute application .env path and an absolute user home');
  }
  if (options.taskHome === '/' || options.appEnv === options.taskHome) throw new Error('Broad filesystem targets are not allowed');
  return options;
}

async function inspect(file, { required = false, privateFile = false } = {}) {
  let stat;
  try { stat = await lstat(file); } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Target must be a regular unlinked file: ${file}`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`Target is not owned by the current user: ${file}`);
  if (privateFile && (stat.mode & 0o077)) throw new Error(`Environment file must not be readable by other users: ${file}`);
  if (stat.size > 1024 * 1024) throw new Error(`Unexpectedly large configuration file: ${file}`);
  return { bytes: await readFile(file), mode: stat.mode & 0o777 };
}

async function safeParents(file) {
  let current = path.dirname(file);
  while (current !== path.dirname(current)) {
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Symlink or non-directory parent: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = path.dirname(current);
  }
}

function envValue(text, key) {
  const found = text.split(/\r?\n/).filter((line) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line));
  if (found.length > 1) throw new Error(`Duplicate managed environment setting: ${key}`);
  if (!found.length) return null;
  const value = found[0].slice(found[0].indexOf('=') + 1).trim();
  if (!value || /[\s'"`]/.test(value)) throw new Error(`Managed setting must be a single unquoted value: ${key}`);
  return value;
}

function validateSecret(secret) {
  if (secret !== null && !/^[A-Za-z0-9._~+/=-]{32,512}$/.test(secret)) throw new Error('Existing usage cron secret has unsupported format; it was not replaced');
}

function appendMissing(text, entries) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of entries) {
    if (envValue(text, key) !== null) continue;
    if (text && !text.endsWith('\n')) text += newline;
    text += `${key}=${value}${newline}`;
  }
  return text;
}

async function assertUnchanged(file, original) {
  const current = await inspect(file);
  if (original ? !current || !current.bytes.equals(original.bytes) || current.mode !== original.mode : current !== null) {
    throw new Error(`File changed during installation; refusing to overwrite: ${file}`);
  }
}

async function atomicWrite(file, bytes, mode, original) {
  await safeParents(file);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.usage-${randomBytes(12).toString('hex')}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await assertUnchanged(file, original);
    await rename(temporary, file);
    await chmod(file, mode);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const taskHome = await realpath(options.taskHome);
  const appEnv = path.resolve(options.appEnv);
  const configEnv = path.join(taskHome, '.config/kts-dashboard-usage.env');
  const caller = path.join(taskHome, '.local/lib/kts-dashboard-usage/prune.mjs');
  const unitDirectory = path.join(taskHome, '.config/systemd/user');
  const unitNames = ['kts-dashboard-usage.service', 'kts-dashboard-usage.timer'];
  const targets = [appEnv, configEnv, caller, ...unitNames.map((name) => path.join(unitDirectory, name))];
  if (new Set(targets).size !== targets.length) throw new Error('Configuration targets must be distinct');
  await Promise.all(targets.map(safeParents));
  const originals = await Promise.all(targets.map((file, i) => inspect(file, { required: i === 0, privateFile: i < 2 })));
  const appText = originals[0].bytes.toString('utf8');
  const configText = originals[1]?.bytes.toString('utf8') ?? '';
  if (!Buffer.from(appText).equals(originals[0].bytes) || (originals[1] && !Buffer.from(configText).equals(originals[1].bytes))) throw new Error('Environment files must contain valid UTF-8');
  const appSecret = envValue(appText, SECRET_KEY);
  const configSecret = envValue(configText, SECRET_KEY);
  validateSecret(appSecret); validateSecret(configSecret);
  if (appSecret && configSecret && appSecret !== configSecret) throw new Error('Application and scheduler secrets differ; no files changed');
  const existingUrl = envValue(configText, URL_KEY);
  if (existingUrl && existingUrl !== DEFAULT_URL) throw new Error('Existing scheduler URL differs from the reviewed loopback endpoint; no files changed');
  const generated = !appSecret && !configSecret;
  // Dry-run makes no filesystem changes and does not expose/generate a usable new secret.
  const secret = appSecret ?? configSecret ?? (options.apply ? randomBytes(48).toString('base64url') : 'DRY_RUN_NEW_SECRET_PLACEHOLDER_000000');
  const contents = [
    Buffer.from(appendMissing(appText, [[SECRET_KEY, secret]])),
    Buffer.from(appendMissing(configText, [[SECRET_KEY, secret], [URL_KEY, DEFAULT_URL]])),
    await readFile(path.join(sourceDirectory, '../../scripts/dashboard-usage-prune.mjs')),
    ...await Promise.all(unitNames.map((name) => readFile(path.join(sourceDirectory, name)))),
  ];
  const modes = [0o600, 0o600, 0o700, 0o600, 0o600];
  const changes = targets.map((file, i) => ({ file, original: originals[i], bytes: contents[i], mode: modes[i] }))
    .filter(({ original, bytes, mode }) => !original || !original.bytes.equals(bytes) || original.mode !== mode);
  let backupDirectory = null;
  if (options.apply && changes.length) {
    const backupRoot = path.join(taskHome, '.local/state/kts-dashboard-usage/backups');
    await safeParents(path.join(backupRoot, 'placeholder'));
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await chmod(backupRoot, 0o700);
    backupDirectory = await mkdtemp(path.join(backupRoot, 'install-'));
    await chmod(backupDirectory, 0o700);
    // Back up every overwritten file before writing the first change. Never log env contents.
    for (const [i, change] of changes.entries()) {
      await assertUnchanged(change.file, change.original);
      if (change.original) {
        const handle = await open(path.join(backupDirectory, `${i}-${path.basename(change.file)}.backup`), 'wx', 0o600);
        try { await handle.writeFile(change.original.bytes); await handle.sync(); } finally { await handle.close(); }
      }
    }
    for (const change of changes) await atomicWrite(change.file, change.bytes, change.mode, change.original);
  }
  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run', secret: generated ? (options.apply ? 'generated' : 'would-generate') : 'reused',
    changedFiles: changes.map(({ file }) => file), backupDirectory,
    applicationReloaded: false, timerEnabled: false,
    next: 'Reload the reviewed application release, then systemctl --user daemon-reload and enable the usage timer explicitly.',
  }));
}

main().catch((error) => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
