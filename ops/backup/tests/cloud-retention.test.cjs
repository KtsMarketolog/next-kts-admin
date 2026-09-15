'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const retention = require('../cloud-retention.cjs');

const JOURNAL = 'cloud-prune-in-progress.json';
const HISTORY = 'cloud-prune-history.json';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const itemDescriptors = (item) => [item.descriptor, ...item.manifest.artifacts];

function fixture(t, count = 0) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'kts-cloud-retention-test-'));
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, 'state'), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'postgres'), { mode: 0o700 });
  const localSentinel = path.join(root, 'postgres', 'local-copy.dump');
  fs.writeFileSync(localSentinel, 'local backup must not be pruned', { mode: 0o600 });
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^kts-cloud-retention-test-/u);
    fs.rmSync(root, { recursive: true });
  });
  const cloud = { bucket: 'kts-next-admin-test', prefix: '', kmsKeyId: 'testkmskey0000000000' };
  const ctx = {
    root,
    config: {
      cloud,
      cloudRetention: {
        mode: 'count', keep: 5, deleteApproved: true, profile: 'kts-cleanup-test',
        configFile: path.join(root, 'cleanup-config'), credentialsFile: path.join(root, 'cleanup-credentials'),
      },
    },
  };
  const catalog = new Map();
  const objects = new Map();
  const events = [];
  const corrupt = new Set();
  let policy = true;
  let failAfterRemove = null;
  const base = Date.now() - 10 * 60_000;

  function makeSet(index) {
    const createdAt = new Date(base - index * 1000).toISOString();
    const stamp = createdAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    const id = `kts-next-admin-${stamp}-${(index + 1).toString(16).padStart(8, '0')}`;
    const artifacts = ['postgres', 'files', 'config'].map((kind) => ({
      kind, key: `${kind}/${id}.${kind === 'postgres' ? 'dump' : 'tar.gz'}`,
      size: 1000 + index, sha256: sha256(`${id}:${kind}`),
    }));
    const entry = {
      manifest: { project: 'kts-next-admin', id, createdAt, artifacts },
      descriptor: { kind: 'manifest', key: `manifests/${id}.json`, size: 200 + index, sha256: sha256(`${id}:manifest`) },
    };
    catalog.set(id, entry);
    for (const descriptor of itemDescriptors(entry)) objects.set(descriptor.key, clone(descriptor));
    return entry;
  }
  const sets = Array.from({ length: count }, (_, index) => makeSet(index));

  function exactPresent(item) {
    return itemDescriptors(item).every((descriptor) => {
      const remote = objects.get(descriptor.key);
      return remote && JSON.stringify(remote) === JSON.stringify(descriptor);
    });
  }

  const api = {
    ...cloud,
    async assertPolicy() { events.push({ operation: 'policy' }); return policy; },
    async listSets() {
      events.push({ operation: 'list' });
      return [...catalog.values()].filter((item) => objects.has(item.descriptor.key)).map(clone);
    },
    async verifySet(item) {
      events.push({ operation: 'verify', id: item.manifest.id });
      if (corrupt.has(item.manifest.id) || !exactPresent(item)) throw new Error('fixture cloud bytes invalid');
      return true;
    },
    async inspect(item) {
      events.push({ operation: 'inspect', id: item.manifest.id });
      return exactPresent(item);
    },
    async remove(descriptor) {
      events.push({ operation: 'remove', kind: descriptor.kind, key: descriptor.key });
      const remote = objects.get(descriptor.key);
      if (remote && JSON.stringify(remote) !== JSON.stringify(descriptor)) throw new Error('fixture descriptor mismatch');
      objects.delete(descriptor.key); // Absence is success, making crash replay idempotent.
      if (failAfterRemove && failAfterRemove(descriptor)) throw new Error('fixture crash after delete');
      return true;
    },
  };

  return {
    root, ctx, api, sets, catalog, objects, events, corrupt, localSentinel,
    makeSet,
    policy(value) { policy = value; },
    failAfterRemove(value) { failAfterRemove = value; },
    complete() { return [...catalog.values()].filter((item) => objects.has(item.descriptor.key)); },
    journal() { return path.join(root, 'state', JOURNAL); },
    history() { return path.join(root, 'state', HISTORY); },
  };
}

