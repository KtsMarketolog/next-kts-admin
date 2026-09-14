import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, statfs, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  FIRMWARE_FILES, FirmwareError, MAX_FIRMWARE_STORAGE_BYTES,
  type FirmwareKind, type FirmwareOverview, type FirmwareVersion,
} from './firmwareContract';
export { FirmwareError, MAX_FIRMWARE_BYTES, MAX_VERSION_BYTES } from './firmwareContract';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KINDS: FirmwareKind[] = ['c23', 'ver'];
const META_LIMIT = 16 * 1024;
const MAX_GENERATIONS = 50;
type State = { revision: string; current: string; previous: string | null };
type Options = { quotaBytes?: number; fault?: (point: string) => void | Promise<void> };
type PublishInput = { c23: File; ver: File; expectedRevision: string; c23Sha256: string; verSha256: string };

function unavailable() { return new FirmwareError('STORAGE_INVALID', 503, 'Хранилище прошивок недоступно или повреждено. Публикация остановлена.'); }
function uncertainCommit() { return new FirmwareError('COMMIT_UNCERTAIN', 503, 'Пара уже переключена, но завершение операции не подтверждено. Обновите страницу и проверьте состояние; не повторяйте публикацию вслепую. Если блокировка осталась, нужна проверка администратором.'); }
function isMissing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function hash(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
function versionLabel(bytes: Buffer) {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new FirmwareError('INVALID_VERSION', 400, 'Файл .ver должен содержать текст UTF-8.'); }
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw new FirmwareError('INVALID_VERSION', 400, 'Некорректный текст файла .ver.');
  }
  return text.trim().split(/\r?\n/)[0].slice(0, 80);
}

