import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DashboardUploadUsageActor, DashboardUploadUsageInput } from '../dashboardUploadUsage';
import { withTransaction } from './client';

export const DASHBOARD_UPLOAD_USAGE_DRAIN_BATCH = 50;
const ROLES = new Set(['admin', 'admintop', 'top', 'wholesale_admin', 'manager', 'support_manager', 'purchaser']);

/** Must use the SAME transaction client as the actual successful resource insert. */
export async function enqueueDashboardUploadUsage(client: Pick<PoolClient, 'query'>, actor: DashboardUploadUsageActor, input: DashboardUploadUsageInput) {
  if (!/^(admin:(?:primary|[1-9][0-9]*)|manager:[1-9][0-9]*)$/.test(actor.actorKey) || !ROLES.has(actor.actorRole)
    || !/^(top:[1-9][0-9]*|manager:(development|support)|route-planner|currency-rates)$/.test(input.dashboardKey)
    || (input.versionId !== null && (!Number.isSafeInteger(input.versionId) || input.versionId < 1))
    || !input.resourceKey || input.resourceKey.length > 250 || /[\u0000-\u001f\u007f]/.test(input.resourceKey)
    || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > 2_147_483_648
    || !['html', 'data', 'personal'].includes(input.type)) throw new Error('Invalid upload usage intent');
  const basename = input.name.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 255) || '';
  const name = !basename || basename === '.' || basename === '..' ? 'file' : basename;
  const eventId = `upload_${createHash('sha256').update(input.resourceKey).digest('hex')}`;
  await client.query(`insert into dashboard_upload_usage_outbox
    (actor_key,actor_role,dashboard_key,html_version_id,event_id,upload_name,upload_size,upload_type)
    values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict(actor_key,event_id) do nothing`,
  [actor.actorKey, actor.actorRole, input.dashboardKey, input.versionId, eventId, name, input.size, input.type]);
}

/** Event, detail and acknowledgement are one bounded commit, also safe across server processes. */
export async function drainDashboardUploadUsageOutbox() {
  return withTransaction(async client => {
    await client.query("set local statement_timeout='3s'; set local lock_timeout='1s'");
    const result = await client.query<{ delivered: number; pending: number }>(`with pending as materialized (
      select * from dashboard_upload_usage_outbox order by id limit ${DASHBOARD_UPLOAD_USAGE_DRAIN_BATCH} for update skip locked
    ), inserted as (
      insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action,is_preview,html_version_id,captured_at,captured_source)
      select actor_key,actor_role,dashboard_key,event_id,'file_uploaded',false,html_version_id,captured_at,'server' from pending
      on conflict(actor_key,event_id) do nothing returning id,actor_key,event_id
    ), details as (
      insert into dashboard_usage_event_details(usage_event_id,upload_name,upload_size,upload_type)
      select inserted.id,pending.upload_name,pending.upload_size,pending.upload_type from inserted
      join pending using(actor_key,event_id)
    ), acknowledged as (
      select pending.id from pending join inserted using(actor_key,event_id)
      union all
      select pending.id from pending
      join dashboard_usage_events event using(actor_key,event_id)
      join dashboard_usage_event_details metadata on metadata.usage_event_id=event.id
      where event.action='file_uploaded' and not event.is_preview and event.actor_role=pending.actor_role
        and event.dashboard_key=pending.dashboard_key and event.html_version_id is not distinct from pending.html_version_id
        and metadata.upload_name=pending.upload_name and metadata.upload_size=pending.upload_size and metadata.upload_type=pending.upload_type
    ), delivered as (
      delete from dashboard_upload_usage_outbox where id in (select id from acknowledged) returning id
    ) select (select count(*)::integer from delivered) as delivered, (select count(*)::integer from pending) as pending`);
    if (result.rows[0].pending !== result.rows[0].delivered) console.error('DASHBOARD_UPLOAD_USAGE_EVENT_CONFLICT');
    return result.rows[0].delivered;
  }, { profile: 'interactive' });
}
