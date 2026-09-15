'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const PROJECT = 'kts-next-admin';
const KEEP = 5;
const MAX_ARTIFACT = 5 * 1024 ** 3;
const MAX_MANIFEST = 20 * 1024 * 1024;
const MAX_STATE = 512 * 1024;
const JOURNAL = 'cloud-prune-in-progress.json';
const HISTORY = 'cloud-prune-history.json';
const ID = /^kts-next-admin-(20\d{6}T\d{6}Z)-[a-f0-9]{4,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function guard(condition, code) {
  if (!condition) throw fail(code);
}

function safeString(value, pattern, maximum = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\0\r\n]/u.test(value) && pattern.test(value);
}

function retentionConfig(ctx) {
  const value = ctx?.config?.cloudRetention;
  if (value === undefined || value === null
      || (typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'mode'))) {
    return null;
  }
  guard(value && typeof value === 'object' && !Array.isArray(value), 'CLOUD_RETENTION_CONFIG');
  guard(value.mode === 'count' && value.keep === KEEP && value.deleteApproved === true,
    'CLOUD_RETENTION_CONFIG');
  guard(safeString(value.profile, /^[A-Za-z0-9_-]{1,64}$/u) && value.profile !== 'default',
    'CLOUD_RETENTION_CONFIG');
  for (const key of ['configFile', 'credentialsFile']) {
    guard(typeof value[key] === 'string' && path.isAbsolute(value[key])
      && path.resolve(value[key]) !== path.parse(path.resolve(value[key])).root
      && !/[\0\r\n]/u.test(value[key]), 'CLOUD_RETENTION_CONFIG');
  }
  return value;
}

async function privateDirectory(directory, code) {
  try {
    const stat = await fs.lstat(directory);
    guard(stat.isDirectory() && !stat.isSymbolicLink(), code);
    if (typeof process.getuid === 'function') guard(stat.uid === process.getuid(), code);
    guard((stat.mode & 0o077) === 0 && await fs.realpath(directory) === path.resolve(directory), code);
  } catch (error) {
    if (error?.code === code) throw error;
    throw fail(code);
  }
}

async function context(ctx, api) {
  const config = retentionConfig(ctx);
  if (!config) return null;
  guard(typeof ctx.root === 'string' && path.isAbsolute(ctx.root)
    && path.resolve(ctx.root) !== path.parse(path.resolve(ctx.root)).root, 'CLOUD_RETENTION_CONTEXT');
  await privateDirectory(ctx.root, 'CLOUD_RETENTION_CONTEXT');
  const state = path.join(ctx.root, 'state');
  await privateDirectory(state, 'CLOUD_RETENTION_CONTEXT');
  guard(api && typeof api === 'object'
    && ['assertPolicy', 'listSets', 'verifySet', 'inspect', 'remove'].every((key) => typeof api[key] === 'function'),
  'CLOUD_RETENTION_ADAPTER');
  const cloud = ctx.config.cloud;
  guard(cloud && api.bucket === cloud.bucket && api.prefix === cloud.prefix && api.kmsKeyId === cloud.kmsKeyId
    && safeString(api.bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u, 63)
    && (api.prefix === '' || safeString(api.prefix, /^(?:[a-z0-9][a-z0-9_-]*\/)+$/u))
    && safeString(api.kmsKeyId, /^[a-z0-9]{10,64}$/u, 64), 'CLOUD_RETENTION_IDENTITY');
  let policy;
  try { policy = await api.assertPolicy(); } catch { throw fail('CLOUD_RETENTION_POLICY'); }
  guard(policy === true, 'CLOUD_RETENTION_POLICY');
  return { config, state, identity: { bucket: api.bucket, prefix: api.prefix, kmsKeyId: api.kmsKeyId } };
}

function descriptor(value, expectedKind, expectedKey, maximum) {
  guard(value && typeof value === 'object' && !Array.isArray(value)
    && value.kind === expectedKind && value.key === expectedKey
    && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= maximum
    && typeof value.sha256 === 'string' && SHA256.test(value.sha256), 'CLOUD_RETENTION_SET');
  return { kind: expectedKind, key: expectedKey, size: value.size, sha256: value.sha256 };
}

