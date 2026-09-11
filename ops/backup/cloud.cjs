'use strict';

// Cloud credentials never leave their private files. No AWS command uses a
// shell, ambient AWS credentials, --debug, or a deletion operation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const PROJECT = 'kts-next-admin';
const ID_RE = /^kts-next-admin-20\d{6}T\d{6}Z-[a-f0-9]{4,64}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_MANIFEST = 20 * 1024 * 1024;
const MAX_SINGLE_UPLOAD = 5 * 1024 ** 3;
const UID = typeof process.getuid === 'function' ? process.getuid() : null;

function fail(message) {
  throw new Error(`Backup cloud: ${message}`);
}

function privateDirectory(directory, create = false) {
  if (!path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root) {
    fail('a private absolute directory is required');
  }
  if (create) fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== UID || (stat.mode & 0o077)) {
    fail('directory must be owned by the current user with mode 700');
  }
  if (fs.realpathSync(directory) !== path.resolve(directory)) fail('symlinked directory is not allowed');
  return directory;
}

function privateFile(filename, maximum = Number.MAX_SAFE_INTEGER) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== UID || (stat.mode & 0o777) !== 0o600) {
    fail('file must be regular, owned by the current user, and mode 600');
  }
  if (stat.size <= 0 || stat.size > maximum) fail('file size is outside its allowed bounds');
  return stat;
}

function ini(filename, section, allowed) {
  privateFile(filename, 64 * 1024);
  const values = new Map();
  let current = '';
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      if (header[1] !== section || current) fail('AWS files must contain only the dedicated profile');
      current = header[1];
      continue;
    }
    const assignment = /^\s*([a-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!current || !assignment || !allowed.has(assignment[1]) || values.has(assignment[1])) {
      fail('AWS profile contains an unsupported or repeated setting');
    }
    values.set(assignment[1], assignment[2]);
  }
  return values;
}

function setup(ctx) {
  if (ctx.config.cloudApproved !== true) fail('cloud operation has not been approved');
  const c = ctx.config.cloud;
  if (!c || c.endpoint !== 'https://storage.yandexcloud.net' || c.region !== 'ru-central1') {
    fail('the approved Yandex endpoint and region are required');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket || '') || /\.\./.test(c.bucket)) {
    fail('invalid dedicated bucket name');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(c.profile || '') || c.profile === 'default') {
    fail('a separate named AWS profile is required');
  }
  if (!/^[a-z0-9]{10,64}$/.test(c.kmsKeyId || '')) fail('invalid dedicated KMS key ID');
  if (typeof c.prefix !== 'string' || (c.prefix && !/^(?:[a-z0-9][a-z0-9_-]*\/)+$/.test(c.prefix))) {
    fail('prefix must be empty or a safe relative prefix ending with /');
  }
  for (const setting of ['awsBin', 'configFile', 'credentialsFile']) {
    if (typeof c[setting] !== 'string' || !path.isAbsolute(c[setting]) || /[\0\r\n]/.test(c[setting])) {
      fail('AWS executable and credential paths must be absolute');
    }
  }
  privateDirectory(ctx.root);
  for (const file of [c.configFile, c.credentialsFile]) {
    if (fs.realpathSync(file) !== path.resolve(file)) fail('symlinked AWS config is not allowed');
  }
  const credentials = ini(c.credentialsFile, c.profile, new Set(['aws_access_key_id', 'aws_secret_access_key']));
  if (!credentials.get('aws_access_key_id') || !credentials.get('aws_secret_access_key')) {
    fail('the dedicated static credentials are incomplete');
  }
  const settings = ini(c.configFile, `profile ${c.profile}`, new Set([
    'region', 'output', 'endpoint_url', 'retry_mode', 'max_attempts', 's3',
    'signature_version', 'addressing_style', 'max_concurrent_requests',
    'multipart_threshold', 'multipart_chunksize', 'payload_signing_enabled',
    'preferred_transfer_client', 'request_checksum_calculation', 'response_checksum_validation',
  ]));
  if (settings.get('region') !== c.region ||
      (settings.has('endpoint_url') && settings.get('endpoint_url') !== c.endpoint)) {
    fail('AWS profile endpoint or region differs from the approved configuration');
  }
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    AWS_CONFIG_FILE: c.configFile, AWS_SHARED_CREDENTIALS_FILE: c.credentialsFile,
    AWS_PROFILE: c.profile, AWS_DEFAULT_PROFILE: c.profile,
    AWS_REGION: c.region, AWS_DEFAULT_REGION: c.region,
    AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off',
    AWS_RETRY_MODE: 'standard', AWS_MAX_ATTEMPTS: '3',
    // Yandex documents Content-MD5, not AWS's newer flexible checksums.
    // Actual downloaded bytes are independently checked with SHA-256 below.
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
  };
  return {
    c,
    async aws(args, transfer = false) {
      const result = await ctx.run(c.awsBin, [
        '--profile', c.profile, '--endpoint-url', c.endpoint, '--region', c.region,
        '--output', 'json', '--cli-connect-timeout', '20', '--cli-read-timeout', '120',
        's3api', ...args,
      ], { env, timeout: transfer ? 900_000 : 300_000 });
      try { return JSON.parse(result.stdout || '{}'); }
      catch { fail('AWS returned invalid JSON'); }
    },
    key(key) { return c.prefix + key; },
  };
}

