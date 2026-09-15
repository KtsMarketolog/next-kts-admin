'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { candidate, safeError } = require('../configure.cjs');
const { validateConfiguration } = require('../cloud.cjs');
const PROJECT = 'kts-next-admin';
const ROOT = '/home/kts/backups/kts-next-admin';
const DIRECTORY = '/home/kts/.config/kts-backup';
const FILE = DIRECTORY + '/config.json';
const BUCKET = 'kts-next-admin-backups-test';
const KEY = 'abj00000000000000000';

async function example() {
  const config = JSON.parse(await fs.readFile(path.join(__dirname, '../config.example.json'), 'utf8'));
  return { ...config, predeployCloudPolicy: 'pending', untouched: { value: true } };
}

test('policy command changes only the approved policy', async () => {
  const original = await example(), next = candidate(original, ['policy', 'required']);
  assert.equal(next.predeployCloudPolicy, 'required');
  assert.equal(original.predeployCloudPolicy, 'pending');
  assert.deepEqual(next.untouched, original.untouched);
  assert.equal(next.cloudApproved, false);
  for (const args of [['policy', 'warn'], ['policy', 'pending'], ['policy', 'required', 'extra']]) {
    assert.throws(() => candidate(original, args), { code: 'CONFIGURE_USAGE' });
  }
});

test('cloud command pins project, profile, endpoint and audited filesystem paths', async () => {
  const config = await example(), next = candidate(config, ['cloud', BUCKET, KEY]);
  assert.equal(next.cloudApproved, true); assert.equal(config.cloudApproved, false);
  assert.equal(next.cloud.bucket, BUCKET); assert.equal(next.cloud.kmsKeyId, KEY);
  for (const mutate of [
    (c) => { c.root = '/somewhere-else'; },
    (c) => { c.envFile = '/another-project/.env'; },
    (c) => { c.cloud.profile = 'default'; },
    (c) => { c.cloud.endpoint = 'https://unrelated.invalid'; },
    (c) => { c.cloud.credentialsFile = '/another-project/keys'; },
    (c) => { c.cloud.prefix = 'another-project/'; },
  ]) {
    const changed = structuredClone(config); mutate(changed);
    assert.throws(() => candidate(changed, ['cloud', BUCKET, KEY]));
  }
  for (const [bucket, key] of [['mywood-backups', KEY], [BUCKET + '-', KEY], [BUCKET, 'invalid'], [BUCKET + '\n', KEY]]) {
    assert.throws(() => candidate(config, ['cloud', bucket, key]), { code: 'CONFIGURE_CLOUD_GUARD' });
  }
});

test('count retention requires explicit approval and reuses the existing dedicated uploader', async () => {
  const original = await example();
  original.cloudApproved = true;
  original.predeployCloudPolicy = 'required';
  original.retention = { localDays: 14, cloudDays: 5, unrelated: true };
  original.cloudRetention = { profile: 'foreign-profile', credentialsFile: '/foreign/credentials' };
  const next = candidate(original, ['retention', 'count', '5']);
  assert.deepEqual(next.retention, { localDays: 14, cloudCopies: 5, unrelated: true });
  assert.deepEqual(next.cloudRetention, { mode: 'count', keep: 5, deleteApproved: true,
    profile: original.cloud.profile, configFile: original.cloud.configFile,
    credentialsFile: original.cloud.credentialsFile });
  assert.equal(next.predeployCloudPolicy, 'required');
  assert.deepEqual(next.cloud, original.cloud);
  assert.deepEqual(next.untouched, original.untouched);
  assert.equal(original.retention.cloudDays, 5);
  assert.equal(original.cloudRetention.profile, 'foreign-profile');
  for (const args of [['retention'], ['retention', 'count', '4'], ['retention', 'count', '05'],
    ['retention', 'days', '5'], ['retention', 'count', '5', 'approve']]) {
    assert.throws(() => candidate(original, args), { code: 'CONFIGURE_USAGE' });
  }
});