function entry(value) {
  guard(value && typeof value === 'object' && !Array.isArray(value), 'CLOUD_RETENTION_SET');
  const manifest = value.manifest;
  guard(manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && manifest.project === PROJECT && typeof manifest.id === 'string', 'CLOUD_RETENTION_SET');
  const match = ID.exec(manifest.id);
  guard(match && typeof manifest.createdAt === 'string'
    && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(manifest.createdAt),
  'CLOUD_RETENTION_SET');
  const created = Date.parse(manifest.createdAt);
  const stamp = Number.isFinite(created)
    ? new Date(created).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z') : '';
  guard(stamp === match[1] && created <= Date.now() + 300_000, 'CLOUD_RETENTION_SET');
  guard(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 3, 'CLOUD_RETENTION_SET');
  const source = new Map();
  for (const artifact of manifest.artifacts) {
    guard(artifact && typeof artifact === 'object' && !source.has(artifact.kind)
      && ['postgres', 'files', 'config'].includes(artifact.kind), 'CLOUD_RETENTION_SET');
    source.set(artifact.kind, artifact);
  }
  const artifacts = ['postgres', 'files', 'config'].map((kind) => descriptor(source.get(kind), kind,
    `${kind}/${manifest.id}.${kind === 'postgres' ? 'dump' : 'tar.gz'}`, MAX_ARTIFACT));
  const manifestDescriptor = descriptor(value.descriptor, 'manifest', `manifests/${manifest.id}.json`, MAX_MANIFEST);
  return {
    manifest: { project: PROJECT, id: manifest.id, createdAt: manifest.createdAt, artifacts },
    descriptor: manifestDescriptor,
  };
}

function newest(a, b) {
  const byTime = Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt);
  return byTime || b.manifest.id.localeCompare(a.manifest.id);
}

function entries(value) {
  guard(Array.isArray(value), 'CLOUD_RETENTION_LIST');
  const result = value.map(entry).sort(newest);
  const ids = new Set();
  const keys = new Set();
  for (const item of result) {
    guard(!ids.has(item.manifest.id), 'CLOUD_RETENTION_DUPLICATE');
    ids.add(item.manifest.id);
    for (const itemDescriptor of descriptors(item)) {
      guard(!keys.has(itemDescriptor.key), 'CLOUD_RETENTION_DUPLICATE');
      keys.add(itemDescriptor.key);
    }
  }
  return result;
}

function descriptors(item) {
  return [item.descriptor, ...item.manifest.artifacts];
}

async function list(api) {
  try { return entries(await api.listSets()); }
  catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('CLOUD_RETENTION_')) throw error;
    throw fail('CLOUD_RETENTION_LIST');
  }
}

async function inspect(api, item) {
  let result;
  try { result = await api.inspect(item); } catch { throw fail('CLOUD_RETENTION_INSPECT'); }
  guard(result === true, 'CLOUD_RETENTION_INSPECT');
}

async function verify(api, keepers) {
  for (const keeper of keepers) {
    let result;
    try { result = await api.verifySet(keeper); } catch { throw fail('CLOUD_RETENTION_VERIFY'); }
    guard(result !== false, 'CLOUD_RETENTION_VERIFY');
  }
}