// No environment overrides: the production tree is the existing shared firmware
// backup source. The factory lets tests use only their own mktemp directory.
export function createFirmwareStore(firmwareRoot: string, options: Options = {}) {
  const fault = async (point: string) => { await options.fault?.(point); };
  const quota = options.quotaBytes ?? MAX_FIRMWARE_STORAGE_BYTES;

  async function directories() {
    const root = await realpath(firmwareRoot);
    if (root === path.parse(root).root || !(await lstat(root)).isDirectory()) throw unavailable();
    return { root, store: path.join(root, '.firmware-store'), legacy: path.join(root, 'hse', 'gen_1') };
  }
  async function assertDirectory(directory: string) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
  }
  async function ensureDirectory(directory: string) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await assertDirectory(directory);
    await syncDirectory(path.dirname(directory));
  }
  async function syncDirectory(directory: string) {
    const handle = await open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function readRegular(filename: string, limit: number) {
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size <= 0 || before.size > limit) throw unavailable();
      const bytes = Buffer.alloc(before.size);
      let position = 0;
      while (position < bytes.length) {
        const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
        if (!bytesRead) throw unavailable();
        position += bytesRead;
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw unavailable();
      return { bytes, info: after };
    } finally { await handle.close(); }
  }
  async function json(filename: string) {
    try { return JSON.parse((await readRegular(filename, META_LIMIT)).bytes.toString('utf8')); }
    catch (error) { if (isMissing(error)) throw error; throw unavailable(); }
  }
  async function treeBytes(directory: string): Promise<number> {
    await assertDirectory(directory);
    let size = 0;
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 1000) throw unavailable();
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) size += await treeBytes(filename);
      else if (entry.isFile()) size += (await lstat(filename)).size;
      else throw unavailable();
    }
    return size;
  }
  async function state(store: string): Promise<State | null> {
    try { await assertDirectory(store); } catch (error) { if (isMissing(error)) return null; throw error; }
    let value;
    try { value = await json(path.join(store, 'state.json')); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    if (!value || !UUID.test(value.revision) || !UUID.test(value.current)
      || (value.previous !== null && !UUID.test(value.previous)) || value.current === value.previous) throw unavailable();
    return { revision: value.revision, current: value.current, previous: value.previous };
  }
  function descriptor(id: string, createdAt: string, buffers: Record<FirmwareKind, Buffer>): FirmwareVersion {
    return {
      id, createdAt, versionLabel: versionLabel(buffers.ver),
      files: Object.fromEntries(KINDS.map((kind) => [kind, {
        fileName: FIRMWARE_FILES[kind].fileName, url: FIRMWARE_FILES[kind].url,
        size: buffers[kind].length, sha256: hash(buffers[kind]),
      }])) as FirmwareVersion['files'],
    };
  }
  async function legacyVersion(legacy: string) {
    try {
      await assertDirectory(path.dirname(legacy));
      await assertDirectory(legacy);
      const c23 = await readRegular(path.join(legacy, FIRMWARE_FILES.c23.fileName), FIRMWARE_FILES.c23.maxBytes);
      const ver = await readRegular(path.join(legacy, FIRMWARE_FILES.ver.fileName), FIRMWARE_FILES.ver.maxBytes);
      const buffers = { c23: c23.bytes, ver: ver.bytes };
      const id = `legacy-${hash(Buffer.from(`${hash(buffers.c23)}:${hash(buffers.ver)}`))}`;
      return { buffers, version: descriptor(id, new Date(Math.max(c23.info.mtimeMs, ver.info.mtimeMs)).toISOString(), buffers) };
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async function generation(store: string, id: string): Promise<FirmwareVersion> {
    if (!UUID.test(id)) throw unavailable();
    await assertDirectory(path.join(store, 'releases'));
    const directory = path.join(store, 'releases', id);
    await assertDirectory(directory);
    const value = await json(path.join(directory, 'manifest.json'));
    if (!value || value.id !== id || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || !(value.versionLabel === null || typeof value.versionLabel === 'string' && value.versionLabel.length <= 80)) throw unavailable();
    for (const kind of KINDS) {
      const file = value.files?.[kind];
      if (!file || file.fileName !== FIRMWARE_FILES[kind].fileName || file.url !== FIRMWARE_FILES[kind].url
        || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > FIRMWARE_FILES[kind].maxBytes || !SHA256.test(file.sha256)) throw unavailable();
    }
    return value as FirmwareVersion;
  }
  // Hash the exact opened descriptor, not a path that may be switched later.
  async function verifiedHandle(filename: string, kind: FirmwareKind, expected?: { size: number; sha256: string }) {
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size <= 0 || before.size > FIRMWARE_FILES[kind].maxBytes
        || expected && before.size !== expected.size) throw unavailable();
      const digest = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!bytesRead) throw unavailable();
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const sha256 = digest.digest('hex');
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || expected && sha256 !== expected.sha256) throw unavailable();
      return { handle, size: before.size, sha256, modifiedAt: before.mtime };
    } catch (error) { await handle.close(); throw error; }
  }
  async function verifyGeneration(store: string, version: FirmwareVersion) {
    for (const kind of KINDS) {
      const { handle } = await verifiedHandle(path.join(store, 'releases', version.id, FIRMWARE_FILES[kind].fileName), kind, version.files[kind]);
      await handle.close();
    }
    return version;
  }
  async function overview(): Promise<FirmwareOverview> {
    const { store, legacy } = await directories();
    const active = await state(store);
    const storageBytes = await treeBytes(store).catch((error) => { if (isMissing(error)) return 0; throw error; });
    if (!active) {
      const old = await legacyVersion(legacy);
      return { revision: old?.version.id ?? 'empty', current: old?.version ?? null, previous: null, storageBytes };
    }
    const current = await verifyGeneration(store, await generation(store, active.current));
    const previous = active.previous ? await verifyGeneration(store, await generation(store, active.previous)) : null;
    return { revision: active.revision, current, previous, storageBytes };
  }
  async function locked<T>(callback: (locations: Awaited<ReturnType<typeof directories>>) => Promise<T>): Promise<T> {
    const locations = await directories();
    await ensureDirectory(locations.store);
    await ensureDirectory(path.join(locations.store, 'releases'));
    const incoming = path.join(locations.store, '.incoming');
    await ensureDirectory(incoming);
    const lock = path.join(incoming, 'publish.lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FirmwareError('BUSY', 409, 'Публикация прошивки уже выполняется. После аварии нужна проверка блокировки администратором.');
      throw error;
    }
    let completed = false;
    try {
      await writeVerified(path.join(lock, 'owner.json'), Buffer.from(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })));
      await fault('locked');
      const result = await callback(locations);
      completed = true;
      return result;
    } finally {
      try {
        await fault('before-unlock');
        await rm(lock, { recursive: true });
      } catch {
        // Never report an ordinary failed save after a successful publication.
        // On an earlier failure preserve that original error (including an
        // uncertain commit); a surviving lock fails closed on the next write.
        if (completed) throw uncertainCommit();
      }
    }
  }
  async function writeVerified(filename: string, bytes: Buffer) {
    const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const saved = await readRegular(filename, Math.max(META_LIMIT, bytes.length));
    if (saved.bytes.length !== bytes.length || hash(saved.bytes) !== hash(bytes)) throw unavailable();
  }
  async function saveGeneration(store: string, buffers: Record<FirmwareKind, Buffer>, label: string) {
    const id = randomUUID();
    const staging = path.join(store, '.incoming', id);
    const destination = path.join(store, 'releases', id);
    const version = descriptor(id, new Date().toISOString(), buffers);
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const kind of KINDS) {
        await fault(`${label}:before-${kind}`);
        await writeVerified(path.join(staging, FIRMWARE_FILES[kind].fileName), buffers[kind]);
        await fault(`${label}:after-${kind}`);
      }
      await writeVerified(path.join(staging, 'manifest.json'), Buffer.from(JSON.stringify(version)));
      await syncDirectory(staging);
      await fault(`${label}:before-seal`);
      await rename(staging, destination);
      await syncDirectory(path.join(store, 'releases'));
      return version;
    } finally {
      // Only this invocation's UUID staging directory, never a release/backup.
      await rm(staging, { recursive: true, force: true });
    }
  }
  async function switchState(store: string, next: State) {
    const temporary = path.join(store, '.incoming', `${randomUUID()}.state.tmp`);
    let committed = false;
    try {
      await writeVerified(temporary, Buffer.from(JSON.stringify(next)));
      await fault('before-switch');
      await rename(temporary, path.join(store, 'state.json'));
      committed = true;
      await fault('after-switch');
      await syncDirectory(store);
    } catch (error) {
      if (committed) throw uncertainCommit();
      throw error;
    } finally {
      try { await rm(temporary, { force: true }); }
      catch (error) { if (committed) throw uncertainCommit(); throw error; }
    }
  }
  async function sizeAfterSwitch(store: string, next: State) {
    // Determine the final size before the commit, excluding this request's lock
    // owner and replacing the old state size. No fallible read after commit.
    const oldStateSize = await readRegular(path.join(store, 'state.json'), META_LIMIT)
      .then(({ bytes }) => bytes.length).catch((error) => { if (isMissing(error)) return 0; throw error; });
    const owner = await readRegular(path.join(store, '.incoming', 'publish.lock', 'owner.json'), META_LIMIT);
    return await treeBytes(store) - oldStateSize - owner.bytes.length + Buffer.byteLength(JSON.stringify(next));
  }
  async function uploadBytes(input: PublishInput) {
    const buffers = {} as Record<FirmwareKind, Buffer>;
    for (const kind of KINDS) {
      const file = input[kind];
      if (!(file instanceof File) || file.size <= 0 || file.size > FIRMWARE_FILES[kind].maxBytes
        || !file.name.toLowerCase().endsWith(`.${kind}`)) throw new FirmwareError('INVALID_FILE', 400, `Выберите непустой допустимый файл .${kind}.`);
      const expected = input[kind === 'c23' ? 'c23Sha256' : 'verSha256'];
      if (typeof expected !== 'string' || !SHA256.test(expected)) throw new FirmwareError('INVALID_HASH', 400, 'Некорректная контрольная сумма файла.');
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length !== file.size || hash(bytes) !== expected) throw new FirmwareError('HASH_MISMATCH', 400, 'Контрольная сумма загруженного файла не совпадает.');
      buffers[kind] = bytes;
    }
    versionLabel(buffers.ver);
    return buffers;
  }
  async function publish(input: PublishInput): Promise<FirmwareOverview> {
    return locked(async ({ store, legacy }) => {
      const before = await overview();
      if (input.expectedRevision !== before.revision) throw new FirmwareError('CONFLICT', 409, 'Прошивка уже изменена. Обновите список перед публикацией.');
      const buffers = await uploadBytes(input);
      const preservesLegacy = Boolean(before.current && !UUID.test(before.current.id));
      const old = preservesLegacy ? await legacyVersion(legacy) : null;
      if (preservesLegacy && (!old || old.version.id !== before.revision)) throw new FirmwareError('CONFLICT', 409, 'Исходная прошивка изменилась. Обновите список.');
      const pendingBytes = buffers.c23.length + buffers.ver.length + (old ? old.buffers.c23.length + old.buffers.ver.length : 0) + 4 * META_LIMIT;
      if (before.storageBytes + pendingBytes > quota || (await readdir(path.join(store, 'releases'))).length + (old ? 2 : 1) > MAX_GENERATIONS) {
        throw new FirmwareError('QUOTA', 507, 'Хранилище версий прошивки заполнено. Старые версии не удалены; требуется архивирование администратором.');
      }
      const disk = await statfs(store, { bigint: true });
      if (disk.bavail * disk.bsize < BigInt(pendingBytes + 64 * 1024 * 1024)) throw new FirmwareError('DISK_SPACE', 507, 'Недостаточно свободного места для безопасной публикации.');
      const previous = old ? await saveGeneration(store, old.buffers, 'legacy') : before.current;
      const current = await saveGeneration(store, buffers, 'new');
      const next = { revision: randomUUID(), current: current.id, previous: previous?.id ?? null };
      const storageBytes = await sizeAfterSwitch(store, next);
      await switchState(store, next);
      // No fallible read after commit: return the already verified descriptors.
      return { revision: next.revision, current, previous, storageBytes };
    });
  }
  async function rollback(input: { expectedRevision: string; previousId: string }): Promise<FirmwareOverview> {
    return locked(async ({ store }) => {
      const before = await overview();
      if (input.expectedRevision !== before.revision || !before.previous || input.previousId !== before.previous.id || !before.current) {
        throw new FirmwareError('CONFLICT', 409, 'Предыдущая версия недоступна или состояние изменилось. Обновите список.');
      }
      const next = { revision: randomUUID(), current: before.previous.id, previous: before.current.id };
      const storageBytes = await sizeAfterSwitch(store, next);
      await switchState(store, next);
      // The pointer and previous version are one atomic state, including rollback.
      return { ...before, revision: next.revision, current: before.previous, previous: before.current, storageBytes };
    });
  }
  async function download(kind: FirmwareKind): Promise<{ handle: FileHandle; size: number; sha256: string; modifiedAt: Date; fileName: string }> {
    if (!KINDS.includes(kind)) throw unavailable();
    const { store, legacy } = await directories();
    const active = await state(store);
    let filename: string;
    let expected: FirmwareVersion['files'][FirmwareKind] | undefined;
    if (active) {
      const current = await generation(store, active.current);
      filename = path.join(store, 'releases', current.id, FIRMWARE_FILES[kind].fileName);
      expected = current.files[kind];
    } else {
      await assertDirectory(path.dirname(legacy));
      await assertDirectory(legacy);
      filename = path.join(legacy, FIRMWARE_FILES[kind].fileName);
    }
    await fault('download:before-open');
    return { ...await verifiedHandle(filename, kind, expected), fileName: FIRMWARE_FILES[kind].fileName };
  }
  return { overview, publish, rollback, download };
}

function productionStore() {
  return createFirmwareStore(path.join(process.cwd(), 'public', 'klimatika', 'prog', 'firmware', 'update'));
}
export const getFirmwareOverview = () => productionStore().overview();
export const publishFirmwarePair = (input: PublishInput) => productionStore().publish(input);
export const rollbackFirmwarePair = (input: { expectedRevision: string; previousId: string }) => productionStore().rollback(input);
export const openFirmwareDownload = (kind: FirmwareKind) => productionStore().download(kind);
