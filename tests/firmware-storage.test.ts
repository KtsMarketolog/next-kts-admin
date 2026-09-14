import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { FIRMWARE_FILES, FirmwareError } from '../src/shared/lib/firmwareContract';
import { createFirmwareStore } from '../src/shared/lib/firmwareStorage';

type Store = ReturnType<typeof createFirmwareStore>;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const original = { c23: 'SYNTHETIC-FIRMWARE-0', ver: '0.0.0\r\n' };
const first = { c23: 'SYNTHETIC-FIRMWARE-1', ver: '1.0.0\n' };
const second = { c23: 'SYNTHETIC-FIRMWARE-2', ver: '2.0.0\n' };
const errorCode = (code: string) => (error: unknown) => error instanceof FirmwareError && error.code === code;

async function fixture(t: TestContext, legacy = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kts-firmware-test-'));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('kts-firmware-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const legacyPath = path.join(root, 'hse', 'gen_1');
  if (legacy) {
    await mkdir(legacyPath, { recursive: true });
    for (const kind of ['c23', 'ver'] as const) await writeFile(path.join(legacyPath, FIRMWARE_FILES[kind].fileName), original[kind]);
  }
  return { root, legacyPath, storage: path.join(root, '.firmware-store'), store: createFirmwareStore(root) };
}

async function input(store: Store, buffers = first) {
  return {
    expectedRevision: (await store.overview()).revision,
    c23: new File([buffers.c23], 'synthetic.c23'), ver: new File([buffers.ver], 'synthetic.ver'),
    c23Sha256: sha(buffers.c23), verSha256: sha(buffers.ver),
  };
}

async function contents(store: Store, kind: 'c23' | 'ver') {
  const download = await store.download(kind);
  try { return await download.handle.readFile('utf8'); } finally { await download.handle.close(); }
}

async function assertPair(store: Store, buffers: typeof first) {
  assert.equal(await contents(store, 'c23'), buffers.c23);
  assert.equal(await contents(store, 'ver'), buffers.ver);
}

async function assertIncomingEmpty(storage: string) {
  assert.deepEqual(await readdir(path.join(storage, '.incoming')), [], 'no abandoned staging, temporary state or publication lock');
}

