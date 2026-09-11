'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const PROJECT = 'kts-next-admin';
const ROOT = '/home/kts/backups/kts-next-admin';
const ID = /^kts-next-admin-\d{8}T\d{6}Z-[a-f0-9]+$/;
const cleanEnv = () => ({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/home/kts' });
function log(message) { console.log(`${new Date().toISOString()} ${message}`); }
async function privateFile(file) {
  const s = await fsp.lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600)
    throw new Error('Private file must be owned by backup user with mode 600');
  return s;
}
async function digest(file) {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function atomicJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  try { await fsp.writeFile(tmp, JSON.stringify(value, null, 2)+'\n', {mode:0o600, flag:'wx'}); await fsp.rename(tmp,file); }
  finally { await fsp.unlink(tmp).catch(()=>{}); }
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd:options.cwd, env:options.env || cleanEnv(), stdio:['ignore','pipe','pipe']});
    let output = '', tooLarge = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(()=>child.kill('SIGKILL'),5000).unref(); }, options.timeout || 600000);
    child.stdout.on('data', data => { if(output.length + data.length > 32*1024*1024) { tooLarge=true; child.kill(); } else output+=data; });
    // Child stderr may contain credentials, SQL or customer data; never forward it.
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error(`Could not execute ${path.basename(command)}`)); });
    child.on('close', (code, signal) => { clearTimeout(timer); if(code===0 && !tooLarge)resolve({stdout:output}); else reject(new Error(`${path.basename(command)} failed (${signal || code || 'output limit'})`)); });
  });
}
async function context({database = false} = {}) {
  process.umask(0o077);
  const configFile=process.env.KTS_BACKUP_CONFIG || '/home/kts/.config/kts-backup/config.json';
  await privateFile(configFile);
  const config=JSON.parse(await fsp.readFile(configFile,'utf8'));
  if(config.project!==PROJECT || config.root!==ROOT)throw new Error('Unexpected project or backup root');
  const root=config.root;
  if(await fsp.realpath(root)!==root)throw new Error('Backup root may not be a symlink');
  const rootStat=await fsp.stat(root);
  if(rootStat.uid!==process.getuid() || (rootStat.mode&0o777)!==0o700)throw new Error('Backup root must be private and owned by backup user');
  if((await fsp.readFile(path.join(root,'.kts-backup-root'),'utf8')).trim()!==PROJECT)throw new Error('Backup root marker missing');
  for(const d of ['.work','.restore','postgres','files','config','manifests','receipts','state']) {
    const dir=path.join(root,d); await fsp.mkdir(dir,{recursive:true,mode:0o700});
    if(await fsp.realpath(dir)!==dir)throw new Error('Backup subdirectory may not be a symlink');
  }
  const ctx={config,root,run,log,privateFile,digest,atomicJson,pgModule:require('pg')};
  if(database) {
    await privateFile(config.envFile);
    const values={};
    for(const line of (await fsp.readFile(config.envFile,'utf8')).split(/\r?\n/)) {
      if(!line || line.startsWith('#'))continue; const i=line.indexOf('='); if(i<1)continue;
      let v=line.slice(i+1).trim(); if((v[0]==='"' && v.endsWith('"'))||(v[0]==="'" && v.endsWith("'")))v=v.slice(1,-1);
      values[line.slice(0,i).trim()]=v;
    }
    const u=new URL(values.DATABASE_URL);
    if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/kts_admin')throw new Error('Production DB does not match audited endpoint');
    ctx.pgEnv={...cleanEnv(),PGHOST:u.hostname,PGPORT:u.port||'5432',PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGCONNECT_TIMEOUT:'10',PGAPPNAME:'kts-backup',PGOPTIONS:'-c statement_timeout=600000 -c lock_timeout=15000'};
    const {Client}=ctx.pgModule;
    ctx.pgClient=async()=>{const c=new Client({connectionString:values.DATABASE_URL,application_name:'kts-backup-snapshot',statement_timeout:600000,connectionTimeoutMillis:10000});await c.connect();return c;};
  }
  return ctx;
}
async function manifests(ctx) {
  const all=[];
  for(const file of (await fsp.readdir(path.join(ctx.root,'manifests'))).sort()) {
    if(!file.endsWith('.json')||!ID.test(file.slice(0,-5)))continue;
    const full=path.join(ctx.root,'manifests',file); await privateFile(full);
    const m=JSON.parse(await fsp.readFile(full,'utf8'));
    if(m.project!==PROJECT || m.id!==file.slice(0,-5) || !Array.isArray(m.artifacts) || !Number.isFinite(Date.parse(m.createdAt)))throw new Error('Invalid backup manifest');
    for(const a of m.artifacts) {
      const ext=a.kind==='postgres'?'.dump':'.tar.gz';
      if(!['postgres','files','config'].includes(a.kind)||a.key!==`${a.kind}/${m.id}${ext}`||!Number.isSafeInteger(a.size)||a.size<=0||!/^[a-f0-9]{64}$/.test(a.sha256))throw new Error('Invalid backup artifact');
    }
    if(new Set(m.artifacts.map(x=>x.kind)).size!==3||m.artifacts.length!==3)throw new Error('Incomplete project backup');
    all.push(m);
  }
  return all;
}
async function verifyLocal(ctx,m) {
  for(const a of m.artifacts) {
    const file=path.join(ctx.root,a.key); const s=await privateFile(file);
    if(s.size!==a.size || await digest(file)!==a.sha256)throw new Error('Local archive checksum or size mismatch');
  }
  await run(path.join(ctx.config.pgBin,'pg_restore'),['--list',path.join(ctx.root,m.artifacts.find(a=>a.kind==='postgres').key)]);
}
async function capacity(ctx) {
  const stat=await fsp.statfs(ctx.root); const free=stat.bavail*stat.bsize;
  if(free<ctx.config.minFreeBytes)throw new Error('Insufficient free disk space; no backups deleted');
  return free;
}
module.exports={PROJECT,ROOT,ID,context,manifests,verifyLocal,capacity,privateFile,digest,atomicJson,run,log,cleanEnv};
