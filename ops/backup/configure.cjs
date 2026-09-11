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
  'CONFIGURE_CLOUD_GUARD', 'CONFIGURE_PRIVATE_AWS_INVALID', 'CONFIGURE_CHANGED',
]);

function fail(code) { const error = new Error(code); error.code = code; return error; }
function safeError(error) { return ERROR_CODES.has(error?.code) ? error.code : 'CONFIGURE_FAILED'; }

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
    if (typeof bucket !== 'string' || bucket.length > 63 || !/^kts-next-admin-backups-[a-z0-9][a-z0-9-]*$/.test(bucket)
        || bucket.endsWith('-') || !/^[a-z0-9]{10,64}$/.test(kmsKeyId)) throw fail('CONFIGURE_CLOUD_GUARD');
    if (!config.cloud || Object.entries(AUDITED_CLOUD).some(([key, value]) => config.cloud[key] !== value)) {
      throw fail('CONFIGURE_CLOUD_GUARD');
    }
    return { ...config, cloud: { ...config.cloud, bucket, kmsKeyId }, cloudApproved: true };
  }
  throw fail('CONFIGURE_USAGE');
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
  if (args[0] === 'cloud') {
    // Validates the existing dedicated profile and static credentials, including
    // 0600 owner checks, before cloudApproved can reach the persistent file.
    try {
      validateConfiguration({ config: next, root: ROOT,
        run: () => { throw fail('CONFIGURE_PRIVATE_AWS_INVALID'); } });
    } catch { throw fail('CONFIGURE_PRIVATE_AWS_INVALID'); }
  }
  await privateFile(CONFIG_FILE);
  if (await fs.readFile(CONFIG_FILE, 'utf8') !== original) throw fail('CONFIGURE_CHANGED');
  await atomicJson(CONFIG_FILE, next);
  await privateFile(CONFIG_FILE);
  return args[0] === 'policy' ? 'Predeploy policy configured: required'
    : 'Cloud configuration enabled after local private-profile validation';
}

if (require.main === module) configure().then((message) => console.log(message)).catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});

module.exports = { configure, candidate, safeError };