test('firmware legacy pair is read without mutation, and first publication retains a private recoverable copy', async (t) => {
  const { root, store, storage, legacyPath } = await fixture(t);
  const before = await store.overview();
  assert.match(before.revision, /^legacy-[a-f0-9]{64}$/);
  assert.equal(before.current?.versionLabel, '0.0.0');
  assert.equal(before.previous, null);
  assert.equal(before.storageBytes, 0);
  await assertPair(store, original);
  assert.deepEqual(await readdir(root), ['hse'], 'read-only legacy access must not create a storage tree');
  const result = await store.publish(await input(store));
  assert.equal(result.storageBytes, (await store.overview()).storageBytes, 'publication response reports actual stored bytes, without reservation or transient lock overhead');
  assert.equal(result.current?.versionLabel, '1.0.0');
  assert.equal(result.previous?.versionLabel, '0.0.0');
  assert.notEqual(result.previous?.id, before.current?.id, 'legacy backup must become an immutable private generation');
  assert.equal((await readdir(path.join(storage, 'releases'))).length, 2);
  for (const kind of ['c23', 'ver'] as const) {
    assert.equal(await readFile(path.join(legacyPath, FIRMWARE_FILES[kind].fileName), 'utf8'), original[kind]);
    const file = path.join(storage, 'releases', result.previous!.id, FIRMWARE_FILES[kind].fileName);
    assert.equal(await readFile(file, 'utf8'), original[kind]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  await assertPair(store, first);
  await assertIncomingEmpty(storage);
});

test('firmware publishes an initial complete pair into an empty root', async (t) => {
  const { store, storage } = await fixture(t, false);
  assert.equal((await store.overview()).revision, 'empty');
  const result = await store.publish(await input(store));
  assert.equal(result.storageBytes, (await store.overview()).storageBytes);
  assert.equal(result.previous, null);
  assert.equal((await readdir(path.join(storage, 'releases'))).length, 1);
  await assertPair(store, first);
  await assertIncomingEmpty(storage);
});

test('firmware legacy version disappearing during upload rejects publication instead of creating a dangling legacy previous pointer', async (t) => {
  const { store, storage, legacyPath } = await fixture(t);
  const request = await input(store);
  const c23Path = path.join(legacyPath, FIRMWARE_FILES.c23.fileName);
  const verPath = path.join(legacyPath, FIRMWARE_FILES.ver.fileName);
  const originalC23 = await readFile(c23Path);
  const originalC23Info = await stat(c23Path);
  let reads = 0;
  class SyntheticConcurrentUpload extends File {
    override async arrayBuffer(): Promise<ArrayBuffer> {
      reads++;
      // Simulate an old writer touching only this fixture while a new request
      // awaits its incoming bytes, after the initial legacy overview succeeded.
      await rm(verPath);
      return super.arrayBuffer();
    }
  }
  request.c23 = new SyntheticConcurrentUpload([first.c23], 'synthetic.c23');
  await assert.rejects(store.publish(request), errorCode('CONFLICT'));
  assert.equal(reads, 1, 'the race must occur during upload consumption, not before the initial revision check');
  await assert.rejects(readFile(path.join(storage, 'state.json')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.join(storage, 'releases')), [], 'neither a new generation nor a dangling legacy reference may be committed');
  assert.deepEqual(await readFile(c23Path), originalC23);
  assert.equal((await stat(c23Path)).mtimeMs, originalC23Info.mtimeMs, 'the existing firmware payload was not rewritten');
  await assertIncomingEmpty(storage);
});

test('firmware pair publication and rollback change one revision, preserve all generations, and reject ABA stale writes', async (t) => {
  const { store, storage } = await fixture(t);
  const a = await store.publish(await input(store));
  const stale = await input(store);
  const b = await store.publish(await input(store, second));
  assert.equal(b.storageBytes, (await store.overview()).storageBytes);
  assert.equal(b.previous?.id, a.current?.id);
  await assertPair(store, second);
  const rollback = await store.rollback({ expectedRevision: b.revision, previousId: a.current!.id });
  assert.equal(rollback.storageBytes, (await store.overview()).storageBytes, 'rollback response excludes its released lock and reflects unchanged generation storage');
  assert.equal(rollback.current?.id, a.current?.id);
  assert.equal(rollback.previous?.id, b.current?.id);
  assert.notEqual(rollback.revision, a.revision, 'A → B → A must not revive an old expected revision');
  assert.notEqual(rollback.revision, b.revision);
  await assertPair(store, first);
  await assert.rejects(store.publish(stale), errorCode('CONFLICT'));
  await assert.rejects(store.rollback({ expectedRevision: b.revision, previousId: a.current!.id }), errorCode('CONFLICT'));
  await assert.rejects(store.rollback({ expectedRevision: rollback.revision, previousId: a.current!.id }), errorCode('CONFLICT'));
  assert.equal((await store.overview()).revision, rollback.revision);
  assert.equal((await readdir(path.join(storage, 'releases'))).length, 3, 'successful rollback and conflicts must not delete any previous firmware');
  await assertIncomingEmpty(storage);
});

for (const field of ['c23Sha256', 'verSha256'] as const) {
  test(`firmware rejects a mismatching ${field} without switching or persisting a generation`, async (t) => {
    const { store, storage } = await fixture(t);
    const request = await input(store);
    request[field] = '0'.repeat(64);
    await assert.rejects(store.publish(request), errorCode('HASH_MISMATCH'));
    assert.equal((await store.overview()).revision, request.expectedRevision);
    assert.deepEqual(await readdir(path.join(storage, 'releases')), []);
    await assertPair(store, original);
    await assertIncomingEmpty(storage);
  });
}

test('firmware rejects malformed hashes, extensions, empty payloads and invalid UTF-8/control-only version data', async (t) => {
  const { store, storage } = await fixture(t);
  const originalInput = await input(store);
  for (const c23Sha256 of ['', 'x'.repeat(64), 'a'.repeat(63), 'A'.repeat(64)]) {
    await assert.rejects(store.publish({ ...originalInput, c23Sha256 }), errorCode('INVALID_HASH'));
  }
  for (const c23 of [new File([], 'empty.c23'), new File(['x'], 'wrong.txt')]) {
    await assert.rejects(store.publish({ ...originalInput, c23, c23Sha256: sha(await c23.text()) }), errorCode('INVALID_FILE'));
  }
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('\0version'), Buffer.from(' \r\n')]) {
    await assert.rejects(store.publish({ ...originalInput, ver: new File([bytes], 'synthetic.ver'), verSha256: sha(bytes) }), errorCode('INVALID_VERSION'));
  }
  assert.equal((await store.overview()).revision, originalInput.expectedRevision);
  assert.deepEqual(await readdir(path.join(storage, 'releases')), []);
  await assertIncomingEmpty(storage);
});

