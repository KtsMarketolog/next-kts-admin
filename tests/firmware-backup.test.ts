import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { FIRMWARE_FILES, type FirmwareKind } from '../src/shared/lib/firmwareContract';
import { createFirmwareStore } from '../src/shared/lib/firmwareStorage';

type CapturedFile = { source: string; path: string; size: number; sha256: string };
type CopyTree = (source: string, destination: string, label: string, root: string,
  reserve: number, files: CapturedFile[]) => Promise<void>;
type Store = ReturnType<typeof createFirmwareStore>;
type Pair = Record<FirmwareKind, string>;
const kinds: FirmwareKind[] = ['c23', 'ver'];
const legacy: Pair = { c23: 'SYNTHETIC-BACKUP-FIRMWARE-0', ver: '0.0.0\r\n' };
const first: Pair = { c23: 'SYNTHETIC-BACKUP-FIRMWARE-1', ver: '1.0.0\r\n' };
const second: Pair = { c23: 'SYNTHETIC-BACKUP-FIRMWARE-2', ver: '2.0.0\r\n' };
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

// Expose the actual private helper only inside this test VM. Do not call capture,
// read backup configuration, load a database module or modify the production file.
function actualCopyTree(): CopyTree {
  const filename = fileURLToPath(new URL('../ops/backup/capture.cjs', import.meta.url));
  const code = readFileSync(filename, 'utf8');
  const require = createRequire(filename);
  const testModule = { exports: {} as { copyTree: CopyTree } };
  runInNewContext(`${code}\nmodule.exports.copyTree = copyTree;`, {
    module: testModule,
    Buffer,
    require: (name: string) => {
      assert.ok(['node:fs/promises', 'node:fs', 'node:path', 'node:crypto'].includes(name), `Unexpected dependency: ${name}`);
      return require(name);
    },
  }, { filename, timeout: 1000 });
  assert.equal(typeof testModule.exports.copyTree, 'function');
  return testModule.exports.copyTree;
}

const copyTree = actualCopyTree();

async function fixture(t: TestContext) {
  // Resolve macOS /var aliases: the real backup helper intentionally rejects
  // source paths that traverse symlink directories.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-firmware-backup-test-')));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('kts-firmware-backup-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'synthetic-firmware');
  const backupRoot = path.join(root, 'synthetic-backup');
  const copied = path.join(backupRoot, 'firmware');
  await mkdir(path.join(source, 'hse', 'gen_1'), { recursive: true });
  await mkdir(backupRoot);
  for (const kind of kinds) {
    await writeFile(path.join(source, 'hse', 'gen_1', FIRMWARE_FILES[kind].fileName), legacy[kind]);
  }
  return { source, backupRoot, copied, store: createFirmwareStore(source) };
}

async function publish(store: Store, pair: Pair) {
  return store.publish({
    expectedRevision: (await store.overview()).revision,
    c23: new File([pair.c23], 'synthetic.c23'),
    ver: new File([pair.ver], 'synthetic.ver'),
    c23Sha256: sha256(pair.c23), verSha256: sha256(pair.ver),
  });
}

async function assertPair(store: Store, expected: Pair) {
  for (const kind of kinds) {
    const download = await store.download(kind);
    try {
      const bytes = await download.handle.readFile();
      assert.equal(bytes.toString('utf8'), expected[kind]);
      assert.equal(download.size, bytes.length);
      assert.equal(download.sha256, sha256(bytes));
    } finally { await download.handle.close(); }
  }
}

async function assertCapturedFiles(source: string, copied: string, files: CapturedFile[], expectedPaths: string[]) {
  assert.deepEqual(files.map((file) => file.path).sort(), expectedPaths.sort());
  for (const file of files) {
    assert.equal(file.source, 'firmware');
    assert.ok(!file.path.split('/').includes('.incoming'));
    const bytes = await readFile(path.join(copied, file.path));
    assert.deepEqual(bytes, await readFile(path.join(source, file.path)), file.path);
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, sha256(bytes));
    const info = await lstat(path.join(copied, file.path));
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.mode & 0o777, 0o600, 'backup copies stay private regular files');
  }
}