test('count retention refuses unapproved cloud and unrelated access or destinations', async () => {
  const original = await example(); original.cloudApproved = true;
  for (const mutate of [
    (c) => { c.cloudApproved = false; },
    (c) => { c.cloud.profile = 'default'; },
    (c) => { c.cloud.configFile = '/another-project/aws-config'; },
    (c) => { c.cloud.credentialsFile = '/another-project/keys'; },
    (c) => { c.cloud.bucket = 'mywood-backups'; },
    (c) => { c.cloud.kmsKeyId = 'invalid'; },
    (c) => { c.cloud.endpoint = 'https://unrelated.invalid'; },
    (c) => { c.cloud.prefix = 'another-project/'; },
    (c) => { c.cloud = null; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    assert.throws(() => candidate(changed, ['retention', 'count', '5']), { code: 'CONFIGURE_RETENTION_GUARD' });
  }
});

async function commissioning(options = {}) {
  const config = await example();
  options.mutateConfig?.(config);
  const original = JSON.stringify(config), writes = [], accesses = [];
  let reads = 0, validations = 0;
  const mockedFs = {
    lstat: async (filename) => ({ isDirectory: () => true, isSymbolicLink: () => options.symlink === filename,
      uid: 1001, mode: options.worldReadable ? 0o755 : 0o700 }),
    realpath: async (filename) => filename,
    readFile: async (filename) => {
      accesses.push(filename);
      if (filename === path.join(ROOT, '.kts-backup-root')) return PROJECT + '\n';
      assert.equal(filename, FILE); reads++;
      return original + (options.concurrentChange && reads > 1 ? ' ' : '');
    },
  };
  const common = { PROJECT, ROOT, privateFile: async (filename) => { accesses.push(filename); },
    atomicJson: async (filename, value) => writes.push({ filename, value }) };
  const cloud = { validateConfiguration: (ctx) => {
    validations++;
    assert.equal(ctx.config.cloudApproved, true);
    assert.equal(ctx.config.cloud.profile, 'kts-backup');
    if (options.badCredentials || options.failAtValidation === validations) throw new Error('SECRET_EXAMPLE');
    return true;
  } };
  const req = (name) => name === 'node:fs/promises' ? mockedFs : name === './common.cjs' ? common
    : name === './cloud.cjs' ? cloud : require(name);
  const moduleObject = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../configure.cjs'), 'utf8'), {
    require: req, module: moduleObject, console,
    process: { getuid: () => options.rootUser ? 0 : 1001, umask: () => {}, env: { KTS_BACKUP_CONFIG: '/ignored-file' } },
  }, { filename: 'configure.cjs' });
  let error, result;
  try { result = await moduleObject.exports.configure(options.args ?? ['cloud', BUCKET, KEY]); }
  catch (caught) { error = caught; }
  return { error, result, writes, accesses, validations };
}

test('commissioning validates private AWS files before one atomic fixed-path write', async () => {
  const result = await commissioning();
  assert.equal(result.error, undefined); assert.equal(result.validations, 1);
  assert.equal(result.writes.length, 1); assert.equal(result.writes[0].filename, FILE);
  assert.equal(result.writes[0].value.cloudApproved, true);
  assert.ok(result.accesses.every((filename) => filename !== '/ignored-file'));
  assert.ok(!result.result.includes(KEY));
});

test('bad AWS credentials never enable cloud or leak their diagnostic text', async () => {
  const result = await commissioning({ badCredentials: true });
  assert.equal(result.error.code, 'CONFIGURE_PRIVATE_AWS_INVALID'); assert.equal(result.writes.length, 0);
  assert.ok(!safeError(result.error).includes('SECRET_EXAMPLE'));
  assert.equal(safeError(new Error('SECRET_EXAMPLE')), 'CONFIGURE_FAILED');
});

