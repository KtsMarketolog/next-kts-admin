'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cloud = require('../cloud.cjs');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const option = (args, name) => args[args.indexOf(name) + 1];
const encryptionRule = (key, algorithm = 'aws:kms') => ({
  ApplyServerSideEncryptionByDefault: { SSEAlgorithm: algorithm, KMSMasterKeyID: key },
});

function fixture(t) {
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryParent, 'kts-cloud-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), temporaryParent);
    assert.match(path.basename(root), /^kts-cloud-test-/);
    fs.rmSync(root, { recursive: true }); // This fixture's own temporary tree only.
  });
  for (const directory of ['postgres', 'files', 'config', 'manifests', 'receipts']) {
    fs.mkdirSync(path.join(root, directory), { mode: 0o700 });
  }
  const configFile = path.join(root, 'aws-config');
  const credentialsFile = path.join(root, 'aws-credentials');
  fs.writeFileSync(configFile, '[profile kts-backup-test]\nregion = ru-central1\n', { mode: 0o600 });
  fs.writeFileSync(credentialsFile,
    '[kts-backup-test]\naws_access_key_id = TEST_ONLY_NOT_A_KEY\naws_secret_access_key = TEST_ONLY_NOT_A_SECRET\n',
    { mode: 0o600 });
  const config = {
    cloudApproved: true, minFreeBytes: 0,
    cloud: {
      bucket: 'kts-next-admin-test', prefix: '', kmsKeyId: 'testkmskey0000000000',
      profile: 'kts-backup-test', awsBin: '/mock/aws-never-executed',
      configFile, credentialsFile, endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1',
    },
  };
  const objects = new Map();
  const calls = [];
  let corruptDownload;
  let headMetadata = (checksum) => ({ sha256: checksum });
  let bucketEncryption = {
    ServerSideEncryptionConfiguration: { Rules: [encryptionRule(config.cloud.kmsKeyId)] },
  };
  let changedDefaultKey;
  const ctx = {
    config, root, log() {},
    async run(binary, args, { env }) {
      // All cloud requests are simulated in memory: no child process/network.
      assert.equal(binary, '/mock/aws-never-executed');
      assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, credentialsFile);
      assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
      assert.equal(option(args, '--bucket'), config.cloud.bucket);
      assert.equal(args.includes('--delete'), false);
      const operation = args[args.indexOf('s3api') + 1];
      const key = option(args, '--key');
      const prefix = option(args, '--prefix');
      calls.push({ operation, key, prefix });
      let response = {};
      if (operation === 'list-objects-v2') {
        const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
        const visible = option(args, '--max-keys') === '1' ? keys.slice(0, 1) : keys;
        response = { Contents: visible.map((Key) => ({ Key })), IsTruncated: false };
      } else if (operation === 'get-bucket-encryption') {
        response = bucketEncryption;
      } else if (operation === 'put-object') {
        assert.equal(calls.at(-2)?.operation, 'get-bucket-encryption',
          'every PUT must immediately follow a fresh bucket-encryption preflight');
        assert.equal(option(args, '--if-none-match'), '*');
        assert.equal(args.includes('--server-side-encryption'), false);
        assert.equal(args.includes('--ssekms-key-id'), false);
        assert.equal(objects.has(key), false, 'a completed object must never be overwritten');
        if (changedDefaultKey) {
          // Simulate an administrator changing the bucket default after the
          // preflight response, before Object Storage receives the PUT.
          bucketEncryption = {
            ServerSideEncryptionConfiguration: { Rules: [encryptionRule(changedDefaultKey)] },
          };
          changedDefaultKey = undefined;
        }
        const defaults = bucketEncryption.ServerSideEncryptionConfiguration.Rules[0]
          .ApplyServerSideEncryptionByDefault;
        objects.set(key, {
          bytes: fs.readFileSync(option(args, '--body')),
          checksum: option(args, '--metadata').slice('sha256='.length),
          etag: `opaque-version-${objects.size}`, // Deliberately not an MD5.
          algorithm: defaults.SSEAlgorithm,
          kmsKeyId: defaults.KMSMasterKeyID,
        });
      } else if (operation === 'head-object') {
        const object = objects.get(key);
        assert.ok(object);
        response = {
          ContentLength: object.bytes.length, Metadata: headMetadata(object.checksum),
          ServerSideEncryption: object.algorithm, SSEKMSKeyId: object.kmsKeyId, ETag: object.etag,
        };
      } else if (operation === 'get-object') {
        const object = objects.get(key);
        assert.ok(object);
        assert.equal(option(args, '--if-match'), object.etag);
        const bytes = key === corruptDownload ? Buffer.alloc(object.bytes.length, 0) : object.bytes;
        fs.writeFileSync(args.at(-1), bytes);
      } else {
        assert.fail(`Unexpected AWS operation: ${operation}`);
      }
      return { stdout: JSON.stringify(response) };
    },
  };
  return {
    ctx, root, calls, objects,
    makeManifest(ageDays) {
      const createdAt = new Date(Date.now() - ageDays * 86_400_000).toISOString();
      const stamp = createdAt.slice(0, 19).replace(/[-:]/g, '') + 'Z';
      const id = `kts-next-admin-${stamp}-aabbccdd`;
      const manifest = { project: 'kts-next-admin', id, createdAt, artifacts: [] };
      for (const kind of ['postgres', 'files', 'config']) {
        const key = `${kind}/${id}.${kind === 'postgres' ? 'dump' : 'tar.gz'}`;
        const bytes = Buffer.from(`Fixture only: ${id}, ${kind}`);
        fs.writeFileSync(path.join(root, key), bytes, { mode: 0o600 });
        manifest.artifacts.push({ kind, key, size: bytes.length, sha256: sha256(bytes) });
      }
      fs.writeFileSync(path.join(root, 'manifests', `${id}.json`), JSON.stringify(manifest), { mode: 0o600 });
      return manifest;
    },
    expire(manifest) {
      for (const key of objects.keys()) if (key.includes(manifest.id)) objects.delete(key);
    },
    receiptPath(manifest) { return path.join(root, 'receipts', `${manifest.id}.json`); },
    corrupt(key) { corruptDownload = key; },
    metadata(transform) { headMetadata = transform; },
    encryption(response) { bucketEncryption = response; },
    changeDefaultAtNextPut(key) { changedDefaultKey = key; },
  };
}