async function privateJson(filename, code) {
  try {
    const stat = await fs.lstat(filename);
    guard(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_STATE, code);
    if (typeof process.getuid === 'function') guard(stat.uid === process.getuid(), code);
    guard((stat.mode & 0o777) === 0o600, code);
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === code) throw error;
    throw fail(code);
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(state, name, value, code) {
  const destination = path.join(state, name);
  const temporary = path.join(state, `.${name}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, destination);
    await syncDirectory(state);
  } catch {
    throw fail(code);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function journal(value, identity) {
  try {
    guard(value && typeof value === 'object' && !Array.isArray(value)
      && value.version === 1 && value.project === PROJECT && value.keep === KEEP
      && isDeepStrictEqual(value.identity, identity) && Number.isInteger(value.nextIndex)
      && value.nextIndex >= 0 && value.nextIndex <= 4
      && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
      && Date.parse(value.startedAt) <= Date.now() + 300_000
      && Array.isArray(value.keepers) && value.keepers.length === KEEP, 'CLOUD_RETENTION_JOURNAL');
    const keepers = entries(value.keepers);
    const target = entry(value.target);
    guard(!keepers.some((item) => item.manifest.id === target.manifest.id)
      && newest(keepers.at(-1), target) < 0, 'CLOUD_RETENTION_JOURNAL');
    return { ...value, identity: { ...identity }, keepers, target };
  } catch { throw fail('CLOUD_RETENTION_JOURNAL'); }
}

function newJournal(identity, keepers, target) {
  return {
    version: 1, project: PROJECT, keep: KEEP, identity: { ...identity },
    startedAt: new Date().toISOString(), nextIndex: 0, keepers, target,
  };
}

async function appendHistory(setup, record) {
  const filename = path.join(setup.state, HISTORY);
  const saved = await privateJson(filename, 'CLOUD_RETENTION_AUDIT');
  const initial = saved ?? { version: 1, project: PROJECT, identity: setup.identity, entries: [] };
  const ids = new Set();
  guard(initial && initial.version === 1 && initial.project === PROJECT
    && isDeepStrictEqual(initial.identity, setup.identity) && Array.isArray(initial.entries)
    && initial.entries.length <= 64 && initial.entries.every((item) => item && typeof item === 'object'
      && ID.test(item.id) && !ids.has(item.id) && ids.add(item.id)
      && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
      && typeof item.completedAt === 'string' && Number.isFinite(Date.parse(item.completedAt))
      && item.objects === 4 && Number.isSafeInteger(item.bytes) && item.bytes > 0),
  'CLOUD_RETENTION_AUDIT');
  if (!initial.entries.some((item) => item.id === record.target.manifest.id)) {
    initial.entries.push({ id: record.target.manifest.id, createdAt: record.target.manifest.createdAt,
      completedAt: new Date().toISOString(), objects: 4,
      bytes: descriptors(record.target).reduce((sum, item) => sum + item.size, 0) });
  }
  initial.entries = initial.entries.slice(-64);
  await atomicJson(setup.state, HISTORY, initial, 'CLOUD_RETENTION_AUDIT');
}

async function finish(api, setup, value) {
  let record = journal(value, setup.identity);
  const filename = path.join(setup.state, JOURNAL);
  const targets = descriptors(record.target);
  // Replay already completed positions too: idempotent remove() confirms they
  // are still absent if a crash happened after DELETE or an operator interfered.
  for (let index = 0; index < targets.length; index += 1) {
    try { await api.remove(targets[index]); } catch { throw fail('CLOUD_RETENTION_DELETE'); }
    if (index >= record.nextIndex) {
      record = { ...record, nextIndex: index + 1 };
      await atomicJson(setup.state, JOURNAL, record, 'CLOUD_RETENTION_JOURNAL');
    }
  }
  await appendHistory(setup, record);
  try { await fs.unlink(filename); await syncDirectory(setup.state); }
  catch { throw fail('CLOUD_RETENTION_JOURNAL'); }
  return record.target.manifest.id;
}

async function recover(api, setup, saved) {
  const record = journal(saved, setup.identity);
  const remote = await list(api);
  const byId = new Map(remote.map((item) => [item.manifest.id, item]));
  for (const keeper of record.keepers) {
    guard(byId.has(keeper.manifest.id)
      && isDeepStrictEqual(byId.get(keeper.manifest.id), keeper), 'CLOUD_RETENTION_KEEPERS');
  }
  const listedTarget = byId.get(record.target.manifest.id);
  guard(!listedTarget || isDeepStrictEqual(listedTarget, record.target), 'CLOUD_RETENTION_JOURNAL');
  await verify(api, record.keepers);
  return finish(api, setup, record);
}

async function prune(ctx, api) {
  const setup = await context(ctx, api);
  if (!setup) return { enabled: false, mode: 'legacy', keep: KEEP, total: 0, deleted: 0, recovered: 0 };
  const journalFile = path.join(setup.state, JOURNAL);
  const saved = await privateJson(journalFile, 'CLOUD_RETENTION_JOURNAL');
  let deleted = 0;
  let recovered = 0;
  if (saved) { await recover(api, setup, saved); deleted += 1; recovered = 1; }
  const remote = await list(api);
  if (remote.length <= KEEP) {
    return { enabled: true, mode: 'count', keep: KEEP, total: remote.length, deleted, recovered };
  }
  const keepers = remote.slice(0, KEEP);
  await verify(api, keepers);
  const candidates = remote.slice(KEEP).reverse();
  for (const target of candidates) {
    guard(target.manifest.id !== remote[0].manifest.id
      && !keepers.some((item) => item.manifest.id === target.manifest.id), 'CLOUD_RETENTION_KEEPERS');
    await inspect(api, target);
    const record = newJournal(setup.identity, keepers, target);
    await atomicJson(setup.state, JOURNAL, record, 'CLOUD_RETENTION_JOURNAL');
    await finish(api, setup, record);
    deleted += 1;
  }
  return { enabled: true, mode: 'count', keep: KEEP, total: remote.length - candidates.length, deleted, recovered };
}

async function health(ctx, api) {
  const setup = await context(ctx, api);
  if (!setup) return { enabled: false, mode: 'legacy', keep: KEEP, completeSets: 0, objects: 0, pending: false };
  const saved = await privateJson(path.join(setup.state, JOURNAL), 'CLOUD_RETENTION_JOURNAL');
  guard(!saved, 'CLOUD_RETENTION_PENDING');
  const remote = await list(api);
  guard(remote.length <= KEEP, 'CLOUD_RETENTION_COUNT');
  for (const item of remote) await inspect(api, item);
  return { enabled: true, mode: 'count', keep: KEEP, completeSets: remote.length,
    objects: remote.length * 4, pending: false };
}

module.exports = { prune, health };