for (const point of ['locked', 'new:before-c23', 'new:after-c23', 'new:before-ver', 'new:after-ver', 'new:before-seal', 'before-switch']) {
  test(`firmware injected ${point} failure preserves the old pair, removes own temporary files and releases the shared lock`, async (t) => {
    const { root, store, storage } = await fixture(t);
    const before = await store.publish(await input(store));
    const request = await input(store, second);
    const failed = createFirmwareStore(root, { fault(current) { if (current === point) throw new Error(`synthetic failure: ${point}`); } });
    await assert.rejects(failed.publish(request), /synthetic failure/);
    assert.equal((await store.overview()).revision, before.revision);
    await assertPair(store, first);
    await assertIncomingEmpty(storage);
    const next = await store.publish(request);
    assert.notEqual(next.revision, before.revision, 'independent factory instance can publish after lock owner failure');
    await assertPair(store, second);
    await assertIncomingEmpty(storage);
  });
}

test('firmware failure while backing up the legacy .ver leaves public files and the current legacy pair intact', async (t) => {
  const { root, store, storage, legacyPath } = await fixture(t);
  const request = await input(store);
  const failed = createFirmwareStore(root, { fault(point) { if (point === 'legacy:before-ver') throw new Error('synthetic legacy write failure'); } });
  await assert.rejects(failed.publish(request), /synthetic legacy write failure/);
  assert.equal((await store.overview()).revision, request.expectedRevision);
  for (const kind of ['c23', 'ver'] as const) assert.equal(await readFile(path.join(legacyPath, FIRMWARE_FILES[kind].fileName), 'utf8'), original[kind]);
  await assertIncomingEmpty(storage);
  await store.publish(request);
  await assertPair(store, first);
});

test('firmware crash before the first state switch retains the legacy pair and both sealed copies without publishing either partially', async (t) => {
  const { root, store, storage, legacyPath } = await fixture(t);
  const before = await store.overview();
  const request = await input(store);
  const failed = createFirmwareStore(root, { fault(point) { if (point === 'before-switch') throw new Error('synthetic first switch failure'); } });
  await assert.rejects(failed.publish(request), /synthetic first switch failure/);
  assert.equal((await store.overview()).revision, before.revision);
  await assertPair(store, original);
  await assert.rejects(readFile(path.join(storage, 'state.json')), { code: 'ENOENT' });
  const sealed = await readdir(path.join(storage, 'releases'));
  assert.equal(sealed.length, 2, 'finished old and new copies are retained for diagnosis instead of deleted');
  const labels: string[] = [];
  for (const id of sealed) {
    const directory = path.join(storage, 'releases', id);
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    labels.push(manifest.versionLabel);
    for (const kind of ['c23', 'ver'] as const) {
      const bytes = await readFile(path.join(directory, FIRMWARE_FILES[kind].fileName));
      assert.equal(sha(bytes), manifest.files[kind].sha256);
      assert.equal(bytes.length, manifest.files[kind].size);
      assert.equal(await readFile(path.join(legacyPath, FIRMWARE_FILES[kind].fileName), 'utf8'), original[kind]);
    }
  }
  assert.deepEqual(labels.sort(), ['0.0.0', '1.0.0']);
  await assertIncomingEmpty(storage);
  await store.publish(request);
  await assertPair(store, first);
  assert.equal((await readdir(path.join(storage, 'releases'))).length, 4, 'retry must not prune prior sealed recovery artifacts');
});

