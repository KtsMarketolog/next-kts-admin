'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {context, manifests, verifyLocal, capacity, atomicJson, privateFile, digest, log, ID} = require('./common.cjs');
const DAY = 86400000;
const ERRORS = Object.freeze({
  NO_BACKUPS: 'No completed project backups',
  PREDEPLOY_POLICY_PENDING: 'Predeploy cloud policy must be explicitly agreed before deployment',
  PRUNE_UNCONFIRMED: 'Expired backup sets retained because cloud verification is unconfirmed',
  PRUNE_TRANSACTION_INVALID: 'Interrupted retention cleanup failed its guards; all remaining files preserved',
  BACKUP_STALE: 'Latest backup is older than 30 hours',
  BACKUP_TIME_INVALID: 'Backup timestamp is invalid or in the future',
  CAPTURE_STATE_FAILED: 'Last capture failed or completion state does not match',
  SERVICE_FAILED: 'Last scheduled backup service failed',
  LINGER_DISABLED: 'Linger is not enabled',
  STALE_TEMP: 'Stale temporary backup files need inspection',
  INITIAL_CLOUD_RESTORE_REQUIRED: 'Initial Yandex restore has not completed; full backup health is not yet verified',
  CLOUD_RESTORE_FAILED: 'Latest cloud restore attempt failed or is still incomplete',
  CLOUD_RESTORE_STATE_INVALID: 'Cloud restore completion evidence is invalid',
  CLOUD_RESTORE_STALE: 'Last successful cloud restore is older than 8 days',
  RESTORE_INPUT_INVALID: 'Invalid restore input',
  UNKNOWN_ACTION: 'Unknown backup action',
});
// Exact codes only. Dependency messages may contain secrets without any URL.
const SAFE_DEPENDENCY_CODES = new Set([
  'EACCES','EPERM','ENOENT','ENOSPC','EIO','EROFS','EMFILE','ENFILE','ETIMEDOUT',
  'INSUFFICIENT_FREE_DISK','SOURCE_CHANGED','SOURCE_DIRECTORY_CHANGED','POSTGRES_UTILITY_VERSION_MISMATCH',
  'EMPTY_DATABASE_ARCHIVE','UNREADABLE_DATABASE_ARCHIVE','TOP_REFERENCE_MISMATCH','DOCUMENT_REFERENCE_MISMATCH',
  'SYMLINK_SOURCE_ENTRY','SYMLINK_SOURCE_DIRECTORY','BACKUP_SOURCE_OVERLAP','CAPTURE_IO_OR_DATABASE_ERROR',
  'RESTORE_SCHEMA_MISMATCH','RESTORE_POSTGRES_VERSION_MISMATCH','RESTORE_INSUFFICIENT_MEMORY',
  'RESTORE_INSUFFICIENT_DISK','RESTORE_ARTIFACT_INTEGRITY','RESTORE_ROW_COUNT_MISMATCH',
  'RESTORE_MIGRATIONS_MISMATCH','RESTORE_REFERENCES_MISMATCH','RESTORE_FILE_CHECKSUM',
  'RESTORE_STOP_FAILED_DIRECTORY_PRESERVED','RESTORE_PID_REMAINS_DIRECTORY_PRESERVED',
  'RESTORE_CLEANUP_GUARD_FAILED','RESTORE_INTERRUPTED','RESTORE_PREPARE_FAILED',
  'RESTORE_FILES_FAILED','RESTORE_INITDB_FAILED','RESTORE_PG_RESTORE_FAILED','RESTORE_VALIDATE_FAILED',
  'CLOUD_RETENTION_CONFIG','CLOUD_RETENTION_DESCRIPTOR','CLOUD_RETENTION_INVENTORY',
  'CLOUD_RETENTION_POLICY','CLOUD_RETENTION_VERIFY','CLOUD_RETENTION_DELETE_UNCONFIRMED',
  'CLOUD_RETENTION_ORPHANS',
  'CLOUD_RETENTION_ADAPTER','CLOUD_RETENTION_AUDIT','CLOUD_RETENTION_CONTEXT',
  'CLOUD_RETENTION_COUNT','CLOUD_RETENTION_DELETE','CLOUD_RETENTION_DUPLICATE',
  'CLOUD_RETENTION_IDENTITY','CLOUD_RETENTION_INSPECT','CLOUD_RETENTION_JOURNAL',
  'CLOUD_RETENTION_KEEPERS','CLOUD_RETENTION_LIST','CLOUD_RETENTION_PENDING','CLOUD_RETENTION_SET',
]);
let failurePhase = 'CONFIG';
function fail(code) { const error = new Error(ERRORS[code] || 'Backup operation failed'); error.code = code; return error; }
function safeError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (Object.hasOwn(ERRORS, code)) return code + ': ' + ERRORS[code];
  if (SAFE_DEPENDENCY_CODES.has(code)) return code;
  return 'BACKUP_OPERATION_FAILED: dependency details suppressed';
}
async function state(ctx, name, value) {
  await atomicJson(path.join(ctx.root,'state',name+'.json'), {...value, at:new Date().toISOString()});
}
async function readState(ctx, name) {
  const filename = path.join(ctx.root,'state',name+'.json');
  try { await privateFile(filename); }
  catch(error) { if(error.code === 'ENOENT') return null; throw error; }
  return JSON.parse(await fs.readFile(filename,'utf8'));
}
async function latest(ctx) {
  const all = await manifests(ctx);
  if(!all.length) throw fail('NO_BACKUPS');
  return all.at(-1);
}
const PRUNE_STATE = 'prune-in-progress';
async function optionalPrivateFile(filename) {
  try { return await privateFile(filename); }
  catch(error) { if(error.code === 'ENOENT') return null; throw error; }
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
function validatePruneTransaction(record, newest, cutoff) {
  const timestamp = Date.parse(record?.createdAt), authorized = Date.parse(record?.authorizedAt);
  if(!record || record.version !== 1 || record.project !== 'kts-next-admin' || !ID.test(record.id)
      || !newest || record.id === newest.id || !Number.isFinite(timestamp) || timestamp >= cutoff
      || !Number.isFinite(authorized) || authorized < timestamp+14*DAY || authorized > Date.now()+5*60000
      || !/^[a-f0-9]{64}$/.test(record.manifestSha256) || !/^[a-f0-9]{64}$/.test(record.receiptSha256)
      || !Array.isArray(record.artifacts) || record.artifacts.length !== 3
      || new Set(record.artifacts.map(a=>a?.kind)).size !== 3
      || record.artifacts.some(a=>!a || !['postgres','files','config'].includes(a.kind)
        || a.key !== a.kind+'/'+record.id+(a.kind === 'postgres'?'.dump':'.tar.gz')
        || !Number.isSafeInteger(a.size) || a.size < 1 || !/^[a-f0-9]{64}$/.test(a.sha256))) {
    throw fail('PRUNE_TRANSACTION_INVALID');
  }
}
async function finishPruneTransaction(ctx, record, newest, cutoff) {
  validatePruneTransaction(record,newest,cutoff);
  const manifestFile = path.join(ctx.root,'manifests',record.id+'.json');
  const receiptFile = path.join(ctx.root,'receipts',record.id+'.json');
  // The durable journal authorizes precisely this previously cloud-confirmed
  // set. Missing paths mean a prior attempt already deleted them, never a reason
  // to select another path or set. Existing metadata must still match its proof.
  for(const [filename, expected] of [[manifestFile,record.manifestSha256],[receiptFile,record.receiptSha256]]) {
    if(await optionalPrivateFile(filename) && await digest(filename) !== expected) throw fail('PRUNE_TRANSACTION_INVALID');
  }
  const targets = [...record.artifacts.map(a=>path.join(ctx.root,a.key)),manifestFile,receiptFile];
  // Validate every still-present file before deleting any of this set. Refuse
  // symlinks, a different owner or changed permissions even during recovery.
  for(const filename of targets) await optionalPrivateFile(filename);
  for(const filename of targets) {
    try { await fs.unlink(filename); }
    catch(error) { if(error.code !== 'ENOENT') throw error; }
  }
  // Persist directory changes before removing the recovery record. This also
  // covers a power loss after deletion of the manifest but before the receipt.
  for(const directory of ['postgres','files','config','manifests','receipts']) await syncDirectory(path.join(ctx.root,directory));
  await fs.unlink(path.join(ctx.root,'state',PRUNE_STATE+'.json'));
  await syncDirectory(path.join(ctx.root,'state'));
}
async function beginPruneTransaction(ctx, manifest, newest, cutoff) {
  const record = {
    version:1, project:'kts-next-admin', id:manifest.id, createdAt:manifest.createdAt,
    authorizedAt:new Date(Date.now()).toISOString(),
    artifacts:manifest.artifacts.map(({kind,key,size,sha256})=>({kind,key,size,sha256})),
    manifestSha256:await digest(path.join(ctx.root,'manifests',manifest.id+'.json')),
    receiptSha256:await digest(path.join(ctx.root,'receipts',manifest.id+'.json')),
  };
  validatePruneTransaction(record,newest,cutoff);
  for(const artifact of record.artifacts) await optionalPrivateFile(path.join(ctx.root,artifact.key));
  const filename = path.join(ctx.root,'state',PRUNE_STATE+'.json');
  if(await optionalPrivateFile(filename)) throw fail('PRUNE_TRANSACTION_INVALID');
  await atomicJson(filename,record);
  await privateFile(filename);
  const handle = await fs.open(filename,'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(filename));
  return record;
}
async function resumePruneTransaction(ctx) {
  const record = await readState(ctx,PRUNE_STATE);
  if(!record) return;
  const all = await manifests(ctx), newest = all.at(-1);
  if(!newest) throw fail('PRUNE_TRANSACTION_INVALID');
  await verifyLocal(ctx,newest);
  await finishPruneTransaction(ctx,record,newest,Date.now()-14*DAY);
}
async function prune(ctx) {
  const all = await manifests(ctx);
  const interrupted = await readState(ctx,PRUNE_STATE);
  if(!all.length) {
    if(interrupted) throw fail('PRUNE_TRANSACTION_INVALID');
    return;
  }
  // Preserve newest independently verified set, regardless of its age.
  const newest = all.at(-1);
  await verifyLocal(ctx,newest);
  const cutoff = Date.now()-14*DAY;
  if(interrupted) await finishPruneTransaction(ctx,interrupted,newest,cutoff);
  let keptUnsent = 0;
  for(const manifest of all) {
    if(manifest.id === newest.id || manifest.id === interrupted?.id || Date.parse(manifest.createdAt) >= cutoff) continue;
    // Historical full-download proof is sufficient: cloud rotation is
    // independent of these local files' 14-day retention.
    let confirmed = false;
    try { confirmed = await require('./cloud.cjs').validReceipt(ctx,manifest); }
    catch { /* Invalid evidence preserves the backup, never authorizes deletion. */ }
    if(!confirmed) { keptUnsent++; continue; }
    const transaction = await beginPruneTransaction(ctx,manifest,newest,cutoff);
    await finishPruneTransaction(ctx,transaction,newest,cutoff);
  }
  if(keptUnsent) {
    log('Retention warning: '+keptUnsent+' expired sets retained without valid cloud confirmation');
    throw fail('PRUNE_UNCONFIRMED');
  }
}
async function restoreHealth(ctx, now = Date.now()) {
  // No implicit grace: until the first real cloud drill, daily monitoring fails
  // with a specific commissioning status. Local drills cannot turn it green.
  let result = await readState(ctx,'restore-cloud');
  if(!result) {
    const previous = await readState(ctx,'restore');
    if(previous?.origin === 'yandex') result = previous;
  }
  if(!result) throw fail('INITIAL_CLOUD_RESTORE_REQUIRED');
  if(result.ok !== true) throw fail('CLOUD_RESTORE_FAILED');
  const report = result.report;
  if(result.origin !== 'yandex' || !report || report.source !== 'yandex-object-storage'
      || report.project !== 'kts-next-admin' || !ID.test(result.id) || report.id !== result.id
      || !Number.isInteger(report.tables) || report.tables < 1
      || !/^[a-f0-9]{64}$/.test(report.schemaFingerprint)
      || !Array.isArray(report.artifacts) || report.artifacts.length !== 3
      || new Set(report.artifacts.map(a=>a.kind)).size !== 3
      || report.artifacts.some(a=>!['postgres','files','config'].includes(a.kind)
        || !Number.isSafeInteger(a.size) || a.size < 1 || !/^[a-f0-9]{64}$/.test(a.sha256))) {
    throw fail('CLOUD_RESTORE_STATE_INVALID');
  }
  const restoredAt = Date.parse(report.restoredAt), recordedAt = Date.parse(result.at);
  if(!Number.isFinite(restoredAt) || !Number.isFinite(recordedAt)
      || restoredAt > now+5*60000 || recordedAt > now+5*60000
      || recordedAt < restoredAt-60000) throw fail('CLOUD_RESTORE_STATE_INVALID');
  if(now-restoredAt > 8*DAY) throw fail('CLOUD_RESTORE_STALE');
  return {id:result.id,restoredAt:report.restoredAt};
}
async function staleTemporary(ctx, now = Date.now()) {
  const candidates = [];
  for(const dir of ['.work','.restore']) {
    for(const name of await fs.readdir(path.join(ctx.root,dir))) candidates.push(path.join(ctx.root,dir,name));
  }
  for(const name of await fs.readdir(ctx.root)) {
    if(name.startsWith('.cloud-download-')) candidates.push(path.join(ctx.root,name));
  }
  for(const dir of ['state','receipts','manifests','postgres','files','config']) {
    for(const name of await fs.readdir(path.join(ctx.root,dir))) {
      if(name.endsWith('.part') || /\.tmp-\d+$/.test(name) || (dir === 'state' &&
        (name === PRUNE_STATE+'.json' || name === 'cloud-prune-in-progress.json' ||
          /^\.cloud-prune-(?:in-progress|history)\.json\.\d+\.[a-f0-9]+\.tmp$/.test(name)))) candidates.push(path.join(ctx.root,dir,name));
    }
  }
  for(const target of candidates) {
    const stat = await fs.lstat(target);
    if(stat.isSymbolicLink() || now-stat.mtimeMs > 2*3600000) throw fail('STALE_TEMP');
  }
}
async function main(action = process.argv[2]) {
  const ctx = await context({database:['capture','daily','predeploy'].includes(action)});
  if(action === 'predeploy' && !['required','warn'].includes(ctx.config.predeployCloudPolicy)) throw fail('PREDEPLOY_POLICY_PENDING');
  // A power loss can persist unlink operations out of order. Finish authorized
  // cleanup before sync sees a half-removed manifest/receipt pair. Checks remain
  // read-only; recovery removes only the already journaled, non-newest set.
  if(['daily','predeploy','sync','prune'].includes(action)) {
    failurePhase = 'RETENTION_RECOVERY'; await resumePruneTransaction(ctx);
  }
  await capacity(ctx);
  if(['capture','daily','predeploy'].includes(action)) {
    failurePhase = 'CAPTURE';
    try {
      const manifest = await require('./capture.cjs').capture(ctx);
      await verifyLocal(ctx,manifest);
      await state(ctx,'capture',{ok:true,id:manifest.id});
      log('Local backup verified: '+manifest.id);
    } catch(error) { await state(ctx,'capture',{ok:false}); throw error; }
    if(action === 'capture') return;
    failurePhase = 'UPLOAD';
    try { await require('./cloud.cjs').sync(ctx,await manifests(ctx)); await state(ctx,'cloud',{ok:true}); }
    catch(error) {
      await state(ctx,'cloud',{ok:false});
      if(action === 'predeploy' && ctx.config.predeployCloudPolicy === 'warn') log('WARNING: deployment continuing with verified local backup only (explicitly configured policy)');
      else throw error;
    }
    failurePhase = 'RETENTION';
    try { await prune(ctx); }
    catch(error) {
      if(action === 'predeploy' && ctx.config.predeployCloudPolicy === 'warn' && error.code === 'PRUNE_UNCONFIRMED') log('WARNING: unconfirmed historical backups retained; agreed cloud-warning policy permits deployment');
      else throw error;
    }
    return;
  }
  if(action === 'sync') {
    failurePhase = 'UPLOAD';
    try { await require('./cloud.cjs').sync(ctx,await manifests(ctx)); await state(ctx,'cloud',{ok:true}); }
    catch(error) { await state(ctx,'cloud',{ok:false}); throw error; }
    failurePhase = 'RETENTION'; await prune(ctx); return;
  }
  if(action === 'prune') { failurePhase = 'RETENTION'; return prune(ctx); }
  if(action === 'check') {
    failurePhase = 'MONITOR';
    const manifest = await latest(ctx); await verifyLocal(ctx,manifest);
    const age = Date.now()-Date.parse(manifest.createdAt);
    if(!Number.isFinite(age) || age < -5*60000) throw fail('BACKUP_TIME_INVALID');
    if(age > 30*3600000) throw fail('BACKUP_STALE');
    const capture = await readState(ctx,'capture');
    if(!capture?.ok || capture.id !== manifest.id) throw fail('CAPTURE_STATE_FAILED');
    const env = {PATH:'/usr/bin:/bin',HOME:'/home/kts',XDG_RUNTIME_DIR:'/run/user/'+process.getuid(),DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/'+process.getuid()+'/bus'};
    for(const args of [['--user','is-enabled','kts-backup.timer'],['--user','is-active','kts-backup.timer']]) await ctx.run('/usr/bin/systemctl',args,{env});
    const service = await ctx.run('/usr/bin/systemctl',['--user','show','kts-backup.service','--property=Result','--value'],{env});
    if(service.stdout.trim() !== 'success') throw fail('SERVICE_FAILED');
    const linger = await ctx.run('/usr/bin/loginctl',['show-user','kts','-p','Linger','--value']);
    if(linger.stdout.trim() !== 'yes') throw fail('LINGER_DISABLED');
    await staleTemporary(ctx);
    await require('./cloud.cjs').verify(ctx,manifest);
    if(ctx.config.cloudRetention !== undefined) await require('./cloud.cjs').retentionHealth(ctx);
    const restored = await restoreHealth(ctx);
    log('Backup health OK: '+manifest.id+'; permissions, SHA256, encryption, timer, space and Yandex restore at '+restored.restoredAt+' verified'); return;
  }
  if(action === 'fetch-restore') {
    failurePhase = 'CLOUD_FETCH';
    await state(ctx,'restore-cloud',{ok:false,origin:'yandex',phase:'downloading'});
    const work = await fs.mkdtemp(path.join(ctx.root,'.work/cloud-restore-'));
    try {
      const manifest = await require('./cloud.cjs').downloadLatest(ctx,work);
      await atomicJson(path.join(ctx.root,'state/restore-input.json'),{id:manifest.id,root:work,manifest});
      await state(ctx,'restore-cloud',{ok:false,origin:'yandex',phase:'awaiting-restore',id:manifest.id});
      log('Cloud restore set downloaded and verified: '+manifest.id);
    } catch(error) {
      await state(ctx,'restore-cloud',{ok:false,origin:'yandex',phase:'download-failed'});
      await fs.rm(work,{recursive:true,force:true}); throw error;
    }
    return;
  }
  if(['restore-local','restore-downloaded'].includes(action)) {
    failurePhase = 'RESTORE';
    const cloud = action === 'restore-downloaded';
    let manifest, source = ctx.root, ownsSource = false;
    if(cloud) await state(ctx,'restore-cloud',{ok:false,origin:'yandex',phase:'validating-input'});
    try {
      if(!cloud) { manifest = await latest(ctx); await verifyLocal(ctx,manifest); }
      else {
        const input = await readState(ctx,'restore-input');
        if(!input || typeof input.root !== 'string' || !ID.test(input.id) || input.manifest?.id !== input.id
            || path.dirname(input.root) !== path.join(ctx.root,'.work')
            || !path.basename(input.root).startsWith('cloud-restore-') || await fs.realpath(input.root) !== input.root) throw fail('RESTORE_INPUT_INVALID');
        manifest = input.manifest; source = input.root; ownsSource = true;
      }
      const report = await require('./restore.cjs').restore(ctx,manifest,source);
      const result = {ok:true,id:manifest.id,origin:cloud?'yandex':'local',report};
      await state(ctx,'restore',result);
      if(cloud) await state(ctx,'restore-cloud',result);
      log('Restore verified: '+manifest.id+'; origin='+(cloud?'yandex':'local'));
    } catch(error) {
      const result = {ok:false,origin:cloud?'yandex':'local',phase:'restore-failed',...(manifest?{id:manifest.id}:{})};
      await state(ctx,'restore',result);
      if(cloud) await state(ctx,'restore-cloud',result);
      throw error;
    } finally {
      if(ownsSource) {
        await fs.rm(source,{recursive:true,force:true});
        await fs.unlink(path.join(ctx.root,'state/restore-input.json')).catch(()=>{});
      }
    }
    return;
  }
  throw fail('UNKNOWN_ACTION');
}
if(require.main === module) main().catch(error=>{
  log('ERROR phase='+failurePhase+': '+safeError(error)); process.exitCode=1;
});
module.exports = {main,prune,restoreHealth,staleTemporary,safeError};
