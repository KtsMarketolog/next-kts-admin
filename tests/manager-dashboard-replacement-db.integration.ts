/** Synthetic local PostgreSQL only. Run using scripts/test-personal-dashboard-postgres.sh. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import { query } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import {
  confirmPersonalDashboardSnapshotReplacement as confirm,
  confirmPersonalDashboardSnapshotRollback as rollback,
  preparePersonalDashboardSnapshotReplacement as prepare,
  preparePersonalDashboardSnapshotRollback as prepareRollback,
  getPersonalDashboardSnapshot, getPersonalDashboardStatus, importPersonalDashboardSnapshot, listPersonalDashboardAdmin,
} from '../src/shared/lib/db/managerDashboardRepo';
import { getManagerEmailHash, personalDashboardToday } from '../src/shared/lib/managerDashboardDomain';
import type { PersonalDashboardRecipient } from '../src/shared/lib/managerDashboardRecipients';

function guard() {
  assert.equal(process.env.KTS_PERSONAL_TEST, '1');
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.username, 'personal_app');
  assert.equal(url.pathname, '/kts_personal_integration');
  assert.ok(['localhost', '127.0.0.1', '[::1]', ''].includes(url.hostname));
  assert.match(url.searchParams.get('host') ?? '', /^\/(private\/)?tmp\/kts-personal-postgres\.[A-Za-z0-9]+\/socket$/);
}
function day(offset = 0) {
  const value = new Date(`${personalDashboardToday()}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}
function file(email: string, seed: number, offset = 0, expires = day(45), filename = `personal-${seed}.ktsp`) {
  return {filename, bytes: Buffer.from(JSON.stringify({fmt:'kts-personal', v:1, gz:true,
    kdf:{name:'PBKDF2',hash:'SHA-256',iter:200000,salt:Buffer.alloc(16,1).toString('base64')},
    iv:Buffer.alloc(12,2).toString('base64'),ct:Buffer.alloc(32,seed).toString('base64'),
    emailHash:getManagerEmailHash(email),name:'Synthetic replacement employee',role:'МР',issued:day(offset),expires}))};
}
async function employee(role = 'manager', source: 'manager' | 'admin' = 'manager') {
  const key = randomUUID(); const email = `${key}@example.test`;
  const table = source === 'manager' ? 'wholesale_managers' : 'admin_users';
  const id = Number((await query<{id:string}>(`insert into ${table}(login,email,name,role,is_active)
    values($1,$2,$3,$4,true) returning id::text`, [key,email,`Synthetic ${key}`,role])).rows[0].id);
  if (source === 'manager') await query('insert into dashboard_view_grants(manager_id,key) values($1,$2)',[id,`manager:${role==='support_manager'?'support':'development'}`]);
  return {source,id,email} as PersonalDashboardRecipient & {email:string};
}
async function session(role: 'admin' | 'admintop' | 'top' = 'admin'): Promise<AdminSession> {
  const recipient = await employee(role,'admin');
  const sessionId = randomUUID();
  await query(`insert into admin_sessions(id,session_hash,role,admin_user_id,expires_at)
    values($1,$2,$3,$4,now()+interval '1 hour')`,[sessionId,randomUUID(),role,recipient.id]);
  return {role,adminUserId:recipient.id,sessionId};
}
const importFile = (input: ReturnType<typeof file>) => importPersonalDashboardSnapshot({...input,sourceKey:`replacement-fixture:${randomUUID()}`});
async function state(recipient: PersonalDashboardRecipient) {
  const column = recipient.source === 'manager' ? 'manager_id' : 'admin_user_id';
  return (await query(`select active_snapshot_id::text,previous_snapshot_id::text,updated_at::text
    from personal_dashboard_snapshot_state where ${column}=$1`,[recipient.id])).rows[0];
}
async function stored(recipient: PersonalDashboardRecipient) {
  const column = recipient.source === 'manager' ? 'manager_id' : 'admin_user_id';
  return (await query(`select id::text,sha256,source_key,encode(encrypted_payload,'hex') payload
    from personal_dashboard_snapshots where ${column}=$1 order by id`,[recipient.id])).rows;
}

test('confirmed personal snapshot replacement: isolated PostgreSQL', async t => {
  guard();
  try {
    await ensureSiteSchema();
    const admin = await session();
    const adminTop = await session('admintop');
    await t.test('prepare is metadata-only; same-day confirmation retains exactly current/previous and journals atomically',async()=>{
      const recipient = await employee();
      await importFile(file(recipient.email,1,-1));
      const first = await importFile(file(recipient.email,2));
      const incoming = file(recipient.email,3);
      const before = await stored(recipient);
      const preview = await prepare(admin,incoming);
      assert.equal(preview.recipient.id,recipient.id);
      assert.equal(preview.recipient.email,recipient.email);
      assert.equal(preview.current.id,first.snapshotId);
      assert.equal(preview.incoming.originalName,incoming.filename);
      assert.equal(preview.current.issued,preview.incoming.issued);
      assert.deepEqual(await stored(recipient),before);
      assert.doesNotMatch(JSON.stringify(preview),/encrypted_payload|"ct"|password|sessionId/);
      const result = await confirm(admin,{...incoming,token:preview.token});
      assert.equal(result.code,'REPLACED_SAME_DAY');
      const status = await getPersonalDashboardStatus(recipient);
      assert.equal(status.snapshot?.id,result.snapshotId);
      assert.equal(status.history.length,2);
      assert.equal(status.history.find(s=>s.status==='previous')?.id,first.snapshotId);
      assert.deepEqual((await getPersonalDashboardSnapshot(recipient))?.bytes,incoming.bytes);
      const journal = (await query('select code,message_id,sender from personal_dashboard_imports where id=$1',[result.id])).rows[0];
      assert.equal(journal.code,'REPLACED_SAME_DAY');
      assert.equal(journal.message_id,`replaces-snapshot:${first.snapshotId}`);
      assert.equal(journal.sender,`admin:${admin.adminUserId}`);
      assert.equal((await query('select count(*)::int count from dashboard_upload_usage_outbox where actor_key=$1',[`admin:${admin.adminUserId}`])).rows[0].count,1);
      const overview = await listPersonalDashboardAdmin();
      assert.equal(overview.groups[0].managers.find(m=>m.id===recipient.id&&m.source===recipient.source)?.previousSnapshot?.id,first.snapshotId);
      assert.equal(overview.imports.find(row=>Number(row.id)===result.id)?.performedByKey,`admin:${admin.adminUserId}`);
      assert.match(overview.imports.find(row=>Number(row.id)===result.id)?.performedBy??'',/^Synthetic /);
      assert.equal((await importFile(file(recipient.email,4))).code,'SAME_DAY_CONFLICT','ordinary/manual/mail import still rejects');
      assert.deepEqual(await confirm(admin,{...incoming,token:preview.token}),result,'retry after lost response acknowledges original commit');
      const next = file(recipient.email,5);const nextPreview=await prepare(adminTop,next);
      const nextResult=await confirm(adminTop,{...next,token:nextPreview.token});
      assert.deepEqual(await confirm(admin,{...incoming,token:preview.token}),result);
      assert.equal((await getPersonalDashboardStatus(recipient)).snapshot?.id,nextResult.snapshotId,'late retry never reverts later replacement');
    });
    await t.test('concurrent different confirmations: one wins; same token retry is idempotent',async()=>{
      const recipient=await employee();await importFile(file(recipient.email,1));
      const a=file(recipient.email,2),b=file(recipient.email,3);
      const pa=await prepare(admin,a),pb=await prepare(adminTop,b);
      const results=await Promise.allSettled([confirm(admin,{...a,token:pa.token}),confirm(adminTop,{...b,token:pb.token})]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'REPLACEMENT_CONFLICT');
      assert.equal((await stored(recipient)).length,2);
      const c=file(recipient.email,4),pc=await prepare(admin,c);
      const retried=await Promise.all([confirm(admin,{...c,token:pc.token}),confirm(admin,{...c,token:pc.token})]);
      assert.equal(retried[0].snapshotId,retried[1].snapshotId);
    });
    await t.test('token binds file, filename, actor session, recipient and publication; tampering fails closed',async()=>{
      const recipient=await employee();await importFile(file(recipient.email,1));
      const incoming=file(recipient.email,2),preview=await prepare(admin,incoming),before=await state(recipient);
      for(const input of [{...file(recipient.email,3),token:preview.token},{...incoming,filename:'renamed.ktsp',token:preview.token},
        {...incoming,token:`${preview.token.slice(0,-3)}abc`}]) await assert.rejects(confirm(admin,input),{code:'REPLACEMENT_CONFLICT'});
      await assert.rejects(confirm(adminTop,{...incoming,token:preview.token}),{code:'REPLACEMENT_CONFLICT'});
      assert.deepEqual(await state(recipient),before);
      await query('update wholesale_managers set email=$2 where id=$1',[recipient.id,`changed-${recipient.email}`]);
      const other=await employee();
      await query('update wholesale_managers set email=$2 where id=$1',[other.id,recipient.email]);
      await assert.rejects(confirm(admin,{...incoming,token:preview.token}),{code:'REPLACEMENT_CONFLICT'});
      assert.deepEqual(await state(recipient),before,'old token cannot reroute to another account with the old email');
      assert.equal(await state(other),undefined);
    });
    await t.test('a newer ordinary import invalidates pending same-day replacement',async()=>{
      const recipient=await employee();await importFile(file(recipient.email,1,-1));
      const incoming=file(recipient.email,2,-1),preview=await prepare(admin,incoming);
      const newer=await importFile(file(recipient.email,3));
      await assert.rejects(confirm(admin,{...incoming,token:preview.token}),{code:'REPLACEMENT_CONFLICT'});
      assert.equal((await getPersonalDashboardStatus(recipient)).snapshot?.id,newer.snapshotId);
    });
    await t.test('rollback is confirmed, atomic, idempotent, preserves bytes; stale ABA confirmation cannot restore old state',async()=>{
      const recipient=await employee();const original=await importFile(file(recipient.email,1));
      const incoming=file(recipient.email,2);const prepared=await prepare(admin,incoming);const replaced=await confirm(admin,{...incoming,token:prepared.token});
      const staleFile=file(recipient.email,3),stale=await prepare(admin,staleFile);
      const p=await prepareRollback(admin,recipient);
      assert.equal(p.current.id,replaced.snapshotId);assert.equal(p.incoming.id,original.snapshotId);
      const countBefore=(await query('select count(*)::int count from dashboard_upload_usage_outbox')).rows[0].count;
      const result=await rollback(admin,{token:p.token});
      assert.equal(result.code,'SNAPSHOT_ROLLED_BACK');assert.equal(result.snapshotId,original.snapshotId);
      assert.equal((await getPersonalDashboardStatus(recipient)).snapshot?.id,original.snapshotId);
      assert.deepEqual(await rollback(admin,{token:p.token}),result);
      assert.equal((await query('select count(*)::int count from dashboard_upload_usage_outbox')).rows[0].count,countBefore,'rollback is not counted as file upload');
      const back=await prepareRollback(admin,recipient);await rollback(admin,{token:back.token});
      assert.equal((await getPersonalDashboardStatus(recipient)).snapshot?.id,replaced.snapshotId);
      await assert.rejects(confirm(admin,{...staleFile,token:stale.token}),{code:'REPLACEMENT_CONFLICT'},'ABA invalidates old preview by state timestamp');
      assert.deepEqual(await rollback(admin,{token:p.token}),result);
      assert.equal((await getPersonalDashboardStatus(recipient)).snapshot?.id,replaced.snapshotId,'late rollback retry does not swap again');
      assert.equal((await stored(recipient)).length,2);
    });
    await t.test('persisted authorization rejects fake, revoked, downgraded and non-management sessions including retry',async()=>{
      const recipient=await employee();await importFile(file(recipient.email,1));const incoming=file(recipient.email,2);
      const top=await session('top');
      for(const denied of [top,{role:'manager',managerId:recipient.id,sessionId:randomUUID()},
        {...admin,sessionId:randomUUID()},{role:'admin',sessionId:'bogus'}] as AdminSession[]) {
        await assert.rejects(prepare(denied,incoming),{code:'REPLACEMENT_FORBIDDEN'});
        await assert.rejects(prepareRollback(denied,recipient),{code:'REPLACEMENT_FORBIDDEN'});
      }
      const writer=await session();const preview=await prepare(writer,incoming);const before=await stored(recipient);
      await query('update admin_sessions set revoked_at=now() where id=$1',[writer.sessionId]);
      await assert.rejects(confirm(writer,{...incoming,token:preview.token}),{code:'REPLACEMENT_FORBIDDEN'});
      assert.deepEqual(await stored(recipient),before);
      await query('update admin_sessions set revoked_at=null where id=$1',[writer.sessionId]);
      await confirm(writer,{...incoming,token:preview.token});
      await query("update admin_users set role='purchaser' where id=$1",[writer.adminUserId]);
      await assert.rejects(confirm(writer,{...incoming,token:preview.token}),{code:'REPLACEMENT_FORBIDDEN'});
    });
    await t.test('leader/admin and support manager recipients retain namespaced identity and correct usage dashboard',async()=>{
      for(const recipient of [await employee('top','admin'),await employee('support_manager')]) {
        await importFile(file(recipient.email,1));const incoming=file(recipient.email,2);const p=await prepare(admin,incoming);
        assert.deepEqual({source:p.recipient.source,id:p.recipient.id},{source:recipient.source,id:recipient.id});
        const result=await confirm(admin,{...incoming,token:p.token});
        assert.equal(recipient.source==='admin'?result.adminUserId:result.managerId,recipient.id);
        assert.equal((await getPersonalDashboardStatus(recipient)).snapshot?.id,result.snapshotId);
        assert.equal((await query('select dashboard_key from dashboard_upload_usage_outbox where upload_name=$1 and actor_key=$2 order by id desc limit 1',[incoming.filename,`admin:${admin.adminUserId}`])).rows[0].dashboard_key,
          recipient.source==='admin'?'manager:development':'manager:support');
      }
    });
    await t.test('primary administrator is persisted; rollback refuses expired or rebound previous snapshots',async()=>{
      const sessionId=randomUUID();
      await query(`insert into admin_sessions(id,session_hash,role,expires_at) values($1,$2,'admin',now()+interval '1 hour')`,[sessionId,randomUUID()]);
      const primary:AdminSession={role:'admin',sessionId};
      const recipient=await employee();const old=await importFile(file(recipient.email,1,-2));await importFile(file(recipient.email,2));
      const incoming=file(recipient.email,3),p=await prepare(primary,incoming);
      const saved=await confirm(primary,{...incoming,token:p.token});assert.equal(saved.code,'REPLACED_SAME_DAY');
      const journal=await listPersonalDashboardAdmin();
      assert.equal(journal.imports.find(row=>Number(row.id)===saved.id)?.performedBy,'Основной администратор');
      const current=await state(recipient);
      await query('update personal_dashboard_snapshots set issued=$2,expires=$3 where id=$1',[current.previous_snapshot_id,day(-2),day(-1)]);
      await assert.rejects(prepareRollback(primary,recipient),{code:'REPLACEMENT_CONFLICT'});
      assert.equal((await state(recipient)).active_snapshot_id,String(saved.snapshotId));
      await query('update personal_dashboard_snapshots set expires=$2,email_hash=$3 where id=$1',[current.previous_snapshot_id,day(45),getManagerEmailHash('different@example.test')]);
      await assert.rejects(prepareRollback(primary,recipient),{code:'REPLACEMENT_CONFLICT'});
      assert.equal((await query('select count(*)::int count from personal_dashboard_snapshots where id=$1',[old.snapshotId])).rows[0].count,0,'retention prunes only the superseded older previous snapshot');
    });
    await t.test('missing/same content, different date, ambiguous/disabled recipient and expired rollback fail without writes',async()=>{
      const recipient=await employee();await assert.rejects(prepare(admin,file(recipient.email,1)),{code:'REPLACEMENT_CONFLICT'});
      await importFile(file(recipient.email,1));const before=await stored(recipient);
      await assert.rejects(prepare(admin,file(recipient.email,1)),{code:'REPLACEMENT_CONFLICT'});
      await assert.rejects(prepare(admin,file(recipient.email,2,-1)),{code:'REPLACEMENT_CONFLICT'});
      await assert.rejects(prepare(admin,file(recipient.email,2,0,day(-1))),{code:'INVALID_DATE'});
      await assert.rejects(prepareRollback(admin,recipient),{code:'REPLACEMENT_CONFLICT'});
      const duplicate=await employee();await assert.rejects(query('update wholesale_managers set email=$2 where id=$1',[duplicate.id,recipient.email]),{code:'23505'},'new identity ambiguity is also prevented at DB boundary');
      await query('update wholesale_managers set is_active=false where id=any($1::bigint[])',[[duplicate.id,recipient.id]]);
      await assert.rejects(prepare(admin,file(recipient.email,2)),{code:'REPLACEMENT_CONFLICT'});
      assert.deepEqual(await stored(recipient),before);
    });
    await t.test('failed durable upload journal rolls back snapshot, previous retention, state and import journal together',async()=>{
      const recipient=await employee();await importFile(file(recipient.email,1,-1));await importFile(file(recipient.email,2));
      const incoming=file(recipient.email,3,0,day(45),'synthetic-outbox-fail.ktsp');const p=await prepare(admin,incoming);
      const before=await stored(recipient),beforeState=await state(recipient);
      await query(`create function replacement_test_outbox_fail() returns trigger language plpgsql as $$ begin
        if new.upload_name='synthetic-outbox-fail.ktsp' then raise exception 'synthetic failure'; end if; return new; end $$;
        create trigger replacement_test_fail before insert on dashboard_upload_usage_outbox for each row execute function replacement_test_outbox_fail()`);
      try {
        await assert.rejects(confirm(admin,{...incoming,token:p.token}),/synthetic failure/);
        assert.deepEqual(await stored(recipient),before);assert.deepEqual(await state(recipient),beforeState);
        assert.equal((await query('select count(*)::int count from personal_dashboard_imports where original_name=$1',[incoming.filename])).rows[0].count,0);
      } finally {await query('drop trigger replacement_test_fail on dashboard_upload_usage_outbox; drop function replacement_test_outbox_fail()');}
      assert.equal((await confirm(admin,{...incoming,token:p.token})).code,'REPLACED_SAME_DAY');
    });
  } finally {await globalThis.__ktsPgPool?.end();globalThis.__ktsPgPool=undefined;}
});
