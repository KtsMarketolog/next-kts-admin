'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const cli = require('../cli.cjs');
const common = require('../common.cjs');
const cloud = require('../cloud.cjs');
const DAY = 86400000;
const ID = 'kts-next-admin-20260912T120000Z-abcdef';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kts-cli-test-')));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['state', '.work', '.restore', 'manifests', 'receipts', 'postgres', 'files', 'config']) {
    await fs.mkdir(path.join(root, dir), { mode: 0o700 });
  }
  return { root, write: (name, value) => fs.writeFile(path.join(root, 'state', name + '.json'), JSON.stringify(value), { mode: 0o600 }) };
}

function cloudSuccess(now = Date.now()) {
  return { ok: true, origin: 'yandex', id: ID, at: new Date(now).toISOString(), report: {
    project: 'kts-next-admin', source: 'yandex-object-storage', id: ID,
    restoredAt: new Date(now - DAY).toISOString(), tables: 42, schemaFingerprint: 'a'.repeat(64),
    artifacts: ['postgres', 'files', 'config'].map((kind) => ({ kind, size: 100, sha256: 'b'.repeat(64) })),
  } };
}

async function loadWith(commonMock, cloudMock, captureMock, now, fsMock) {
  const code = await fs.readFile(path.join(__dirname, '../cli.cjs'), 'utf8');
  const moduleObject = { exports: {} };
  const req = (name) => name === './common.cjs' ? {...common,...commonMock} : name === './cloud.cjs' ? cloudMock
    : name === './capture.cjs' ? captureMock : name === 'node:fs/promises' && fsMock ? fsMock : require(name);
  const Clock = now === undefined ? Date : class extends Date { static now() { return now; } };
  vm.runInNewContext(code, { require: req, module: moduleObject, process, Date: Clock }, { filename: 'cli.cjs' });
  return moduleObject.exports;
}

test('commissioning is explicit: missing/local-only restore cannot pass cloud health', async (t) => {
  const f = await fixture(t);
  await assert.rejects(cli.restoreHealth(f), { code: 'INITIAL_CLOUD_RESTORE_REQUIRED' });
  await f.write('restore', { ok: true, origin: 'local' });
  await assert.rejects(cli.restoreHealth(f), { code: 'INITIAL_CLOUD_RESTORE_REQUIRED' });
});

test('valid cloud restore passes; legacy cloud state remains compatible', async (t) => {
  const f = await fixture(t), now = Date.now(), result = cloudSuccess(now);
  await f.write('restore', result);
  assert.equal((await cli.restoreHealth(f, now)).id, ID);
  await f.write('restore-cloud', result);
  await f.write('restore', { ok: false, origin: 'local' });
  assert.equal((await cli.restoreHealth(f, now)).id, ID);
});

test('last failed cloud attempt overrides previous successful legacy proof', async (t) => {
  const f = await fixture(t);
  await f.write('restore', cloudSuccess());
  await f.write('restore-cloud', { ok: false, origin: 'yandex', phase: 'download-failed' });
  await assert.rejects(cli.restoreHealth(f), { code: 'CLOUD_RESTORE_FAILED' });
});

test('freshness uses real restore time; refreshing state cannot extend eight days', async (t) => {
  const f = await fixture(t), now = Date.now(), result = cloudSuccess(now);
  result.report.restoredAt = new Date(now - 9 * DAY).toISOString();
  await f.write('restore-cloud', result);
  await assert.rejects(cli.restoreHealth(f, now), { code: 'CLOUD_RESTORE_STALE' });
  result.report.restoredAt = new Date(now - 8 * DAY).toISOString();
  await f.write('restore-cloud', result);
  assert.equal((await cli.restoreHealth(f, now)).id, ID);
});

test('cloud health rejects wrong source, invalid checksum and future restore', async (t) => {
  const f = await fixture(t), now = Date.now();
  for (const mutate of [
    (r) => { r.report.source = 'local-backup'; },
    (r) => { r.report.artifacts[0].sha256 = 'invalid'; },
    (r) => { r.report.restoredAt = new Date(now + 10 * 60000).toISOString(); },
  ]) {
    const result = cloudSuccess(now); mutate(result); await f.write('restore-cloud', result);
    await assert.rejects(cli.restoreHealth(f, now), { code: 'CLOUD_RESTORE_STATE_INVALID' });
  }
});