test('5-day cloud / 14-day local: confirmed history is skipped while newest bytes are verified', async (t) => {
  const f = fixture(t);
  const historical = f.makeManifest(10);
  const newest = f.makeManifest(0);
  await cloud.sync(f.ctx, [historical]);
  await cloud.sync(f.ctx, [newest]);
  f.expire(historical); // Lifecycle expired the cloud copy; local copy remains.
  f.calls.length = 0;

  assert.equal(await cloud.validReceipt(f.ctx, historical), true);
  assert.equal(f.calls.length, 0, 'receipt validation is local only');
  await cloud.sync(f.ctx, [historical, newest]);

  assert.equal(f.calls.filter((c) => c.operation === 'put-object').length, 0);
  assert.equal(f.calls.filter((c) => c.operation === 'get-object').length, 4);
  assert.ok(f.calls.every((c) => !String(c.key).includes(historical.id) && !String(c.prefix).includes(historical.id)));
  assert.ok(fs.existsSync(path.join(f.root, historical.artifacts[0].key)));
  assert.ok([...f.objects.keys()].every((key) => !key.includes(historical.id)));
});

test('expired newest is an error and never causes any PUT', async (t) => {
  const f = fixture(t);
  const newest = f.makeManifest(6);
  await cloud.sync(f.ctx, [newest]);
  const saved = fs.readFileSync(f.receiptPath(newest));
  f.expire(newest);
  f.calls.length = 0;

  await assert.rejects(cloud.sync(f.ctx, [newest]), /does not match/);
  assert.equal(f.calls.filter((c) => c.operation === 'put-object').length, 0);
  assert.deepEqual(fs.readFileSync(f.receiptPath(newest)), saved);
  assert.equal(f.objects.size, 0);
});

test('unsent old set is still retried and never mistaken for lifecycle-expired history', async (t) => {
  const f = fixture(t);
  const newest = f.makeManifest(0);
  const unsent = f.makeManifest(12);
  await cloud.sync(f.ctx, [newest]);
  f.calls.length = 0;

  assert.equal(await cloud.validReceipt(f.ctx, unsent), false);
  await cloud.sync(f.ctx, [unsent, newest]);
  const puts = f.calls.filter((c) => c.operation === 'put-object');
  assert.equal(puts.length, 4);
  assert.ok(puts.every((c) => c.key.includes(unsent.id)));
  assert.equal(puts.at(-1).key, `manifests/${unsent.id}.json`, 'commit marker must be last');
  assert.equal(await cloud.validReceipt(f.ctx, unsent), true);
});

