import type { AdminSession } from '@/shared/lib/adminAuth';
import { trackAnalyticsEvent } from '../analyticsRepo';
import { query } from '../client';
import { ensureSiteSchema } from '../schema';
import { actionEventType, actorMeta, actorTypeFromRole, clientIdFromName } from './analyticsHelpers';
import type { PriceListWriteQuery } from './priceListWrite';

export type PriceListEventInput = {
  priceListId: number;
  ownerManagerId: number | null;
  actorManagerId: number | null;
  actorRole: AdminSession['role'] | 'admin';
  title: string;
  action: string;
  details?: string;
};

export async function writePriceListEventRow(input: PriceListEventInput, execute: PriceListWriteQuery = query) {
  await execute(
    `insert into wholesale_price_list_events (
       price_list_id, manager_id, owner_manager_id, action, title_snapshot, actor_role, actor_label, details
     )
     values (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       case
         when $6 in ('manager', 'support_manager') then coalesce((select name from wholesale_managers where id = $2), $7)
         else $7
       end,
       $8
     )`,
    [
      input.priceListId,
      input.actorManagerId,
      input.ownerManagerId,
      input.action,
      input.title,
      input.actorRole,
      actorMeta({ role: input.actorRole as AdminSession['role'] }).actorFallback,
      input.details ?? '',
    ],
  );
}

export function priceListEventAnalytics(input: PriceListEventInput) {
  return {
    eventType: actionEventType(input.action),
    actorType: actorTypeFromRole(input.actorRole),
    actorUserId: input.actorManagerId,
    managerId: input.ownerManagerId,
    priceListId: input.priceListId,
    metadata: {
      title: input.title,
      action: input.action,
      details: input.details ?? '',
    },
  };
}

export async function insertPriceListEvent(input: PriceListEventInput) {
  await writePriceListEventRow(input);
  await trackAnalyticsEvent(priceListEventAnalytics(input));
}

export async function recordWholesaleManagerLogin(
  managerId: number,
  input: { ip?: string | null; userAgent?: string | null; referer?: string | null; actorType?: 'admin' | 'manager' },
) {
  await ensureSiteSchema();
  await query(
    `insert into wholesale_manager_login_logs (manager_id, ip, user_agent)
     values ($1, $2, $3)`,
    [managerId, input.ip ?? '', input.userAgent ?? ''],
  );
  await trackAnalyticsEvent({
    eventType: 'manager_login',
    actorType: input.actorType ?? 'manager',
    actorUserId: managerId,
    managerId,
    ip: input.ip,
    userAgent: input.userAgent,
    referer: input.referer,
  });
}

export async function recordWholesalePriceView(
  priceListId: number,
  token: string,
  input: {
    ip?: string | null;
    userAgent?: string | null;
    referer?: string | null;
    sessionId?: string | null;
    actorType?: 'admin' | 'manager' | 'client';
    actorUserId?: number | null;
    managerId?: number | null;
    clientName?: string | null;
    reopened?: boolean;
  },
) {
  await ensureSiteSchema();
  await query(
    `insert into wholesale_price_view_logs (price_list_id, token, ip, user_agent, referer)
     values ($1, $2, $3, $4, $5)`,
    [priceListId, token, input.ip ?? '', input.userAgent ?? '', input.referer ?? ''],
  );
  await trackAnalyticsEvent({
    eventType: input.reopened ? 'public_price_reopened' : 'public_price_opened',
    actorType: input.actorType ?? 'client',
    actorUserId: input.actorUserId,
    managerId: input.managerId,
    clientId: clientIdFromName(input.clientName),
    priceListId,
    token,
    sessionId: input.sessionId,
    ip: input.ip,
    userAgent: input.userAgent,
    referer: input.referer,
    metadata: {
      clientName: input.clientName ?? '',
    },
  });
}
