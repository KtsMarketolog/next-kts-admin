import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { query } from './db/client';

const BACKUP_ROOT = '/home/kts/backups/kts-next-admin';
const FILE_NAME = /^[0-9a-f]{64}-[0-9a-f-]{36}\.bin$/u;
const STORAGE_PATH = /^[0-9a-f]{2}\/[0-9a-f]{64}-[0-9a-f-]{36}\.bin$/u;

async function unlinkIfPresent(filename: string) {
  await unlink(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/** The installed backup runner holds this same lock exclusively through DB + file capture. */
export async function withDashboardBackupLock<T>(action: () => Promise<T>): Promise<T | null> {
  const metadata = await lstat(BACKUP_ROOT).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata) return action();
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (await readFile(path.join(BACKUP_ROOT, '.kts-backup-root'), 'utf8')).trim() !== 'kts-next-admin') {
    throw new Error('Dashboard cleanup requires a verified backup directory');
  }

  const handle = await open(path.join(BACKUP_ROOT, '.operation.lock'),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    // Linux flock locks the shared open-file-description, not the helper PID. Keep
    // the parent's FD open throughout action, so helper exit cannot release our lock.
    const locked = await new Promise<boolean>((resolve) => {
      const child = spawn('/usr/bin/flock', ['--shared', '--nonblock', '3'],
        { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => { child.kill(); finish(false); }, 5_000);
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
    });
    if (!locked) return null;
    return await action();
  } finally {
    await handle.close();
  }
}

async function referencedPaths(storagePaths: string[]) {
  const result = await query<{ storage_path: string }>(`
    select storage_path from top_dashboard_block_data_versions where storage_path = any($1::text[])
    union
    select storage_path from support_shared_dashboard_json_snapshots where storage_path = any($1::text[])
  `, [storagePaths]);
  return new Set(result.rows.map((row) => row.storage_path));
}

type CleanupDependencies = {
  withLock: (action: () => Promise<number>) => Promise<number | null>;
  referencedPaths: (storagePaths: string[]) => Promise<Set<string>>;
  pendingPaths?: () => Promise<string[]>;
  acknowledge?: (storagePaths: string[]) => Promise<void>;
};

async function pendingPaths() {
  const result = await query<{ storage_path: string }>(`select storage_path
    from dashboard_file_cleanup_queue order by created_at, storage_path limit 128`);
  return result.rows.map((row) => row.storage_path);
}

async function acknowledge(storagePaths: string[]) {
  await query(`delete from dashboard_file_cleanup_queue where storage_path = any($1::text[])`, [storagePaths]);
}

/** Markers contain no customer data and survive a failed unlink or a busy backup. */
export async function enqueueDashboardFileCleanup(directory: string, storagePaths: readonly string[]) {
  // .incoming is excluded by the existing backup runner. Enqueuing while a backup
  // is busy must not change an archived directory and abort its consistency check.
  const pending = path.join(directory, '.incoming', '.pending-deletions');
  await mkdir(pending, { recursive: true, mode: 0o700 });
  for (const storagePath of new Set(storagePaths)) {
    if (!STORAGE_PATH.test(storagePath) || storagePath.slice(0, 2) !== path.basename(storagePath).slice(0, 2)) continue;
    const marker = await open(path.join(pending, path.basename(storagePath)),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    await marker.close();
  }
}

/** Recheck live references: restoring the database may make a queued file live again. */
export async function drainDashboardFileCleanup(
  directory: string,
  dependencies: CleanupDependencies = { withLock: withDashboardBackupLock, referencedPaths, pendingPaths, acknowledge },
): Promise<boolean> {
  const pending = path.join(directory, '.incoming', '.pending-deletions');
  const databasePaths = await dependencies.pendingPaths?.() ?? [];
  // A COMMIT acknowledgement/process failure may have prevented the request handler
  // from writing filesystem markers. The transaction's durable outbox recovers them.
  if (databasePaths.length) await enqueueDashboardFileCleanup(directory, databasePaths);
  const entries = await readdir(pending, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = entries.filter((entry) => entry.isFile() && FILE_NAME.test(entry.name));
  if (!files.length) return false;
  const batch = files.slice(0, 128);
  const removed = await dependencies.withLock(async () => {
    const paths = batch.map((entry) => `${entry.name.slice(0, 2)}/${entry.name}`);
    const referenced = await dependencies.referencedPaths(paths);
    for (const storagePath of paths) {
      if (!referenced.has(storagePath)) await unlinkIfPresent(path.join(directory, storagePath));
    }
    await dependencies.acknowledge?.(paths);
    for (const storagePath of paths) {
      await unlinkIfPresent(path.join(pending, path.basename(storagePath)));
    }
    return batch.length;
  });
  return removed === null || files.length > removed || databasePaths.length === 128;
}

// One unref'ed timer per directory/process, with bounded batches. Poll even after an
// empty drain: a later lost COMMIT acknowledgement may skip the post-commit handler.
// Another process can safely drain the same idempotent queue.
const retries = new Map<string, ReturnType<typeof setTimeout>>();
export function scheduleDashboardFileCleanup(directory: string) {
  if (retries.has(directory)) return;
  const timer = setTimeout(async () => {
    retries.delete(directory);
    try {
      await drainDashboardFileCleanup(directory);
    } catch {
      console.error('Dashboard file cleanup deferred; pending files are preserved');
    } finally {
      scheduleDashboardFileCleanup(directory);
    }
  }, 60_000);
  timer.unref();
  retries.set(directory, timer);
}

export async function cleanupDashboardFilesAfterCommit(directory: string, storagePaths: readonly string[]) {
  await enqueueDashboardFileCleanup(directory, storagePaths);
  // Unit/storage-only use has no database or installed backups. Production always verifies references.
  if (!process.env.DATABASE_URL) {
    if (process.env.NODE_ENV === 'production') throw new Error('Dashboard cleanup requires a database');
    await drainDashboardFileCleanup(directory, {
      withLock: withDashboardBackupLock, referencedPaths: async () => new Set<string>(),
    });
    return;
  }
  scheduleDashboardFileCleanup(directory);
  try {
    if (await drainDashboardFileCleanup(directory)) scheduleDashboardFileCleanup(directory);
  } catch (error) {
    scheduleDashboardFileCleanup(directory);
    throw error;
  }
}