function validateManifest(manifest) {
  if (!manifest || manifest.project !== PROJECT || !ID_RE.test(manifest.id || '') ||
      !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 3) {
    fail('invalid project backup manifest');
  }
  const found = new Set();
  for (const a of manifest.artifacts) {
    if (!a || !['postgres', 'files', 'config'].includes(a.kind) || found.has(a.kind)) {
      fail('manifest must contain exactly one database, files, and config archive');
    }
    found.add(a.kind);
    const expected = `${a.kind}/${manifest.id}.${a.kind === 'postgres' ? 'dump' : 'tar.gz'}`;
    if (a.key !== expected || !Number.isSafeInteger(a.size) || a.size <= 0 ||
        a.size > MAX_SINGLE_UPLOAD || !HASH_RE.test(a.sha256 || '')) {
      fail('invalid archive key, size, or checksum');
    }
  }
  return manifest;
}

function localPath(root, key) {
  // All callers first validate the manifest or construct this key internally.
  if (!/^(postgres|files|config|manifests|receipts)\/[^/]+$/.test(key) || key.includes('..')) {
    fail('unsafe backup file key');
  }
  const filename = path.join(root, key);
  privateDirectory(path.dirname(filename));
  return filename;
}

async function digest(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function localManifest(root, manifest) {
  validateManifest(manifest);
  const key = `manifests/${manifest.id}.json`;
  const filename = localPath(root, key);
  const stat = privateFile(filename, MAX_MANIFEST);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { fail('local manifest is not valid JSON'); }
  if (!isDeepStrictEqual(parsed, manifest)) fail('local manifest differs from requested backup');
  return { kind: 'manifest', key, size: stat.size, sha256: await digest(filename) };
}

async function head(api, key) {
  // A failed HEAD is NOT interpreted as "missing": AccessDenied, network
  // errors, and 404 would otherwise all risk an unsafe overwrite.
  const full = api.key(key);
  const listed = await api.aws(['list-objects-v2', '--bucket', api.c.bucket,
    '--prefix', full, '--max-keys', '1', '--no-paginate']);
  if (!Array.isArray(listed.Contents) || !listed.Contents.some((o) => o.Key === full)) return null;
  return api.aws(['head-object', '--bucket', api.c.bucket, '--key', full]);
}

function sha256Metadata(info) {
  // S3 metadata names are case-insensitive; Yandex may return "Sha256".
  // Reject ambiguous aliases instead of choosing one of multiple values.
  const checksums = info?.Metadata && typeof info.Metadata === 'object' && !Array.isArray(info.Metadata)
    ? Object.entries(info.Metadata).filter(([name]) => name.toLowerCase() === 'sha256') : [];
  return checksums.length === 1 && typeof checksums[0][1] === 'string' && HASH_RE.test(checksums[0][1])
    ? checksums[0][1] : undefined;
}

function checkHead(api, info, artifact) {
  if (!info || info.ContentLength !== artifact.size || sha256Metadata(info) !== artifact.sha256 ||
      info.ServerSideEncryption !== 'aws:kms' || info.SSEKMSKeyId !== api.c.kmsKeyId ||
      typeof info.ETag !== 'string' || !info.ETag) {
    fail('cloud object size, SHA-256 metadata, or encryption does not match');
  }
}

function space(directory, bytes, config) {
  if (typeof fs.statfsSync !== 'function') fail('Node.js with statfs support is required');
  const stat = fs.statfsSync(directory, { bigint: true });
  const reserve = Number.isSafeInteger(config.minFreeBytes) && config.minFreeBytes >= 0
    ? config.minFreeBytes : 2 * 1024 ** 3;
  if (stat.bavail * stat.bsize < BigInt(bytes) + BigInt(reserve)) {
    fail('insufficient free space for a verified download and disk reserve');
  }
}

async function downloaded(ctx, api, descriptor, info, workRoot, saveRoot) {
  checkHead(api, info, descriptor);
  privateDirectory(workRoot);
  space(workRoot, descriptor.size, ctx.config);
  const temporary = fs.mkdtempSync(path.join(workRoot, '.cloud-download-'));
  fs.chmodSync(temporary, 0o700);
  const filename = path.join(temporary, 'object.part');
  const handle = fs.openSync(filename, 'wx', 0o600);
  fs.closeSync(handle);
  try {
    // ETag is used only as a concurrency/version guard, never as a checksum.
    await api.aws(['get-object', '--bucket', api.c.bucket, '--key', api.key(descriptor.key),
      '--if-match', info.ETag, filename], true);
    privateFile(filename, descriptor.size);
    if (fs.statSync(filename).size !== descriptor.size || await digest(filename) !== descriptor.sha256) {
      fail('downloaded cloud bytes failed size or SHA-256 verification');
    }
    if (saveRoot) {
      privateDirectory(path.join(saveRoot, descriptor.key.split('/')[0]), true);
      const target = localPath(saveRoot, descriptor.key);
      try { fs.linkSync(filename, target); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const current = privateFile(target, descriptor.size);
        if (current.size !== descriptor.size || await digest(target) !== descriptor.sha256) {
          fail('destination already contains different data; it was not overwritten');
        }
      }
    }
    return descriptor.kind === 'manifest' ? fs.readFileSync(filename, 'utf8') : undefined;
  } finally {
    // Only the exact file and directory created by this invocation are removed.
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    fs.rmdirSync(temporary);
  }
}

async function ensureUploaded(ctx, api, descriptor) {
  const filename = localPath(ctx.root, descriptor.key);
  const stat = privateFile(filename, descriptor.kind === 'manifest' ? MAX_MANIFEST : MAX_SINGLE_UPLOAD);
  if (stat.size !== descriptor.size || await digest(filename) !== descriptor.sha256) {
    fail('local archive failed size or SHA-256 verification');
  }
  let info = await head(api, descriptor.key);
  if (info) {
    checkHead(api, info, descriptor); // Existing mismatched object is NEVER overwritten.
  } else {
    // Use Yandex's documented bucket-default KMS path. On this bucket the
    // least-privilege uploader can use default encryption, while explicitly
    // setting SSE request headers returns AccessDenied. Never fall back to
    // an unverified/unencrypted bucket or change its configuration here.
    const encryption = await api.aws(['get-bucket-encryption', '--bucket', api.c.bucket]);
    const rules = encryption?.ServerSideEncryptionConfiguration?.Rules;
    const defaults = Array.isArray(rules) && rules.length === 1
      ? rules[0]?.ApplyServerSideEncryptionByDefault : null;
    if (defaults?.SSEAlgorithm !== 'aws:kms' || defaults.KMSMasterKeyID !== api.c.kmsKeyId) {
      fail('bucket default KMS encryption does not match; nothing uploaded');
    }
    // Conditional single-part upload avoids the LIST/PUT overwrite race. It
    // supports archives up to 5 GiB; larger ones fail explicitly in validation.
    // Only a bucket administrator can change encryption between this check
    // and PUT. Keep that configuration stable; HEAD below checks the actual
    // object's algorithm and exact key before downloading or committing it.
    await api.aws(['put-object', '--bucket', api.c.bucket, '--key', api.key(descriptor.key),
      '--body', filename, '--if-none-match', '*', '--storage-class', 'STANDARD',
      '--metadata', `sha256=${descriptor.sha256}`], true);
    info = await head(api, descriptor.key);
  }
  await downloaded(ctx, api, descriptor, info, ctx.root);
}

function readReceipt(ctx, manifest, descriptor) {
  const directory = path.join(ctx.root, 'receipts');
  try { privateDirectory(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const filename = localPath(ctx.root, `receipts/${manifest.id}.json`);
  try { privateFile(filename, MAX_MANIFEST); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let saved;
  try { saved = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { fail('saved cloud receipt is invalid; backup remains unconfirmed'); }
  const expectedArtifacts = manifest.artifacts.map(({ kind, key, size, sha256 }) => ({ kind, key, size, sha256 }));
  const c = ctx.config.cloud;
  if (!c || !saved || typeof saved !== 'object' || saved.project !== PROJECT || saved.id !== manifest.id ||
      saved.bucket !== c.bucket || saved.prefix !== c.prefix || saved.kmsKeyId !== c.kmsKeyId ||
      saved.manifestSha256 !== descriptor.sha256 || saved.verification !== 'full-download-sha256' ||
      typeof saved.verifiedAt !== 'string' || !Number.isFinite(Date.parse(saved.verifiedAt)) ||
      Date.parse(saved.verifiedAt) > Date.now() + 300_000 ||
      !isDeepStrictEqual(saved.artifacts, expectedArtifacts)) {
    fail('saved cloud receipt does not match this backup and cloud configuration');
  }
  if (saved.firstVerifiedAt !== undefined &&
      (!Number.isFinite(Date.parse(saved.firstVerifiedAt)) ||
        Date.parse(saved.firstVerifiedAt) > Date.parse(saved.verifiedAt))) {
    fail('saved cloud receipt has inconsistent verification timestamps');
  }
  return saved;
}

// A receipt proves a completed transfer at a recorded time. It does NOT claim
// that a lifecycle-expired cloud object still exists. Local retention uses this
// historical proof; health monitoring must always call verify() on the newest.
async function validReceipt(ctx, manifest) {
  privateDirectory(ctx.root);
  return readReceipt(ctx, manifest, await localManifest(ctx.root, manifest)) !== null;
}

function receipt(ctx, api, manifest, descriptor) {
  privateDirectory(path.join(ctx.root, 'receipts'), true);
  const previous = readReceipt(ctx, manifest, descriptor);
  const destination = localPath(ctx.root, `receipts/${manifest.id}.json`);
  const temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.part`;
  const verifiedAt = new Date().toISOString();
  const result = {
    project: PROJECT, id: manifest.id, verifiedAt,
    firstVerifiedAt: previous?.firstVerifiedAt || previous?.verifiedAt || verifiedAt,
    bucket: api.c.bucket, prefix: api.c.prefix, kmsKeyId: api.c.kmsKeyId,
    manifestSha256: descriptor.sha256, verification: 'full-download-sha256',
    artifacts: manifest.artifacts.map(({ kind, key, size, sha256 }) => ({ kind, key, size, sha256 })),
  };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(destination)) privateFile(destination, MAX_MANIFEST);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return result;
}

async function sync(ctx, manifests) {
  const api = setup(ctx);
  if (!Array.isArray(manifests)) fail('sync requires a list of complete manifests');
  // run.sh holds both .operation.lock and the separate .upload.lock with
  // kernel flock for this entire operation, including all awaits and retries.
  const results = [];
  // Process the newest first so a failed historical backlog cannot prevent a
  // fresh set from reaching the cloud. Never silently discard unsent old sets.
  const ordered = [...manifests].map(validateManifest).sort((a, b) => b.id.localeCompare(a.id));
  for (const [index, manifest] of ordered.entries()) {
    const descriptor = await localManifest(ctx.root, manifest);
    const saved = readReceipt(ctx, manifest, descriptor);
    if (saved) {
      if (index === 0) {
        // This is verify-only: expiry, missing bytes, and corruption are errors,
        // never a reason to upload old data again and reset its lifecycle age.
        results.push(await verify(ctx, manifest));
      } else {
        // Cloud retention is 5 days while local retention is 14 days. Historical
        // confirmed copies may have legitimately expired; do not HEAD/recreate.
        results.push(saved);
        if (ctx.log) ctx.log(`Historical cloud receipt confirmed: ${manifest.id}`);
      }
      continue;
    }
    for (const artifact of manifest.artifacts) await ensureUploaded(ctx, api, artifact);
    // The manifest is the cloud commit marker: it appears only after all
    // archive downloads have passed verification, and is itself verified.
    await ensureUploaded(ctx, api, descriptor);
    results.push(receipt(ctx, api, manifest, descriptor));
    if (ctx.log) ctx.log(`Cloud backup verified: ${manifest.id}`);
  }
  return results;
}

async function verify(ctx, manifest, { downloadRoot } = {}) {
  const api = setup(ctx);
  const descriptor = await localManifest(ctx.root, manifest);
  readReceipt(ctx, manifest, descriptor); // Fail closed on mismatched local proof.
  const workRoot = downloadRoot ? privateDirectory(downloadRoot, true) : ctx.root;
  for (const artifact of manifest.artifacts) {
    await downloaded(ctx, api, artifact, await head(api, artifact.key), workRoot, downloadRoot);
  }
  const raw = await downloaded(ctx, api, descriptor, await head(api, descriptor.key), workRoot, downloadRoot);
  if (!isDeepStrictEqual(JSON.parse(raw), manifest)) fail('cloud manifest differs from local manifest');
  // Runtime checks object SSE/KMS. Public access, lifecycle, and IAM policy
  // audits belong to the operator/control-plane account, not this data writer.
  return receipt(ctx, api, manifest, descriptor);
}

async function downloadLatest(ctx, destRoot) {
  const api = setup(ctx);
  privateDirectory(destRoot, true);
  const prefix = api.key('manifests/');
  let token;
  let keys = [];
  do {
    const args = ['list-objects-v2', '--bucket', api.c.bucket, '--prefix', prefix,
      '--max-keys', '1000', '--no-paginate'];
    if (token) args.push('--continuation-token', token);
    const result = await api.aws(args);
    keys.push(...(result.Contents || []).filter((o) => {
      const name = typeof o.Key === 'string' && o.Key.startsWith(prefix) ? o.Key.slice(prefix.length) : '';
      return name.endsWith('.json') && ID_RE.test(name.slice(0, -5));
    }).map((o) => o.Key));
    if (keys.length > 10_000) fail('unexpectedly many cloud manifests');
    const next = result.IsTruncated ? result.NextContinuationToken : undefined;
    if (result.IsTruncated && (typeof next !== 'string' || next === token)) fail('invalid cloud listing pagination');
    token = next;
  } while (token);
  if (!keys.length) fail('no committed cloud backup exists');
  keys = keys.sort();
  const key = keys[keys.length - 1].slice(api.c.prefix.length);
  const info = await head(api, key);
  const checksum = sha256Metadata(info);
  if (!info || !Number.isSafeInteger(info.ContentLength) || info.ContentLength <= 0 ||
      info.ContentLength > MAX_MANIFEST || !checksum) {
    fail('latest cloud manifest has invalid size or checksum metadata');
  }
  const descriptor = { kind: 'manifest', key, size: info.ContentLength, sha256: checksum };
  const raw = await downloaded(ctx, api, descriptor, info, destRoot);
  let manifest;
  try { manifest = validateManifest(JSON.parse(raw)); }
  catch { fail('latest cloud manifest has an invalid schema'); }
  if (key !== `manifests/${manifest.id}.json`) fail('cloud manifest ID does not match its object key');
  // Validate schema before saving or downloading paths from cloud JSON.
  for (const artifact of manifest.artifacts) {
    await downloaded(ctx, api, artifact, await head(api, artifact.key), destRoot, destRoot);
  }
  // Download the commit marker once again with its original ETag; if another
  // writer replaced it during the operation, this restoration fails closed.
  await downloaded(ctx, api, descriptor, info, destRoot, destRoot);
  if (ctx.log) ctx.log(`Cloud restore set downloaded and verified: ${manifest.id}`);
  return manifest;
}

// Commissioning validates private static credentials and configuration locally;
// this deliberately never invokes the returned AWS command runner.
function validateConfiguration(ctx) { setup(ctx); return true; }

module.exports = { sync, verify, downloadLatest, validReceipt, validateConfiguration };