test('monitor detects abandoned cloud-download directories at backup root', async (t) => {
  const f = await fixture(t), now = Date.now();
  await cli.staleTemporary(f, now);
  const target = path.join(f.root, '.cloud-download-fixture');
  await fs.mkdir(target);
  await fs.utimes(target, new Date(now - 3 * 3600000), new Date(now - 3 * 3600000));
  await assert.rejects(cli.staleTemporary(f, now), { code: 'STALE_TEMP' });
  await fs.rmdir(target);
  const partial = path.join(f.root, 'receipts', 'fixture.part');
  await fs.writeFile(partial, 'fixture', { mode: 0o600 });
  await fs.utimes(partial, new Date(now - 3 * 3600000), new Date(now - 3 * 3600000));
  await assert.rejects(cli.staleTemporary(f, now), { code: 'STALE_TEMP' });
});

test('logs allow only fixed codes, never dependency messages or arbitrary codes', () => {
  for (const error of [new Error('SECRET_TOKEN plaintext'),
    Object.assign(new Error('SECRET_TOKEN'), { code: 'SECRET_TOKEN' }),
    Object.assign(new Error('SECRET_TOKEN'), { code: 'ENOENT' }),
    Object.assign(new Error('SECRET_TOKEN'), { code: 'CLOUD_RESTORE_FAILED' })]) {
    assert.ok(!cli.safeError(error).includes('SECRET_TOKEN'));
  }
  assert.match(cli.safeError({ code: 'RESTORE_SCHEMA_MISMATCH' }), /RESTORE_SCHEMA_MISMATCH/);
});

async function policyCase(t, policy, captureFails, cloudFails, oldUnsent = false) {
  const f = await fixture(t), logs = [], states = [], calls = { capture: 0, cloud: 0 };
  const newest = { id: ID, createdAt: new Date().toISOString(), artifacts: [] };
  const old = { id: 'old', createdAt: new Date(Date.now() - 16 * DAY).toISOString(), artifacts: [] };
  const api = await loadWith({
    context: async () => ({ root: f.root, config: { predeployCloudPolicy: policy } }), capacity: async () => {},
    manifests: async () => oldUnsent ? [old, newest] : [newest], verifyLocal: async () => {}, privateFile: common.privateFile,
    atomicJson: async (filename, value) => states.push([filename, value]), log: (message) => logs.push(message), ID: common.ID,
  }, {
    sync: async () => { calls.cloud++; if (cloudFails) throw new Error('SECRET_TOKEN'); }, validReceipt: async () => false,
  }, { capture: async () => { calls.capture++; if (captureFails) throw new Error('SECRET_TOKEN'); return newest; } });
  let error;
  try { await api.main('predeploy'); } catch (caught) { error = caught; }
  return { error, logs, states, calls };
}

test('pending policy stops before capture; required cloud failure stops deploy', async (t) => {
  const pending = await policyCase(t, 'pending', false, false);
  assert.equal(pending.error.code, 'PREDEPLOY_POLICY_PENDING'); assert.equal(pending.calls.capture, 0);
  const required = await policyCase(t, 'required', false, true);
  assert.ok(required.error); assert.equal(required.calls.capture, 1);
  assert.ok(required.states.some(([name, value]) => name.endsWith('cloud.json') && value.ok === false));
});

test('local capture failure stops both required and warn policies before cloud', async (t) => {
  for (const policy of ['required', 'warn']) {
    const result = await policyCase(t, policy, true, false);
    assert.ok(result.error); assert.equal(result.calls.cloud, 0);
  }
});

test('agreed warn policy permits local-only deployment while retaining unsent history', async (t) => {
  const result = await policyCase(t, 'warn', false, true, true);
  assert.equal(result.error, undefined);
  assert.ok(result.logs.some((line) => line.includes('retained')));
  assert.ok(result.logs.every((line) => !line.includes('SECRET_TOKEN')));
  assert.equal((await policyCase(t, 'required', false, false)).error, undefined);
});