test('root, unprivate/symlink directories and concurrent changes fail without writes', async () => {
  for (const options of [{ rootUser: true }, { worldReadable: true }, { symlink: ROOT }, { concurrentChange: true }]) {
    const result = await commissioning(options); assert.ok(result.error); assert.equal(result.writes.length, 0);
  }
});

test('policy commissioning does not read AWS credentials or enable cloud', async () => {
  const result = await commissioning({ args: ['policy', 'required'], badCredentials: true });
  assert.equal(result.error, undefined); assert.equal(result.validations, 0);
  assert.equal(result.writes[0].value.cloudApproved, false);
  assert.equal(result.writes[0].value.predeployCloudPolicy, 'required');
});

test('count commissioning validates both uses of the existing profile before persisting approval', async () => {
  const options = { args: ['retention', 'count', '5'], mutateConfig: (config) => {
    config.cloudApproved = true; config.predeployCloudPolicy = 'required';
    config.retention = { localDays: 14, cloudDays: 5 };
  } };
  const result = await commissioning(options);
  assert.equal(result.error, undefined); assert.equal(result.validations, 2);
  assert.equal(result.writes.length, 1);
  const next = result.writes[0].value;
  assert.equal(next.cloudRetention.deleteApproved, true);
  assert.equal(next.cloudRetention.credentialsFile, next.cloud.credentialsFile);
  assert.equal(next.retention.localDays, 14); assert.equal(next.retention.cloudCopies, 5);
  assert.equal(Object.hasOwn(next.retention, 'cloudDays'), false);
  assert.equal(next.predeployCloudPolicy, 'required');
  for (const additional of [{ badCredentials: true }, { failAtValidation: 2 }, { concurrentChange: true }]) {
    const rejected = await commissioning({ ...options, ...additional });
    assert.ok(rejected.error); assert.equal(rejected.writes.length, 0);
    assert.ok(!safeError(rejected.error).includes('SECRET_EXAMPLE'));
  }
});

test('example keeps count deletion disabled and lifecycle does not expire completed objects', async () => {
  const config = await example();
  assert.equal(config.cloudRetention.mode, 'count'); assert.equal(config.cloudRetention.keep, 5);
  assert.equal(config.cloudRetention.deleteApproved, false);
  assert.equal(config.retention.cloudCopies, 5); assert.equal(Object.hasOwn(config.retention, 'cloudDays'), false);
  const lifecycle = JSON.parse(await fs.readFile(path.join(__dirname, '../yandex-lifecycle-count.json'), 'utf8'));
  assert.equal(lifecycle.Rules.length, 1);
  assert.deepEqual(lifecycle.Rules[0].AbortIncompleteMultipartUpload, { DaysAfterInitiation: 1 });
  assert.equal(lifecycle.Rules[0].Status, 'Enabled');
  assert.equal(Object.hasOwn(lifecycle.Rules[0], 'Expiration'), false);
  assert.equal(Object.hasOwn(lifecycle.Rules[0], 'NoncurrentVersionExpiration'), false);
});

test('shared cloud configuration validator is local-only and enforces private credentials', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kts-config-test-')));
  await fs.chmod(root, 0o700); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const credentialsFile = path.join(root, 'credentials'), configFile = path.join(root, 'config');
  await fs.writeFile(credentialsFile, '[kts-backup]\naws_access_key_id = fixture\naws_secret_access_key = fixture\n', { mode: 0o600 });
  await fs.writeFile(configFile, '[profile kts-backup]\nregion = ru-central1\n', { mode: 0o600 });
  let network = false;
  const ctx = { root, config: { cloudApproved: true, cloud: { bucket: BUCKET, kmsKeyId: KEY, prefix: '',
    profile: 'kts-backup', awsBin: path.join(root, 'unused-aws'), credentialsFile, configFile,
    endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1' } },
    run: () => { network = true; throw new Error('No network allowed'); } };
  assert.equal(validateConfiguration(ctx), true); assert.equal(network, false);
  await fs.chmod(credentialsFile, 0o644);
  assert.throws(() => validateConfiguration(ctx)); assert.equal(network, false);
});