test('mismatched receipt fails closed without cloud requests', async (t) => {
  const f = fixture(t);
  const manifest = f.makeManifest(0);
  await cloud.sync(f.ctx, [manifest]);
  const original = JSON.parse(fs.readFileSync(f.receiptPath(manifest), 'utf8'));
  for (const change of [
    { bucket: 'another-project' }, { kmsKeyId: 'anotherkmskey000000' },
    { manifestSha256: '0'.repeat(64) }, { artifacts: original.artifacts.slice(0, 2) },
    { verification: 'metadata-only' },
  ]) {
    fs.writeFileSync(f.receiptPath(manifest), JSON.stringify({ ...original, ...change }));
    f.calls.length = 0;
    await assert.rejects(cloud.validReceipt(f.ctx, manifest), /does not match/);
    await assert.rejects(cloud.sync(f.ctx, [manifest]), /does not match/);
    assert.equal(f.calls.length, 0);
  }
});

test('same-size downloaded corruption fails without refreshing receipt or uploading', async (t) => {
  const f = fixture(t);
  const manifest = f.makeManifest(0);
  await cloud.sync(f.ctx, [manifest]);
  const original = fs.readFileSync(f.receiptPath(manifest));
  f.corrupt(manifest.artifacts[0].key);
  f.calls.length = 0;

  await assert.rejects(cloud.sync(f.ctx, [manifest]), /SHA-256 verification/);
  assert.equal(f.calls.filter((c) => c.operation === 'put-object').length, 0);
  assert.deepEqual(fs.readFileSync(f.receiptPath(manifest)), original);
  assert.ok(!fs.readdirSync(f.root).some((name) => name.startsWith('.cloud-download-')));
});

for (const name of ['sha256', 'Sha256', 'SHA256']) {
  test(`HEAD accepts a single ${name} metadata key and still verifies downloaded bytes`, async (t) => {
    const f = fixture(t);
    const manifest = f.makeManifest(0);
    await cloud.sync(f.ctx, [manifest]);
    f.metadata((checksum) => ({ [name]: checksum }));
    f.calls.length = 0;

    await cloud.verify(f.ctx, manifest);

    assert.equal(f.calls.filter((c) => c.operation === 'get-object').length, 4);
    assert.equal(f.calls.filter((c) => c.operation === 'put-object').length, 0);
  });
}

for (const [name, metadata] of [
  ['duplicate aliases even with identical values', (checksum) => ({ sha256: checksum, Sha256: checksum })],
  ['missing checksum', () => ({ unrelated: 'value' })],
  ['mismatched checksum', () => ({ Sha256: '0'.repeat(64) })],
]) {
  test(`HEAD rejects ${name} without downloading or refreshing the receipt`, async (t) => {
    const f = fixture(t);
    const manifest = f.makeManifest(0);
    await cloud.sync(f.ctx, [manifest]);
    const original = fs.readFileSync(f.receiptPath(manifest));
    f.metadata(metadata);
    f.calls.length = 0;

    await assert.rejects(cloud.verify(f.ctx, manifest), /does not match/);

    assert.equal(f.calls.filter((c) => c.operation === 'get-object').length, 0);
    assert.equal(f.calls.filter((c) => c.operation === 'put-object').length, 0);
    assert.deepEqual(fs.readFileSync(f.receiptPath(manifest)), original);
  });
}

test('bucket KMS preflight runs before every PUT, including the manifest commit marker', async (t) => {
  const f = fixture(t);
  const manifest = f.makeManifest(0);

  await cloud.sync(f.ctx, [manifest]);

  const writes = f.calls.filter((c) => ['get-bucket-encryption', 'put-object'].includes(c.operation));
  assert.deepEqual(writes.map((c) => c.operation), [
    'get-bucket-encryption', 'put-object',
    'get-bucket-encryption', 'put-object',
    'get-bucket-encryption', 'put-object',
    'get-bucket-encryption', 'put-object',
  ]);
  assert.equal(writes.at(-1).key, `manifests/${manifest.id}.json`);
  assert.equal(f.calls.filter((c) => c.operation === 'get-object').length, 4);
  assert.ok([...f.objects.values()].every((object) =>
    object.algorithm === 'aws:kms' && object.kmsKeyId === f.ctx.config.cloud.kmsKeyId));
  assert.equal(await cloud.validReceipt(f.ctx, manifest), true);
});