test('legacy configuration without a mode is disabled and performs no cloud operation', async (t) => {
  const f = fixture(t, 8);
  delete f.ctx.config.cloudRetention.mode;
  const result = await retention.prune(f.ctx, f.api);
  assert.equal(result.enabled, false);
  assert.deepEqual(f.events, []);
  assert.equal(f.complete().length, 8);
});

test('enabled retention configuration is exact and fails closed', async (t) => {
  for (const change of [
    { mode: 'days' }, { keep: 4 }, { deleteApproved: false }, { profile: 'default' },
    { configFile: 'relative' }, { credentialsFile: '/' },
  ]) {
    const f = fixture(t, 6);
    Object.assign(f.ctx.config.cloudRetention, change);
    await assert.rejects(retention.prune(f.ctx, f.api), { code: 'CLOUD_RETENTION_CONFIG' });
    assert.equal(f.events.some((event) => event.operation === 'remove'), false);
  }
});

test('wrong adapter identity or unsafe remote set fails before deletion', async (t) => {
  const wrong = fixture(t, 6);
  wrong.api.bucket = 'another-project';
  await assert.rejects(retention.prune(wrong.ctx, wrong.api), { code: 'CLOUD_RETENTION_IDENTITY' });
  assert.deepEqual(wrong.events, []);

  const unsafe = fixture(t, 6);
  const original = unsafe.sets[0];
  unsafe.catalog.delete(original.manifest.id);
  const changed = clone(original);
  changed.manifest.id = '../unsafe';
  unsafe.catalog.set(changed.manifest.id, changed);
  await assert.rejects(retention.prune(unsafe.ctx, unsafe.api), { code: 'CLOUD_RETENTION_SET' });
  assert.equal(unsafe.events.some((event) => event.operation === 'remove'), false);

  const duplicate = fixture(t, 6);
  const list = duplicate.api.listSets;
  duplicate.api.listSets = async () => { const values = await list(); return [...values, values[0]]; };
  await assert.rejects(retention.prune(duplicate.ctx, duplicate.api), { code: 'CLOUD_RETENTION_DUPLICATE' });
  assert.equal(duplicate.events.some((event) => event.operation === 'remove'), false);
});

test('policy must explicitly confirm disabled versioning and expiration', async (t) => {
  const f = fixture(t, 6);
  f.policy(false);
  await assert.rejects(retention.prune(f.ctx, f.api), { code: 'CLOUD_RETENTION_POLICY' });
  assert.equal(f.events.some((event) => event.operation === 'list'), false);
  assert.equal(f.events.some((event) => event.operation === 'remove'), false);
});

test('five or fewer complete sets need no full download and no delete', async (t) => {
  for (const count of [0, 1, 5]) {
    const f = fixture(t, count);
    const result = await retention.prune(f.ctx, f.api);
    assert.equal(result.total, count);
    assert.equal(result.deleted, 0);
    assert.equal(f.events.some((event) => event.operation === 'verify'), false);
    assert.equal(f.events.some((event) => event.operation === 'remove'), false);
  }
});