test('exact 14-day pruning validates historical receipt and preserves newest/unconfirmed', async (t) => {
  const f = await fixture(t), now = Date.now(), all = [];
  const config = { cloud: { bucket: 'kts-test-backup', prefix: '', kmsKeyId: 'test-key' } };
  const ctx = { root: f.root, config };
  let sequence = 0;
  async function make(age, confirmed) {
    const createdAt = new Date(now - age).toISOString();
    const utc = createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const id = 'kts-next-admin-' + utc + '-' + (++sequence).toString(16).padStart(6, '0');
    const artifacts = [];
    for (const kind of ['postgres', 'files', 'config']) {
      const key = kind + '/' + id + (kind === 'postgres' ? '.dump' : '.tar.gz'), data = Buffer.from('fixture');
      await fs.writeFile(path.join(f.root, key), data, { mode: 0o600 });
      artifacts.push({ kind, key, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
    }
    const manifest = { project: 'kts-next-admin', id, createdAt, artifacts }, bytes = JSON.stringify(manifest);
    await fs.writeFile(path.join(f.root, 'manifests', id + '.json'), bytes, { mode: 0o600 });
    const receipt = { project: manifest.project, id, verifiedAt: createdAt, ...config.cloud,
      manifestSha256: crypto.createHash('sha256').update(bytes).digest('hex'), verification: 'full-download-sha256', artifacts };
    if (!confirmed) receipt.bucket = 'wrong-bucket';
    await fs.writeFile(path.join(f.root, 'receipts', id + '.json'), JSON.stringify(receipt), { mode: 0o600 });
    all.push(manifest); return manifest;
  }
  const expired = await make(16 * DAY, true), invalid = await make(15 * DAY, false);
  const justExpired = await make(14 * DAY + 1, true), boundary = await make(14 * DAY, true);
  const younger = await make(13 * DAY, true), newest = await make(DAY, true);
  all.sort((a, b) => a.id.localeCompare(b.id));
  let verified;
  const api = await loadWith({ manifests: async () => all, verifyLocal: async (_, m) => { verified = m.id; },
    privateFile: common.privateFile, log: () => {} }, cloud, {}, now);
  await assert.rejects(api.prune(ctx), { code: 'PRUNE_UNCONFIRMED' });
  assert.equal(verified, newest.id);
  for (const manifest of [expired, justExpired]) await assert.rejects(fs.stat(path.join(f.root, 'manifests', manifest.id + '.json')), { code: 'ENOENT' });
  for (const manifest of [invalid, boundary, younger, newest]) {
    assert.ok((await fs.stat(path.join(f.root, 'manifests', manifest.id + '.json'))).isFile());
    for (const artifact of manifest.artifacts) assert.ok((await fs.stat(path.join(f.root, artifact.key))).isFile());
  }
});

async function retentionScenario(t) {
  const f = await fixture(t), now = Date.now();
  async function make(age, suffix) {
    const createdAt = new Date(now-age).toISOString();
    const id = 'kts-next-admin-'+createdAt.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')+'-'+suffix;
    const artifacts = [];
    for(const kind of ['postgres','files','config']) {
      const key = kind+'/'+id+(kind === 'postgres'?'.dump':'.tar.gz');
      const data = Buffer.from('fixture '+id+' '+kind);
      await fs.writeFile(path.join(f.root,key),data,{mode:0o600});
      artifacts.push({kind,key,size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});
    }
    const manifest = {project:'kts-next-admin',id,createdAt,artifacts};
    await fs.writeFile(path.join(f.root,'manifests',id+'.json'),JSON.stringify(manifest),{mode:0o600});
    await fs.writeFile(path.join(f.root,'receipts',id+'.json'),JSON.stringify({id,confirmed:true}),{mode:0o600});
    return manifest;
  }
  const expired = await make(16*DAY,'aaaaaa'), newest = await make(DAY,'bbbbbb');
  const ctx = {root:f.root};
  const mocks = {log:()=>{},verifyLocal:async (_,manifest)=>{
    for(const artifact of manifest.artifacts) {
      await common.privateFile(path.join(f.root,artifact.key));
      assert.equal(await common.digest(path.join(f.root,artifact.key)),artifact.sha256);
    }
  }};
  const cloudMock = {validReceipt:async()=>true};
  const api = await loadWith(mocks,cloudMock,{},now);
  const marker = path.join(f.root,'state','prune-in-progress.json');
  async function interruptedAt(target) {
    let interrupted = false;
    const faulty = await loadWith(mocks,cloudMock,{},now,{...fs,unlink:async filename=>{
      if(filename === target && !interrupted) {interrupted=true;throw Object.assign(new Error('simulated I/O interruption'),{code:'EIO'});}
      return fs.unlink(filename);
    }});
    await assert.rejects(faulty.prune(ctx),{code:'EIO'});
    assert.equal((await fs.stat(marker)).mode&0o777,0o600);
  }
  async function assertNewestIntact() {
    await mocks.verifyLocal(ctx,newest);
    assert.ok((await fs.stat(path.join(f.root,'manifests',newest.id+'.json'))).isFile());
  }
  return {...f,ctx,now,expired,newest,api,marker,interruptedAt,assertNewestIntact};
}

test('interrupted prune resumes a precisely journaled set with absent artifacts', async (t)=>{
  const f = await retentionScenario(t);
  await f.interruptedAt(path.join(f.root,f.expired.artifacts[1].key));
  await assert.rejects(fs.stat(path.join(f.root,f.expired.artifacts[0].key)),{code:'ENOENT'});
  await f.api.prune(f.ctx);
  for(const artifact of f.expired.artifacts) await assert.rejects(fs.stat(path.join(f.root,artifact.key)),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.root,'manifests',f.expired.id+'.json')),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.root,'receipts',f.expired.id+'.json')),{code:'ENOENT'});
  await assert.rejects(fs.stat(f.marker),{code:'ENOENT'});
  await f.assertNewestIntact();
});