for (const [name, settings] of [
  ['missing configuration', () => ({})],
  ['empty rules', () => ({ ServerSideEncryptionConfiguration: { Rules: [] } })],
  ['multiple rules', (key) => ({
    ServerSideEncryptionConfiguration: { Rules: [encryptionRule(key), encryptionRule(key)] },
  })],
  ['wrong algorithm', (key) => ({
    ServerSideEncryptionConfiguration: { Rules: [encryptionRule(key, 'AES256')] },
  })],
  ['another KMS key', () => ({
    ServerSideEncryptionConfiguration: { Rules: [encryptionRule('differentkmskey00000')] },
  })],
]) {
  test(`bucket preflight rejects ${name} before any upload`, async (t) => {
    const f = fixture(t);
    const manifest = f.makeManifest(0);
    f.encryption(settings(f.ctx.config.cloud.kmsKeyId));

    await assert.rejects(cloud.sync(f.ctx, [manifest]), /bucket default KMS encryption does not match/);

    assert.equal(f.calls.filter((c) => c.operation === 'get-bucket-encryption').length, 1);
    assert.equal(f.calls.filter((c) => c.operation === 'put-object').length, 0);
    assert.equal(f.calls.filter((c) => c.operation === 'get-object').length, 0);
    assert.equal(f.objects.size, 0);
    assert.equal(fs.existsSync(f.receiptPath(manifest)), false);
  });
}

test('changed bucket KMS between preflight and PUT fails actual HEAD before download or receipt', async (t) => {
  const f = fixture(t);
  const manifest = f.makeManifest(0);
  f.changeDefaultAtNextPut('changedkmskey0000000');

  await assert.rejects(cloud.sync(f.ctx, [manifest]), /does not match/);

  assert.equal(f.calls.filter((c) => c.operation === 'get-bucket-encryption').length, 1);
  assert.equal(f.calls.filter((c) => c.operation === 'put-object').length, 1);
  assert.equal(f.calls.filter((c) => c.operation === 'head-object').length, 1);
  assert.equal(f.calls.filter((c) => c.operation === 'get-object').length, 0);
  assert.equal(f.objects.size, 1);
  assert.equal(f.objects.get(manifest.artifacts[0].key).kmsKeyId, 'changedkmskey0000000');
  assert.equal(f.objects.has(`manifests/${manifest.id}.json`), false);
  assert.equal(fs.existsSync(f.receiptPath(manifest)), false);
  assert.equal(await cloud.validReceipt(f.ctx, manifest), false);
});

test('downloadLatest accepts Titlecase SHA-256 metadata and verifies the complete cloud restore set', async (t) => {
  const f = fixture(t);
  const manifest = f.makeManifest(0);
  await cloud.sync(f.ctx, [manifest]);
  f.metadata((checksum) => ({ Sha256: checksum }));
  f.calls.length = 0;
  const destination = path.join(f.root, 'restore-download');

  assert.deepEqual(await cloud.downloadLatest(f.ctx, destination), manifest);

  // Manifest is checked twice: before trusting its paths and as final commit marker.
  assert.equal(f.calls.filter((c) => c.operation === 'get-object').length, 5);
  assert.equal(f.calls.filter((c) => c.operation === 'put-object').length, 0);
  for (const artifact of manifest.artifacts) {
    const downloaded = fs.readFileSync(path.join(destination, artifact.key));
    assert.equal(downloaded.length, artifact.size);
    assert.equal(sha256(downloaded), artifact.sha256);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'manifests', `${manifest.id}.json`))), manifest);
});

for (const [name, metadata, expectedGets, error] of [
  ['duplicate aliases', (checksum) => ({ sha256: checksum, Sha256: checksum }), 0, /checksum metadata/],
  ['missing metadata', () => undefined, 0, /checksum metadata/],
  ['mismatched checksum', () => ({ Sha256: '0'.repeat(64) }), 1, /SHA-256 verification/],
]) {
  test(`downloadLatest rejects manifest ${name} without saving a restore set or refreshing receipt`, async (t) => {
    const f = fixture(t);
    const manifest = f.makeManifest(0);
    await cloud.sync(f.ctx, [manifest]);
    const original = fs.readFileSync(f.receiptPath(manifest));
    f.metadata(metadata);
    f.calls.length = 0;
    const destination = path.join(f.root, 'restore-download');

    await assert.rejects(cloud.downloadLatest(f.ctx, destination), error);

    assert.equal(f.calls.filter((c) => c.operation === 'get-object').length, expectedGets);
    assert.equal(f.calls.filter((c) => c.operation === 'put-object').length, 0);
    assert.deepEqual(fs.readFileSync(f.receiptPath(manifest)), original);
    assert.deepEqual(fs.readdirSync(destination), [], 'no archives, manifest, or temporary downloads remain');
  });
}