test('six sets become five only after every keeper passes full verification', async (t) => {
  const f = fixture(t, 6);
  const result = await retention.prune(f.ctx, f.api);
  assert.deepEqual(result, { enabled: true, mode: 'count', keep: 5, total: 5, deleted: 1, recovered: 0 });
  assert.deepEqual(f.events.filter((event) => event.operation === 'verify').map((event) => event.id),
    f.sets.slice(0, 5).map((item) => item.manifest.id));
  const firstRemove = f.events.findIndex((event) => event.operation === 'remove');
  const lastVerify = f.events.findLastIndex((event) => event.operation === 'verify');
  assert.ok(firstRemove > lastVerify);
  assert.deepEqual(f.events.filter((event) => event.operation === 'remove').map((event) => event.kind),
    ['manifest', 'postgres', 'files', 'config']);
  assert.deepEqual(f.complete().map((item) => item.manifest.id), f.sets.slice(0, 5).map((item) => item.manifest.id));
  assert.equal(fs.existsSync(f.journal()), false);
  assert.equal(fs.readFileSync(f.localSentinel, 'utf8'), 'local backup must not be pruned');
  const history = JSON.parse(fs.readFileSync(f.history(), 'utf8'));
  assert.deepEqual(history.entries.map((item) => item.id), [f.sets[5].manifest.id]);
  assert.equal(fs.statSync(f.history()).mode & 0o777, 0o600);
});

test('seventeen sets become exactly five without touching local copies', async (t) => {
  const f = fixture(t, 17);
  const result = await retention.prune(f.ctx, f.api);
  assert.equal(result.deleted, 12);
  assert.equal(result.total, 5);
  assert.equal(f.complete().length, 5);
  assert.deepEqual(f.complete().map((item) => item.manifest.id), f.sets.slice(0, 5).map((item) => item.manifest.id));
  assert.equal(f.events.filter((event) => event.operation === 'verify').length, 5);
  const removed = f.events.filter((event) => event.operation === 'remove');
  assert.equal(removed.length, 48);
  for (let index = 0; index < removed.length; index += 4) {
    assert.deepEqual(removed.slice(index, index + 4).map((event) => event.kind),
      ['manifest', 'postgres', 'files', 'config']);
  }
  assert.equal(fs.readFileSync(f.localSentinel, 'utf8'), 'local backup must not be pruned');
  assert.equal(JSON.parse(fs.readFileSync(f.history(), 'utf8')).entries.length, 12);
});

test('a corrupt keeper or incomplete candidate prevents every deletion', async (t) => {
  const corrupt = fixture(t, 6);
  corrupt.corrupt.add(corrupt.sets[2].manifest.id);
  await assert.rejects(retention.prune(corrupt.ctx, corrupt.api), { code: 'CLOUD_RETENTION_VERIFY' });
  assert.equal(corrupt.events.some((event) => event.operation === 'remove'), false);
  assert.equal(fs.existsSync(corrupt.journal()), false);

  const incomplete = fixture(t, 6);
  incomplete.objects.delete(incomplete.sets[5].manifest.artifacts[1].key);
  await assert.rejects(retention.prune(incomplete.ctx, incomplete.api), { code: 'CLOUD_RETENTION_INSPECT' });
  assert.equal(incomplete.events.some((event) => event.operation === 'remove'), false);
  assert.equal(fs.existsSync(incomplete.journal()), false);
});

test('crash recovery revalidates the original five keepers and resumes the exact target', async (t) => {
  const f = fixture(t, 6);
  let failed = false;
  f.failAfterRemove((descriptor) => {
    if (!failed && descriptor.kind === 'manifest') { failed = true; return true; }
    return false;
  });
  await assert.rejects(retention.prune(f.ctx, f.api), { code: 'CLOUD_RETENTION_DELETE' });
  assert.equal(fs.existsSync(f.journal()), true);
  assert.equal(JSON.parse(fs.readFileSync(f.journal(), 'utf8')).nextIndex, 0);
  assert.equal(f.objects.has(f.sets[5].descriptor.key), false);
  assert.ok(f.objects.has(f.sets[5].manifest.artifacts[0].key));

  // Even a position recorded as complete is rechecked idempotently. This
  // catches an exact-key object recreated by outside operator interference.
  const saved = JSON.parse(fs.readFileSync(f.journal(), 'utf8'));
  saved.nextIndex = 1;
  fs.writeFileSync(f.journal(), JSON.stringify(saved), { mode: 0o600 });
  f.objects.set(f.sets[5].descriptor.key, clone(f.sets[5].descriptor));

  f.failAfterRemove(null);
  f.events.length = 0;
  const result = await retention.prune(f.ctx, f.api);
  assert.equal(result.recovered, 1);
  assert.equal(result.deleted, 1);
  assert.equal(f.events.filter((event) => event.operation === 'verify').length, 5);
  assert.deepEqual(f.events.filter((event) => event.operation === 'remove').map((event) => event.kind),
    ['manifest', 'postgres', 'files', 'config']);
  assert.equal(fs.existsSync(f.journal()), false);
  assert.equal(itemDescriptors(f.sets[5]).some((descriptor) => f.objects.has(descriptor.key)), false);
});