test('prune replay finishes after manifest removal but before receipt removal', async (t)=>{
  const f = await retentionScenario(t);
  await f.interruptedAt(path.join(f.root,'receipts',f.expired.id+'.json'));
  await assert.rejects(fs.stat(path.join(f.root,'manifests',f.expired.id+'.json')),{code:'ENOENT'});
  await f.api.prune(f.ctx);
  await assert.rejects(fs.stat(f.marker),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.root,'receipts',f.expired.id+'.json')),{code:'ENOENT'});
  await f.assertNewestIntact();
});

test('mutation recovers journal before cloud sync encounters reordered deletions', async (t)=>{
  const f = await retentionScenario(t);
  await f.interruptedAt(path.join(f.root,f.expired.artifacts[1].key));
  // Simulate crash persistence reordering: receipt deletion persisted, while
  // the manifest and some artifacts remain. Cloud sync must not process it.
  await fs.unlink(path.join(f.root,'receipts',f.expired.id+'.json'));
  let synced = false;
  const api = await loadWith({context:async()=>f.ctx,capacity:async()=>{},log:()=>{},verifyLocal:async(_,manifest)=>{
    assert.equal(manifest.id,f.newest.id);await f.assertNewestIntact();
  }},{validReceipt:async()=>true,sync:async(_,all)=>{
    assert.deepEqual(all.map(m=>m.id),[f.newest.id]);
    await assert.rejects(fs.stat(f.marker),{code:'ENOENT'});
    synced=true;
  }},{},f.now);
  await api.main('sync');
  assert.equal(synced,true);
  await f.assertNewestIntact();
});

test('prune replay rejects path traversal without removing remaining files', async (t)=>{
  const f = await retentionScenario(t);
  await f.interruptedAt(path.join(f.root,f.expired.artifacts[0].key));
  const record = JSON.parse(await fs.readFile(f.marker,'utf8'));
  record.artifacts[0].key = '../outside.dump';
  await fs.writeFile(f.marker,JSON.stringify(record),{mode:0o600});
  await assert.rejects(f.api.prune(f.ctx),{code:'PRUNE_TRANSACTION_INVALID'});
  for(const artifact of f.expired.artifacts) assert.ok((await fs.stat(path.join(f.root,artifact.key))).isFile());
  await f.assertNewestIntact();
});

test('prune replay preserves its target when that set is now the last valid backup', async (t)=>{
  const f = await retentionScenario(t);
  await f.interruptedAt(path.join(f.root,f.expired.artifacts[0].key));
  // Simulate loss of the newer test fixture between process lifetimes.
  for(const artifact of f.newest.artifacts) await fs.unlink(path.join(f.root,artifact.key));
  await fs.unlink(path.join(f.root,'manifests',f.newest.id+'.json'));
  await assert.rejects(f.api.prune(f.ctx),{code:'PRUNE_TRANSACTION_INVALID'});
  for(const artifact of f.expired.artifacts) assert.ok((await fs.stat(path.join(f.root,artifact.key))).isFile());
  assert.ok((await fs.stat(f.marker)).isFile());
});

test('prune replay rejects changed proof and symlink replacement', async (t)=>{
  const f = await retentionScenario(t);
  const target = path.join(f.root,f.expired.artifacts[0].key);
  await f.interruptedAt(target);
  const receipt = path.join(f.root,'receipts',f.expired.id+'.json'), original = await fs.readFile(receipt);
  await fs.writeFile(receipt,'changed',{mode:0o600});
  await assert.rejects(f.api.prune(f.ctx),{code:'PRUNE_TRANSACTION_INVALID'});
  await fs.writeFile(receipt,original,{mode:0o600});
  await fs.unlink(target);
  const survivor = path.join(f.root,f.newest.artifacts[0].key);
  await fs.symlink(survivor,target);
  await assert.rejects(f.api.prune(f.ctx),/Private file must/);
  assert.ok((await fs.lstat(target)).isSymbolicLink());
  await f.assertNewestIntact();
});
