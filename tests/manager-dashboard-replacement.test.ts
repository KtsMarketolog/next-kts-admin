import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as security from '../src/shared/lib/managerDashboardSecurity';
import * as domain from '../src/shared/lib/managerDashboardDomain';
import * as origins from '../src/shared/lib/originProtection';
import { createPersonalReplacementToken, readPersonalReplacementToken } from '../src/shared/lib/managerDashboardSnapshotReplacementToken';

function compile<T>(filename: string, modules: Record<string, unknown>): T {
  const source=readFileSync(new URL(filename,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const output={exports:{} as T};
  new Function('require','module','exports','console',code)((name:string)=>{
    assert.ok(name in modules,`Unexpected dependency ${name}`);return modules[name];
  },output,output.exports,{error:()=>{}});
  return output.exports;
}
function harness(session: AdminSession|null={role:'admin',sessionId:randomUUID()}) {
  const calls: Array<{name:string;args:unknown[]}> = [];
  let fault: Error|null=null; let limited=false;let drains=0;
  const shared=compile<typeof import('../src/app/api/admin/manager-dashboard/_shared')>('../src/app/api/admin/manager-dashboard/_shared.ts',{
    '@/shared/lib/adminAuth':{getAdminSession:async()=>session},
    '@/shared/lib/adminSecurity':{enforceAdminActionRateLimit:async()=>limited?Response.json({error:'limit'},{status:429}):null},
    '@/shared/lib/db/wholesaleAdminRepo/managerRepo':{getWholesaleManagerById:async()=>assert.fail('management guard must not read manager account')},
    '@/shared/lib/managerDashboardSecurity':security,
    '@/shared/lib/originProtection':origins,
  });
  const methods=['preparePersonalDashboardSnapshotReplacement','confirmPersonalDashboardSnapshotReplacement','preparePersonalDashboardSnapshotRollback','confirmPersonalDashboardSnapshotRollback'];
  const repository=Object.fromEntries(methods.map(name=>[name,async(...args:unknown[])=>{
    calls.push({name,args});if(fault)throw fault;return {kind:name};
  }]));
  const route=compile<typeof import('../src/app/api/admin/manager-dashboard/snapshots/replacement/route')>('../src/app/api/admin/manager-dashboard/snapshots/replacement/route.ts',{
    '@/shared/lib/dashboardUploadUsage':{scheduleDashboardUploadUsageDrain:()=>{drains++;}},
    '@/shared/lib/db/managerDashboardRepo':repository,
    '@/shared/lib/managerDashboardDomain':domain,
    '../../_shared':shared,
  });
  const post=(form:FormData,origin='https://example.test')=>route.POST(new Request('https://example.test/api/admin/manager-dashboard/snapshots/replacement',{
    method:'POST',body:form,headers:{origin},
  }));
  return {post,calls,setFault:(value:Error)=>{fault=value;},setLimited:()=>{limited=true;},get drains(){return drains;}};
}
function form(action:string,file=true){const value=new FormData();value.set('action',action);if(file)value.set('file',new File(['encrypted-envelope'],'synthetic.ktsp'));return value;}

test('replacement token is bounded, signed, actor/session/action-bound and expires',t=>{
  const session:AdminSession={role:'admin',sessionId:randomUUID()};
  const input={action:'replace' as const,recipient:{source:'manager' as const,id:7},fingerprint:'a'.repeat(64),incoming:'b'.repeat(64)};
  const token=createPersonalReplacementToken(session,input);
  assert.equal(readPersonalReplacementToken(session,token,'replace').recipient.id,7);
  for(const other of [{...session,sessionId:randomUUID()},{...session,adminUserId:1},{...session,role:'admintop' as const}]) {
    assert.throws(()=>readPersonalReplacementToken(other,token,'replace'),{code:'REPLACEMENT_CONFLICT'});
  }
  assert.throws(()=>readPersonalReplacementToken(session,token,'rollback'),{code:'REPLACEMENT_CONFLICT'});
  for(const broken of ['',`${token}a`,`${token.slice(0,-4)}abcd`,'a'.repeat(3000)]) assert.throws(()=>readPersonalReplacementToken(session,broken,'replace'),{code:'REPLACEMENT_CONFLICT'});
  const now=Date.now();t.mock.method(Date,'now',()=>now+10*60_000+1);
  assert.throws(()=>readPersonalReplacementToken(session,token,'replace'),{code:'REPLACEMENT_CONFLICT'});
});

test('replacement API requires administrator management, same origin and rate limit before parsing or IO',async()=>{
  for(const session of [null,{role:'manager',managerId:7,sessionId:'x',dashboardAccess:['manager:development']},
    {role:'top',adminUserId:7,sessionId:'x',canManageTopDashboard:true},{role:'purchaser',adminUserId:7,sessionId:'x'}] as Array<AdminSession|null>){
    const h=harness(session);const response=await h.post(form('prepare'));assert.equal(response.status,session?403:401);assert.equal(h.calls.length,0);
  }
  const cross=harness();assert.equal((await cross.post(form('prepare'),'https://evil.test')).status,403);assert.equal(cross.calls.length,0);
  const limit=harness();limit.setLimited();assert.equal((await limit.post(form('prepare'))).status,429);assert.equal(limit.calls.length,0);
});
test('prepare and confirm use verified session, single selected file, explicit confirmation and private response',async()=>{
  const session:AdminSession={role:'admintop',adminUserId:19,sessionId:randomUUID()};const h=harness(session);
  const prepared=await h.post(form('prepare'));assert.equal(prepared.status,200);assert.ok((await prepared.json()).preview);
  assert.match(prepared.headers.get('cache-control')??'',/no-store/);assert.equal(h.calls[0].args[0],session);
  const input=h.calls[0].args[1] as {filename:string;bytes:Buffer};assert.equal(input.filename,'synthetic.ktsp');assert.equal(input.bytes.toString(),'encrypted-envelope');
  const confirm=form('confirm');confirm.set('token','test-token');assert.equal((await h.post(confirm)).status,400);assert.equal(h.calls.length,1);
  confirm.set('confirmed','true');assert.equal((await h.post(confirm)).status,200);assert.equal(h.calls.length,2);assert.equal(h.drains,1);
});
test('replacement rejects additional files, spoofed recipient in file flow, duplicate fields and missing input',async()=>{
  for(const mutate of [(f:FormData)=>f.append('file',new File(['x'],'other.ktsp')),(f:FormData)=>f.set('recipientId','42'),
    (f:FormData)=>f.set('usageActor','admin:1'),(f:FormData)=>f.append('action','confirm'),(f:FormData)=>f.delete('file'),
    (f:FormData)=>f.set('file',new File([],'empty.ktsp'))]){
    const h=harness(),f=form('prepare');mutate(f);assert.equal((await h.post(f)).status,400);assert.equal(h.calls.length,0);
  }
});
test('rollback preview identifies recipient but confirm is token-only and never records another upload',async()=>{
  const h=harness(),preview=form('prepare-rollback',false);preview.set('recipientSource','admin');preview.set('recipientId','12');
  assert.equal((await h.post(preview)).status,200);assert.deepEqual(h.calls[0].args[1],{source:'admin',id:12});
  const commit=form('confirm-rollback',false);commit.set('token','signed');commit.set('confirmed','true');
  assert.equal((await h.post(commit)).status,200);assert.equal(h.drains,0);assert.deepEqual(h.calls[1].args[1],{token:'signed'});
  commit.set('recipientId','99');assert.equal((await h.post(commit)).status,400);assert.equal(h.calls.length,2);
});
test('stale confirmation returns 409, revoked authority 403; internal errors never leak and do not nudge delivery',async()=>{
  for(const [fault,status] of [[new domain.PersonalDashboardError('REPLACEMENT_CONFLICT','Обновите сравнение'),409],
    [new domain.PersonalDashboardError('REPLACEMENT_FORBIDDEN','Нет доступа'),403],[new Error('secret_database_payload'),500]] as const){
    const h=harness();h.setFault(fault);const f=form('confirm');f.set('confirmed','true');f.set('token','signed');
    const response=await h.post(f);assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/secret_database_payload/);assert.equal(h.drains,0);
  }
});