test('recovery fails closed for a changed identity, missing keeper, or corrupt keeper', async (t) => {
  async function crashedFixture() {
    const f = fixture(t, 6);
    let failed = false;
    f.failAfterRemove(() => { if (!failed) { failed = true; return true; } return false; });
    await assert.rejects(retention.prune(f.ctx, f.api), { code: 'CLOUD_RETENTION_DELETE' });
    f.failAfterRemove(null);
    f.events.length = 0;
    return f;
  }

  const identity = await crashedFixture();
  const journal = JSON.parse(fs.readFileSync(identity.journal(), 'utf8'));
  journal.identity.bucket = 'another-project';
  fs.writeFileSync(identity.journal(), JSON.stringify(journal), { mode: 0o600 });
  await assert.rejects(retention.prune(identity.ctx, identity.api), { code: 'CLOUD_RETENTION_JOURNAL' });
  assert.equal(identity.events.some((event) => event.operation === 'remove'), false);

  const missing = await crashedFixture();
  missing.objects.delete(missing.sets[1].descriptor.key);
  await assert.rejects(retention.prune(missing.ctx, missing.api), { code: 'CLOUD_RETENTION_KEEPERS' });
  assert.equal(missing.events.some((event) => event.operation === 'remove'), false);

  const corrupt = await crashedFixture();
  corrupt.corrupt.add(corrupt.sets[1].manifest.id);
  await assert.rejects(retention.prune(corrupt.ctx, corrupt.api), { code: 'CLOUD_RETENTION_VERIFY' });
  assert.equal(corrupt.events.some((event) => event.operation === 'remove'), false);
});

test('health is HEAD-only, rejects excess/pending state, and ignores partial orphans', async (t) => {
  const healthy = fixture(t, 5);
  healthy.objects.set('files/orphan-without-manifest.tar.gz', {
    kind: 'files', key: 'files/orphan-without-manifest.tar.gz', size: 99, sha256: 'a'.repeat(64),
  });
  const report = await retention.health(healthy.ctx, healthy.api);
  assert.deepEqual(report, { enabled: true, mode: 'count', keep: 5, completeSets: 5, objects: 20, pending: false });
  assert.equal(healthy.events.filter((event) => event.operation === 'inspect').length, 5);
  assert.equal(healthy.events.some((event) => event.operation === 'verify'), false);
  assert.equal(healthy.events.some((event) => event.operation === 'remove'), false);
  assert.ok(healthy.objects.has('files/orphan-without-manifest.tar.gz'));

  const excess = fixture(t, 6);
  await assert.rejects(retention.health(excess.ctx, excess.api), { code: 'CLOUD_RETENTION_COUNT' });
  assert.equal(excess.events.some((event) => event.operation === 'inspect'), false);

  const pending = fixture(t, 6);
  let failed = false;
  pending.failAfterRemove(() => { if (!failed) { failed = true; return true; } return false; });
  await assert.rejects(retention.prune(pending.ctx, pending.api), { code: 'CLOUD_RETENTION_DELETE' });
  pending.events.length = 0;
  await assert.rejects(retention.health(pending.ctx, pending.api), { code: 'CLOUD_RETENTION_PENDING' });
  assert.equal(pending.events.some((event) => event.operation === 'list'), false);
});
