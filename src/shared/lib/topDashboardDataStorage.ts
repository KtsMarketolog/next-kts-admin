import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const STORAGE_PATH_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{64}-[0-9a-f-]{36}\.bin$/u;

export class TopDashboardDataStreamError extends Error {
  readonly code: 'EMPTY' | 'TOO_LARGE' | 'UNAVAILABLE';

  constructor(code: TopDashboardDataStreamError['code'], message: string) {
    super(message);
    this.name = 'TopDashboardDataStreamError';
    this.code = code;
  }
}

function storageDirectory() {
  const configured = process.env.TOP_DASHBOARD_DATA_DIR?.trim();
  const directory = path.resolve(
    configured || path.join(process.cwd(), '.runtime-data', 'top-dashboard'),
  );
  if (directory === path.parse(directory).root) {
    throw new TopDashboardDataStreamError('UNAVAILABLE', 'Unsafe TOP data directory');
  }
  return directory;
}

function absoluteStoragePath(storagePath: string) {
  if (!STORAGE_PATH_PATTERN.test(storagePath)) {
    throw new TopDashboardDataStreamError('UNAVAILABLE', 'Invalid TOP data storage path');
  }
  return path.join(storageDirectory(), storagePath);
}

export async function ensureTopDashboardDataStorage() {
  const directory = storageDirectory();
  await mkdir(path.join(directory, '.incoming'), { recursive: true, mode: 0o700 });
  await access(directory, constants.R_OK | constants.W_OK);
  return directory;
}

export async function cleanupStaleTopDashboardIncomingFiles(maxAgeMs = 6 * 60 * 60 * 1000) {
  const directory = await ensureTopDashboardDataStorage();
  const incomingDirectory = path.join(directory, '.incoming');
  const cutoff = Date.now() - maxAgeMs;
  const entries = await readdir(incomingDirectory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f-]{36}\.tmp$/u.test(entry.name)) continue;
    const temporaryPath = path.join(incomingDirectory, entry.name);
    const metadata = await lstat(temporaryPath).catch(() => null);
    if (metadata?.isFile() && metadata.mtimeMs < cutoff) {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

export type PendingTopDashboardDataFile = {
  fileSize: number;
  firstBytes: Buffer;
  sha256: string;
  temporaryPath: string;
  commit: () => Promise<string>;
  discard: () => Promise<void>;
  preserve: () => void;
};

export async function writeTopDashboardRequestToPendingFile(
  request: Request,
  maxBytes: number,
): Promise<PendingTopDashboardDataFile> {
  if (!request.body) {
    throw new TopDashboardDataStreamError('EMPTY', 'Upload body is empty');
  }

  const directory = await ensureTopDashboardDataStorage();
  const temporaryPath = path.join(directory, '.incoming', `${randomUUID()}.tmp`);
  const hash = createHash('sha256');
  let fileSize = 0;
  let firstBytes = Buffer.alloc(0);

  const meter = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fileSize += bytes.length;
      if (fileSize > maxBytes) {
        callback(new TopDashboardDataStreamError('TOO_LARGE', 'Upload is too large'));
        return;
      }
      if (firstBytes.length < 2) {
        firstBytes = Buffer.concat([firstBytes, bytes.subarray(0, 2 - firstBytes.length)]);
      }
      hash.update(bytes);
      callback(null, bytes);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(request.body as import('node:stream/web').ReadableStream),
      meter,
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }

  if (fileSize <= 0) {
    await unlink(temporaryPath).catch(() => {});
    throw new TopDashboardDataStreamError('EMPTY', 'Upload body is empty');
  }

  const sha256 = hash.digest('hex');
  let ownedPath: string | null = temporaryPath;
  let committedStoragePath: string | null = null;

  return {
    fileSize,
    firstBytes,
    sha256,
    temporaryPath,
    async commit() {
      if (committedStoragePath) return committedStoragePath;
      const shard = sha256.slice(0, 2);
      await mkdir(path.join(directory, shard), { recursive: true, mode: 0o700 });
      committedStoragePath = `${shard}/${sha256}-${randomUUID()}.bin`;
      const finalPath = absoluteStoragePath(committedStoragePath);
      await rename(temporaryPath, finalPath);
      ownedPath = finalPath;
      return committedStoragePath;
    },
    async discard() {
      if (!ownedPath) return;
      const target = ownedPath;
      ownedPath = null;
      await unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
    preserve() {
      ownedPath = null;
    },
  };
}

export async function openTopDashboardDataFile(
  storagePath: string,
  expectedSize: number,
) {
  const absolutePath = absoluteStoragePath(storagePath);
  const file = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== expectedSize) {
      throw new TopDashboardDataStreamError('UNAVAILABLE', 'Stored TOP data file is invalid');
    }
    return file.createReadStream({ autoClose: true });
  } catch (error) {
    await file.close().catch(() => {});
    throw error;
  }
}

export async function deleteTopDashboardDataFiles(storagePaths: readonly string[]) {
  const uniquePaths = [...new Set(storagePaths.filter((value) => STORAGE_PATH_PATTERN.test(value)))];
  await Promise.all(uniquePaths.map(async (storagePath) => {
    await unlink(absoluteStoragePath(storagePath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }));
}
