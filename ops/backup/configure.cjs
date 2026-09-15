'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicJson, privateFile, PROJECT, ROOT } = require('./common.cjs');
const { validateConfiguration } = require('./cloud.cjs');

const CONFIG_DIR = '/home/kts/.config/kts-backup';
const CONFIG_FILE = CONFIG_DIR + '/config.json';
const AUDITED = Object.freeze({
  appCurrent: '/home/kts/kts-next-admin/current',
  envFile: '/home/kts/kts-next-admin/.env.local',
  pgBin: '/usr/lib/postgresql/16/bin',
});
const AUDITED_CLOUD = Object.freeze({
  prefix: '', profile: 'kts-backup', awsBin: '/home/kts/.local/bin/aws',
  configFile: CONFIG_DIR + '/aws-config', credentialsFile: CONFIG_DIR + '/aws-credentials',
  endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1',
});
const ERROR_CODES = new Set([
  'CONFIGURE_USAGE', 'CONFIGURE_PATH_GUARD', 'CONFIGURE_PROJECT_GUARD',
  'CONFIGURE_CLOUD_GUARD', 'CONFIGURE_RETENTION_GUARD', 'CONFIGURE_PRIVATE_AWS_INVALID', 'CONFIGURE_CHANGED',
]);

function fail(code) { const error = new Error(code); error.code = code; return error; }
function safeError(error) { return ERROR_CODES.has(error?.code) ? error.code : 'CONFIGURE_FAILED'; }

function auditedCloud(cloud) {
  return cloud && Object.entries(AUDITED_CLOUD).every(([key, value]) => cloud[key] === value);
}

function cloudTarget(bucket, kmsKeyId) {
  return typeof bucket === 'string' && bucket.length <= 63
    && /^kts-next-admin-backups-[a-z0-9][a-z0-9-]*$/.test(bucket) && !bucket.endsWith('-')
    && typeof kmsKeyId === 'string' && /^[a-z0-9]{10,64}$/.test(kmsKeyId);
}

function candidate(config, args) {
  if (!config || config.project !== PROJECT || config.root !== ROOT
      || config.restoreRoot !== ROOT + '/.restore'
      || Object.entries(AUDITED).some(([key, value]) => config[key] !== value)) {
    throw fail('CONFIGURE_PROJECT_GUARD');
  }
  if (args.length === 2 && args[0] === 'policy' && args[1] === 'required') {
    return { ...config, predeployCloudPolicy: 'required' };
  }
  if (args.length === 3 && args[0] === 'cloud') {
    const [, bucket, kmsKeyId] = args;
    // This tool cannot redirect KTS to another project's bucket or AWS profile.
    if (!cloudTarget(bucket, kmsKeyId) || !auditedCloud(config.cloud)) {
      throw fail('CONFIGURE_CLOUD_GUARD');
    }
    return { ...config, cloud: { ...config.cloud, bucket, kmsKeyId }, cloudApproved: true };
  }
  if (args.length === 3 && args[0] === 'retention' && args[1] === 'count' && args[2] === '5') {
    if (config.cloudApproved !== true || !auditedCloud(config.cloud)
        || !cloudTarget(config.cloud.bucket, config.cloud.kmsKeyId)) {
      throw fail('CONFIGURE_RETENTION_GUARD');
    }
    const retention = { ...config.retention };
    delete retention.cloudDays;
    return {
      ...config,
      retention: { ...retention, localDays: 14, cloudCopies: 5 },
      cloudRetention: {
        mode: 'count', keep: 5, deleteApproved: true,
        profile: config.cloud.profile,
        configFile: config.cloud.configFile,
        credentialsFile: config.cloud.credentialsFile,
      },
    };
  }
  throw fail('CONFIGURE_USAGE');
}

function validatePrivateConfiguration(next, command) {
  if (command !== 'cloud' && command !== 'retention') return;
  const ctx = { config: next, root: ROOT,
    run: () => { throw fail('CONFIGURE_PRIVATE_AWS_INVALID'); } };
  // Validate the existing private uploader profile before enabling any operation.
  try { validateConfiguration(ctx); }
  catch { throw fail('CONFIGURE_PRIVATE_AWS_INVALID'); }
  if (command === 'retention') {
    const r = next.cloudRetention;
    if (r?.mode !== 'count' || r.keep !== 5 || r.deleteApproved !== true
        || next.retention?.localDays !== 14 || next.retention?.cloudCopies !== 5
        || Object.hasOwn(next.retention, 'cloudDays')
        || !['profile', 'configFile', 'credentialsFile'].every((key) => r[key] === next.cloud[key])) {
      throw fail('CONFIGURE_RETENTION_GUARD');
    }
    // The deletion role must use the same dedicated profile, never fresh secrets
    // or ambient AWS credentials. This checks its private files without network.
    try { validateConfiguration({ ...ctx, config: { ...next, cloud: { ...next.cloud,
      profile: r.profile, configFile: r.configFile, credentialsFile: r.credentialsFile } } }); }
    catch { throw fail('CONFIGURE_PRIVATE_AWS_INVALID'); }
  }
}

async function guardedDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o700 || await fs.realpath(directory) !== directory) {
    throw fail('CONFIGURE_PATH_GUARD');
  }
}

async function configure(args = process.argv.slice(2)) {
  process.umask(0o077);
  if (process.getuid() === 0) throw fail('CONFIGURE_PATH_GUARD');
  // No environment-variable/path override is accepted by this commissioning CLI.
  await guardedDirectory(ROOT);
  await guardedDirectory(CONFIG_DIR);
  const marker = path.join(ROOT, '.kts-backup-root');
  await privateFile(marker);
  if ((await fs.readFile(marker, 'utf8')).trim() !== PROJECT) throw fail('CONFIGURE_PROJECT_GUARD');
  await privateFile(CONFIG_FILE);
  if (await fs.realpath(CONFIG_FILE) !== CONFIG_FILE) throw fail('CONFIGURE_PATH_GUARD');
  const original = await fs.readFile(CONFIG_FILE, 'utf8');
  const next = candidate(JSON.parse(original), args);
  validatePrivateConfiguration(next, args[0]);
  await privateFile(CONFIG_FILE);
  if (await fs.readFile(CONFIG_FILE, 'utf8') !== original) throw fail('CONFIGURE_CHANGED');
  await atomicJson(CONFIG_FILE, next);
  await privateFile(CONFIG_FILE);
  return args[0] === 'policy' ? 'Predeploy policy configured: required'
    : args[0] === 'retention' ? 'Cloud count retention configured: 5 copies; local retention: 14 days. Cloud policy and deletion access still require operational verification'
      : 'Cloud configuration enabled after local private-profile validation';
}

if (require.main === module) configure().then((message) => console.log(message)).catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});

module.exports = { configure, candidate, safeError };
