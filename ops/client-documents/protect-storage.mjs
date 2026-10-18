#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCTION_UPLOAD_ROOT = '/var/www/kts-uploads';

export function nginxWorkerUids(processes) {
  const workers = processes.split(/\r?\n/).map((line) => /^\s*(\d+)\s+nginx: worker process(?:\s|$)/.exec(line)).filter(Boolean);
  if (!workers.length) throw new Error('No running Nginx workers found; cannot verify static-file isolation');
  return [...new Set(workers.map((match) => Number(match[1])))];
}

export function configuredUploadRoot(environment, inheritedValue) {
  // ecosystem.config.cjs applies literal key/value lines to PM2's env, which
  // overrides inherited values. It does not unquote, expand or strip comments.
  // Reject syntax a dotenv/shell parser would interpret differently rather than
  // protect a guessed directory while the application uses another one.
  const declarations = environment.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#') && /^\s*(?:export\s+)?UPLOAD_DIR(?:\s|=|$)/.test(line));
  if (declarations.length > 1) throw new Error('Duplicate UPLOAD_DIR setting; inspect the application configuration');
  const declaration = declarations[0];
  if (declaration !== undefined && !/^\s*UPLOAD_DIR\s*=/.test(declaration)) {
    throw new Error('Unsupported UPLOAD_DIR syntax; use a plain key=value setting without export');
  }
  const raw = declaration === undefined ? inheritedValue : declaration.slice(declaration.indexOf('=') + 1);
  const configured = raw?.trim() || PRODUCTION_UPLOAD_ROOT;
  if (!path.isAbsolute(configured) || /[$'"`#\\\u0000-\u001f]/.test(configured)) {
    throw new Error('UPLOAD_DIR must be an explicit absolute path without quotes, comments, escapes or expansion');
  }
  return configured;
}

/**
 * Restrict only the private directory, in place. Existing document bytes, paths,
 * DB references and public sibling uploads are not moved, rewritten or removed.
 * Do not undo a successful restriction if a subsequent validation fails.
 */
export async function protectClientDocumentRoots({
  uploadRoots,
  ownerUid = process.getuid?.(),
  workerUids = nginxWorkerUids(execFileSync('/bin/ps', ['-eo', 'uid,args'], { encoding: 'utf8' })),
  checkOnly = false,
}) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid <= 0 || ownerUid !== process.getuid?.()) {
    throw new Error('Run this gate as the non-root application owner, not via sudo');
  }
  if (!workerUids.length || workerUids.some((uid) => !Number.isSafeInteger(uid) || uid <= 0 || uid === ownerUid)) {
    throw new Error('Nginx workers must run as a distinct non-root uid; owner-only permissions cannot isolate them');
  }
  if (!Array.isArray(uploadRoots) || !uploadRoots.length) throw new Error('Explicit upload roots are required');

  const directories = new Set();
  for (const uploadRoot of uploadRoots) {
    if (!path.isAbsolute(uploadRoot) || path.resolve(uploadRoot) === path.parse(uploadRoot).root) {
      throw new Error('Refusing a broad or relative upload root');
    }
    const root = await realpath(uploadRoot);
    const rootStat = await lstat(root);
    // Public uploads legitimately use kts:www-data 775. Group write on the
    // parent does not grant traversal/read of an owner-only child. Keep that
    // public-upload policy intact; validate the child's owner/inode separately.
    // This isolates normal distinct-uid workers, not a compromised host/root.
    if (!rootStat.isDirectory() || rootStat.uid !== ownerUid || (rootStat.mode & 0o002) !== 0) {
      throw new Error(`Upload root must be owned by the application and not world-writable: ${root}`);
    }
    const directory = path.join(root, 'client-documents');
    let stat;
    try { stat = await lstat(directory); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (checkOnly) throw new Error(`Private document directory is missing: ${directory}`);
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUid)) {
      throw new Error(`Private document root must be a real directory owned by the application: ${directory}`);
    }
    directories.add(directory);
  }

  for (const directory of directories) {
    if (!checkOnly) {
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    // O_NOFOLLOW and descriptor-based chmod keep a swapped symlink from changing
    // another directory. Recheck the inode before accepting the result.
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isDirectory() || before.uid !== ownerUid) throw new Error('Private root ownership changed during validation');
      if (!checkOnly && (before.mode & 0o7777) !== 0o700) await handle.chmod(0o700);
      const after = await handle.stat();
      const current = await lstat(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== ownerUid
        || current.ino !== after.ino || current.dev !== after.dev || (after.mode & 0o7777) !== 0o700) {
        throw new Error(`Private document isolation was not confirmed: ${directory}`);
      }
    } finally { await handle.close(); }
  }
  return { privateRoots: directories.size, workerUids };
}

function argumentsFor(args) {
  const options = { appEnv: '', publicRoot: '', checkOnly: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--app-env' && args[index + 1]) options.appEnv = args[++index];
    else if (args[index] === '--public-root' && args[index + 1]) options.publicRoot = args[++index];
    else if (args[index] === '--check') options.checkOnly = true;
    else throw new Error('Usage: protect-storage.mjs --app-env /absolute/.env.local --public-root /absolute/public/uploads [--check]');
  }
  if (!path.isAbsolute(options.appEnv) || !path.isAbsolute(options.publicRoot)) throw new Error('Explicit application environment and public upload root paths are required');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    const options = argumentsFor(process.argv.slice(2));
    const environment = await readFile(options.appEnv, 'utf8');
    const result = await protectClientDocumentRoots({
      // Cover the Nginx alias, app storage and standalone public symlink even if
      // they are different directories. Deduplicate their resolved roots.
      uploadRoots: [PRODUCTION_UPLOAD_ROOT, configuredUploadRoot(environment, process.env.UPLOAD_DIR), options.publicRoot],
      checkOnly: options.checkOnly,
    });
    console.log(`Private client document storage verified: ${result.privateRoots} owner-only roots; Nginx uid(s): ${result.workerUids.join(', ')}.`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Private document storage gate failed');
    process.exitCode = 1;
  });
}