test('actual backup copyTree preserves the legacy firmware fallback before any publication', async (t) => {
  const f = await fixture(t);
  const before = await f.store.overview();
  const files: CapturedFile[] = [];
  await copyTree(f.source, f.copied, 'firmware', f.backupRoot, 0, files);
  await assertCapturedFiles(f.source, f.copied, files, kinds.map((kind) => `hse/gen_1/${FIRMWARE_FILES[kind].fileName}`));
  const restored = createFirmwareStore(f.copied);
  const restoredOverview = await restored.overview();
  // copyTree preserves bytes, not source mtimes. The legacy display date is
  // derived from those mtimes; its content-based identity must remain stable.
  assert.equal(restoredOverview.revision, before.revision);
  assert.equal(restoredOverview.current?.id, before.current?.id);
  assert.equal(restoredOverview.current?.versionLabel, before.current?.versionLabel);
  assert.deepEqual(restoredOverview.current?.files, before.current?.files);
  assert.equal(restoredOverview.previous, null);
  assert.equal(restoredOverview.storageBytes, 0);
  await assertPair(restored, legacy);
  assert.deepEqual(await readdir(f.copied), ['hse'], 'restored legacy reads must not create a store');
  assert.deepEqual(await f.store.overview(), before, 'copy must not alter the source');
});

test('actual backup copyTree retains firmware state/history, excludes staging/lock, and permits isolated rollback', async (t) => {
  const f = await fixture(t);
  const a = await publish(f.store, first);
  const b = await publish(f.store, second);
  assert.ok(a.previous && a.current && b.previous && b.current);
  const storage = '.firmware-store';
  const statePath = path.join(storage, 'state.json');
  const sourceState = await readFile(path.join(f.source, statePath));
  const sourceReleases = await readdir(path.join(f.source, storage, 'releases'));
  assert.equal(sourceReleases.length, 3, 'fixture has legacy, previous and current generations');

  // Simulate leftover upload bytes and a crash lock. Neither may enter backup
  // or prevent a restored copy from acquiring its own fresh publication lock.
  const incoming = path.join(f.source, storage, '.incoming');
  await mkdir(path.join(incoming, 'unfinished-upload'));
  await writeFile(path.join(incoming, 'unfinished-upload', 'hse_gen_1.c23'), 'SYNTHETIC-INCOMPLETE');
  await mkdir(path.join(incoming, 'publish.lock'));
  await writeFile(path.join(incoming, 'publish.lock', 'owner.json'), '{"pid":12345,"createdAt":"2026-01-01T00:00:00.000Z"}');
  await writeFile(path.join(incoming, 'pending.state.tmp'), 'SYNTHETIC-UNCOMMITTED');

  const files: CapturedFile[] = [];
  await copyTree(f.source, f.copied, 'firmware', f.backupRoot, 0, files);
  const expectedPaths = [
    statePath,
    ...kinds.map((kind) => `hse/gen_1/${FIRMWARE_FILES[kind].fileName}`),
    ...sourceReleases.flatMap((id) => [
      `${storage}/releases/${id}/manifest.json`,
      ...kinds.map((kind) => `${storage}/releases/${id}/${FIRMWARE_FILES[kind].fileName}`),
    ]),
  ];
  await assertCapturedFiles(f.source, f.copied, files, expectedPaths);
  await assert.rejects(lstat(path.join(f.copied, storage, '.incoming')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(f.copied, statePath)), sourceState);
  assert.deepEqual(await readdir(incoming), ['pending.state.tmp', 'publish.lock', 'unfinished-upload'], 'source staging stays untouched');

  const restored = createFirmwareStore(f.copied);
  const overview = await restored.overview();
  assert.equal(overview.revision, b.revision);
  assert.deepEqual(overview.current, b.current);
  assert.deepEqual(overview.previous, b.previous);
  await assertPair(restored, second);
  for (const kind of kinds) {
    assert.equal(await readFile(path.join(f.copied, 'hse', 'gen_1', FIRMWARE_FILES[kind].fileName), 'utf8'), legacy[kind]);
    assert.equal(await readFile(path.join(f.copied, storage, 'releases', a.previous.id, FIRMWARE_FILES[kind].fileName), 'utf8'), legacy[kind]);
  }

  const rolledBack = await restored.rollback({ expectedRevision: overview.revision, previousId: overview.previous!.id });
  assert.equal(rolledBack.current?.id, a.current.id);
  assert.equal(rolledBack.previous?.id, b.current.id);
  assert.notEqual(rolledBack.revision, b.revision);
  await assertPair(restored, first);
  assert.deepEqual((await restored.overview()).current, a.current);
  assert.deepEqual(await readdir(path.join(f.copied, storage, 'releases')), sourceReleases, 'rollback retains every copied generation');
  assert.deepEqual(await readdir(path.join(f.copied, storage, '.incoming')), [], 'restored rollback cleans its own newly created lock');
  assert.deepEqual(await readFile(path.join(f.source, statePath)), sourceState, 'rollback is isolated from the source');
  await assertPair(f.store, second);
});