test('firmware post-switch failure reports COMMIT_UNCERTAIN, exposes a complete new pair, and does not permit a blind stale retry', async (t) => {
  const { root, store, storage } = await fixture(t);
  const before = await store.publish(await input(store));
  const request = await input(store, second);
  const failed = createFirmwareStore(root, { fault(point) { if (point === 'after-switch') throw new Error('synthetic directory fsync failure'); } });
  await assert.rejects(failed.publish(request), errorCode('COMMIT_UNCERTAIN'));
  const after = await store.overview();
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.previous?.id, before.current?.id);
  const sealed = await readdir(path.join(storage, 'releases'));
  assert.equal(sealed.length, 3, 'uncertain confirmation must retain the legacy, previous, and newly active copy');
  assert.ok(sealed.includes(after.current!.id));
  assert.ok(sealed.includes(after.previous!.id));
  assert.ok(sealed.includes(before.previous!.id));
  await assertPair(store, second);
  await assert.rejects(store.publish(request), errorCode('CONFLICT'));
  await assertIncomingEmpty(storage);
});

for (const operation of ['publish', 'rollback'] as const) {
  test(`firmware ${operation} unlock failure reports COMMIT_UNCERTAIN, preserves the committed pair and all generations, and blocks later writers`, async (t) => {
    const { root, store, storage } = await fixture(t);
    const before = await store.publish(await input(store));
    const generationsBefore = await readdir(path.join(storage, 'releases'));
    const writer = createFirmwareStore(root, { fault(point) { if (point === 'before-unlock') throw new Error('synthetic lock removal failure'); } });
    const mutation = operation === 'publish'
      ? writer.publish(await input(store, second))
      : writer.rollback({ expectedRevision: before.revision, previousId: before.previous!.id });
    await assert.rejects(mutation, errorCode('COMMIT_UNCERTAIN'));
    const after = await store.overview();
    assert.notEqual(after.revision, before.revision, 'the operation has already switched state before failing to unlock');
    assert.equal(after.previous?.id, before.current?.id);
    await assertPair(store, operation === 'publish' ? second : original);
    if (operation === 'rollback') assert.equal(after.current?.id, before.previous?.id);

    const generationsAfter = await readdir(path.join(storage, 'releases'));
    assert.equal(generationsAfter.length, generationsBefore.length + (operation === 'publish' ? 1 : 0));
    for (const id of generationsBefore) assert.ok(generationsAfter.includes(id), `pre-existing generation ${id} retained`);
    for (const id of generationsAfter) {
      const directory = path.join(storage, 'releases', id);
      const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
      for (const kind of ['c23', 'ver'] as const) {
        const bytes = await readFile(path.join(directory, FIRMWARE_FILES[kind].fileName));
        assert.equal(sha(bytes), manifest.files[kind].sha256);
        assert.equal(bytes.length, manifest.files[kind].size);
      }
    }
    assert.deepEqual(await readdir(path.join(storage, '.incoming')), ['publish.lock']);
    const ownerFile = path.join(storage, '.incoming', 'publish.lock', 'owner.json');
    const owner = await readFile(ownerFile);
    await assert.rejects(store.publish(await input(store)), errorCode('BUSY'));
    await assert.rejects(store.rollback({ expectedRevision: after.revision, previousId: after.previous!.id }), errorCode('BUSY'));
    assert.deepEqual(await readFile(ownerFile), owner, 'competing requests must retain the failed owner lock for explicit recovery');
    assert.equal((await store.overview()).revision, after.revision);
  });
}

test('firmware failure before commit keeps its original cause even if releasing the lock also fails', async (t) => {
  const { root, store, storage } = await fixture(t);
  const before = await store.publish(await input(store));
  const originalFailure = new Error('synthetic second file write failure');
  const writer = createFirmwareStore(root, { fault(point) {
    if (point === 'new:before-ver') throw originalFailure;
    if (point === 'before-unlock') throw new Error('synthetic secondary lock removal failure');
  } });
  await assert.rejects(writer.publish(await input(store, second)), (error) => error === originalFailure);
  assert.equal((await store.overview()).revision, before.revision);
  await assertPair(store, first);
  assert.deepEqual(await readdir(path.join(storage, '.incoming')), ['publish.lock']);
  await assert.rejects(store.publish(await input(store, second)), errorCode('BUSY'));
});

