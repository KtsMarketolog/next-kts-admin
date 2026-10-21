import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PriceBuildArtifact, PriceBuildJob } from '../db/priceBuildRepo';
import { PriceBuildError } from './errors';

export const PRICE_BUILD_CACHE_TTL_MS = 5 * 60_000;
export const PRICE_BUILD_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const PRICE_BUILD_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const ARTIFACT_NAME = /^[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/;
const OWNED_NAME = /^[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin(?:\.tmp)?$/;

export function priceBuildCacheDirectory() {
  const override = process.env.KTS_PRICE_BUILD_CACHE_DIR;
  if (override) {
    if (process.env.NODE_ENV !== 'test' || process.env.KTS_PRICE_BUILD_TEST !== '1'
      || !/^\/(?:private\/)?tmp\/kts-(?:price-build|public-cache|wholesale)-postgres\.[A-Za-z0-9]+\/cache$/.test(override)) {
      throw new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
    }
    return override;
  }
  if (process.env.NODE_ENV === 'test') throw new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
  return path.join(process.cwd(), 'runtime-data', 'private-price-build-cache');
}

async function ensureCacheDirectory() {
  const directory = priceBuildCacheDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  // The parent runtime-data symlink is deployed/shared intentionally, not this leaf.
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
  await chmod(directory, 0o700);
  return directory;
}

function interrupted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new PriceBuildError('PRICE_BUILD_ABORTED');
}

/** Yield during hashing too; the cache must not reintroduce a large synchronous CPU stage. */
async function checksum(bytes: Uint8Array, signal: AbortSignal) {
  const hash = createHash('sha256');
  for (let at = 0; at < bytes.byteLength; at += 256 * 1024) {
    interrupted(signal);
    hash.update(bytes.subarray(at, Math.min(at + 256 * 1024, bytes.byteLength)));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return hash.digest('hex');
}

export async function readPriceBuildArtifact(job: PriceBuildJob, signal: AbortSignal): Promise<Uint8Array | null> {
  if (!job.result_file || !ARTIFACT_NAME.test(job.result_file) || !job.result_file.startsWith(`${job.key_hash}-`)
    || !job.result_bytes || job.result_bytes > PRICE_BUILD_ARTIFACT_MAX_BYTES || !job.result_sha256) return null;
  let handle;
  try {
    const directory = await ensureCacheDirectory();
    handle = await open(path.join(directory, job.result_file), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== job.result_bytes) return null;
    const bytes = Buffer.allocUnsafe(job.result_bytes);
    for (let position = 0; position < bytes.byteLength;) {
      interrupted(signal);
      const read = await handle.read(bytes, position, Math.min(256 * 1024, bytes.byteLength - position), position);
      if (!read.bytesRead) return null;
      position += read.bytesRead;
    }
    return await checksum(bytes, signal) === job.result_sha256 ? bytes : null;
  } catch (error) {
    interrupted(signal);
    if (error && typeof error === 'object' && 'code' in error && ['ENOENT','ELOOP'].includes(String(error.code))) return null;
    throw error;
  } finally { await handle?.close(); }
}

export async function removePriceBuildArtifact(file: string) {
  if (!ARTIFACT_NAME.test(file)) return;
  await unlink(path.join(priceBuildCacheDirectory(), file)).catch(error => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

/** Called only under the global active session lock; never follows symlinks or non-cache names. */
async function trimCache(directory: string, protect: string) {
  const files: { name: string; bytes: number; modified: number }[] = [];
  const entries = await opendir(directory);
  let scanned = 0;
  for await (const entry of entries) {
    if (++scanned > 4096) throw new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
    if (!OWNED_NAME.test(entry.name) || !entry.isFile()) continue;
    const stat = await lstat(path.join(directory, entry.name)).catch(() => null);
    if (stat?.isFile()) files.push({ name: entry.name, bytes: stat.size, modified: stat.mtimeMs });
  }
  files.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
  let total = files.reduce((sum, file) => sum + file.bytes, 0);
  let count = files.length;
  for (const file of files) {
    if (file.name === protect) continue;
    const stale = Date.now() - file.modified > PRICE_BUILD_CACHE_TTL_MS + 60_000;
    if (!stale && total <= PRICE_BUILD_CACHE_MAX_BYTES && count <= 64) continue;
    await unlink(path.join(directory, file.name)).catch(error => { if (error?.code !== 'ENOENT') throw error; });
    total -= file.bytes; count -= 1;
  }
}

/** Unique immutable attempt filename + atomic rename. The DB pointer is published afterwards by CAS. */
export async function writePriceBuildArtifact(keyHash: string, ownerId: string, encoded: Uint8Array, signal: AbortSignal): Promise<PriceBuildArtifact | null> {
  if (!encoded.byteLength || encoded.byteLength > PRICE_BUILD_ARTIFACT_MAX_BYTES) return null;
  const file = `${keyHash}-${ownerId}.bin`;
  if (!ARTIFACT_NAME.test(file)) throw new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
  const directory = await ensureCacheDirectory();
  const temporary = path.join(directory, `${file}.tmp`);
  const destination = path.join(directory, file);
  let handle;
  let renamed = false;
  try {
    interrupted(signal);
    const sha256 = await checksum(encoded, signal);
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(encoded, { signal });
    await handle.close(); handle = undefined;
    interrupted(signal);
    await rename(temporary, destination); renamed = true;
    await trimCache(directory, file);
    interrupted(signal);
    return { file, bytes: encoded.byteLength, sha256 };
  } catch (error) {
    if (renamed) await unlink(destination).catch(() => {});
    throw error;
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => {});
  }
}