test('firmware download opened before publication streams the immutable old file while new downloads see the new generation', async (t) => {
  const { store } = await fixture(t);
  await store.publish(await input(store));
  const download = await store.download('c23');
  try {
    await store.publish(await input(store, second));
    const chunks: Buffer[] = [];
    for await (const chunk of download.handle.createReadStream({ start: 0, autoClose: false })) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.toString(), first.c23);
    assert.equal(bytes.length, download.size);
    assert.equal(sha(bytes), download.sha256);
    await assertPair(store, second);
  } finally { await download.handle.close(); }
});

test('firmware generation selected before a pointer switch remains coherent when the actual download open is delayed', { timeout: 5000 }, async (t) => {
  const { root, store } = await fixture(t);
  await store.publish(await input(store));
  let announce!: () => void;
  let resume!: () => void;
  const selected = new Promise<void>((resolve) => { announce = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const reader = createFirmwareStore(root, { async fault(point) { if (point === 'download:before-open') { announce(); await gate; } } });
  const pending = reader.download('ver');
  await selected;
  try { await store.publish(await input(store, second)); } finally { resume(); }
  const download = await pending;
  try { assert.equal(await download.handle.readFile('utf8'), first.ver); } finally { await download.handle.close(); }
  await assertPair(store, second);
});

test('firmware separate factory instances share the publication lock across both publish and rollback', { timeout: 5000 }, async (t) => {
  const { root, store, storage } = await fixture(t);
  const before = await store.publish(await input(store));
  const request = await input(store, second);
  let announce!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { announce = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const writer = createFirmwareStore(root, { async fault(point) { if (point === 'locked') { announce(); await gate; } } });
  const pending = writer.publish(request);
  try {
    await entered;
    const other = createFirmwareStore(root);
    await assert.rejects(other.publish(request), errorCode('BUSY'));
    await assert.rejects(other.rollback({ expectedRevision: before.revision, previousId: before.previous!.id }), errorCode('BUSY'));
    await assertPair(other, first);
  } finally { resume(); }
  await pending;
  await assertPair(store, second);
  await assertIncomingEmpty(storage);
});

test('firmware existing stale crash lock is never removed by a competing request', async (t) => {
  const { store, storage } = await fixture(t);
  const before = await store.publish(await input(store));
  const request = await input(store, second);
  const lock = path.join(storage, '.incoming', 'publish.lock');
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), '{"pid":999999,"synthetic":true}');
  await assert.rejects(store.publish(request), errorCode('BUSY'));
  assert.equal(await readFile(path.join(lock, 'owner.json'), 'utf8'), '{"pid":999999,"synthetic":true}');
  assert.equal((await store.overview()).revision, before.revision);
  await assertPair(store, first);
});

for (const kind of ['c23', 'ver'] as const) {
  test(`firmware same-size corruption of committed ${kind} fails closed and never falls back silently to legacy`, async (t) => {
    const { store, storage } = await fixture(t);
    const committed = await store.publish(await input(store));
    const file = path.join(storage, 'releases', committed.current!.id, FIRMWARE_FILES[kind].fileName);
    const bytes = await readFile(file);
    bytes[0] ^= 1;
    await writeFile(file, bytes);
    await assert.rejects(store.download(kind), errorCode('STORAGE_INVALID'));
    await assert.rejects(store.overview(), errorCode('STORAGE_INVALID'));
    await assert.rejects(store.rollback({ expectedRevision: committed.revision, previousId: committed.previous!.id }), errorCode('STORAGE_INVALID'));
    await assertIncomingEmpty(storage);
  });
}

test('firmware malformed state or path-traversal identifiers fail closed without changing an outside sentinel', async (t) => {
  const { store, storage, root } = await fixture(t);
  const committed = await store.publish(await input(store));
  const sentinel = path.join(root, 'outside-sentinel');
  await writeFile(sentinel, 'never modify');
  for (const state of ['{', JSON.stringify({ revision: committed.revision, current: '../../outside-sentinel', previous: null })]) {
    await writeFile(path.join(storage, 'state.json'), state);
    await assert.rejects(store.overview(), errorCode('STORAGE_INVALID'));
    await assert.rejects(store.download('c23'), errorCode('STORAGE_INVALID'));
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'never modify');
});

test('firmware manifest tampering and file-size truncation fail closed', async (t) => {
  const { store, storage } = await fixture(t);
  const committed = await store.publish(await input(store));
  const directory = path.join(storage, 'releases', committed.current!.id);
  const manifest = path.join(directory, 'manifest.json');
  const originalManifest = await readFile(manifest);
  const invalid = JSON.parse(originalManifest.toString());
  invalid.files.c23.fileName = '../../outside';
  await writeFile(manifest, JSON.stringify(invalid));
  await assert.rejects(store.download('c23'), errorCode('STORAGE_INVALID'));
  await writeFile(manifest, originalManifest);
  await writeFile(path.join(directory, FIRMWARE_FILES.c23.fileName), 'x');
  await assert.rejects(store.download('c23'), errorCode('STORAGE_INVALID'));
});

for (const location of ['.firmware-store', 'hse', 'hse/gen_1', 'hse/gen_1/hse_gen_1.c23']) {
  test(`firmware rejects symlink traversal at ${location} and leaves the symlink target unchanged`, async (t) => {
    const { root, store } = await fixture(t);
    const target = path.join(root, 'synthetic-target');
    if (location.endsWith('.c23')) await writeFile(target, 'outside content');
    else await mkdir(target);
    const link = path.join(root, location);
    await rm(link, { recursive: true, force: true });
    await symlink(target, link);
    await assert.rejects(store.overview());
    await assert.rejects(store.publish({
      expectedRevision: 'empty', c23: new File([first.c23], 'synthetic.c23'), ver: new File([first.ver], 'synthetic.ver'),
      c23Sha256: sha(first.c23), verSha256: sha(first.ver),
    }));
    if (location.endsWith('.c23')) assert.equal(await readFile(target, 'utf8'), 'outside content');
    else assert.deepEqual(await readdir(target), []);
  });
}

test('firmware rejects symlinked committed files, manifests and state pointers instead of following them', async (t) => {
  const { store, storage, root } = await fixture(t);
  const committed = await store.publish(await input(store));
  const filenames = [
    path.join(storage, 'releases', committed.current!.id, FIRMWARE_FILES.c23.fileName),
    path.join(storage, 'releases', committed.current!.id, 'manifest.json'),
    path.join(storage, 'state.json'),
  ];
  for (let index = 0; index < filenames.length; index++) {
    const filename = filenames[index];
    const bytes = await readFile(filename);
    const target = path.join(root, `synthetic-symlink-target-${index}`);
    await writeFile(target, bytes);
    await rm(filename);
    await symlink(target, filename);
    await assert.rejects(store.download('c23'));
    assert.deepEqual(await readFile(target), bytes);
    await rm(filename);
    await writeFile(filename, bytes);
  }
});

test('firmware quota failures preserve current, previous and archived generations without pruning', async (t) => {
  const { root, store, storage } = await fixture(t);
  await store.publish(await input(store));
  const before = await store.publish(await input(store, second));
  const releases = await readdir(path.join(storage, 'releases'));
  const constrained = createFirmwareStore(root, { quotaBytes: 1 });
  await assert.rejects(constrained.publish(await input(store)), errorCode('QUOTA'));
  assert.equal((await store.overview()).revision, before.revision);
  assert.deepEqual(await readdir(path.join(storage, 'releases')), releases);
  await assertPair(store, second);
  await assertIncomingEmpty(storage);
  const rollback = await constrained.rollback({ expectedRevision: before.revision, previousId: before.previous!.id });
  assert.equal(rollback.current?.versionLabel, '1.0.0', 'storage quota must not block rollback to an existing complete copy');
  assert.deepEqual(await readdir(path.join(storage, 'releases')), releases);
});
