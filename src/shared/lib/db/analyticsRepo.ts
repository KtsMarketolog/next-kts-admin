import { createHash } from 'crypto';

import { query } from './client';
import { ensureSiteSchema } from './schema';

export type AnalyticsActorType = 'admin' | 'manager' | 'client' | 'system';

export type AnalyticsEventType =
  | 'manager_login'
  | 'manager_logout'
  | 'price_created'
  | 'price_updated'
  | 'price_deleted'
  | 'price_activated'
  | 'price_deactivated'
  | 'price_client_changed'
  | 'price_expiration_changed'
  | 'price_items_added'
  | 'price_items_removed'
  | 'price_status_changed'
  | 'price_public_link_created'
  | 'price_public_link_copied'
  | 'price_edit_opened'
  | 'public_price_opened'
  | 'public_price_reopened'
  | 'public_price_pdf_downloaded'
  | 'public_price_excel_downloaded'
  | 'public_price_phone_clicked'
  | 'public_price_email_clicked'
  | 'public_price_product_opened'
  | 'public_price_search_used'
  | 'public_price_filter_used'
  | 'public_price_request_started'
  | 'public_price_quantity_changed'
  | 'public_price_request_abandoned'
  | 'public_price_request_sent';

export type TrackAnalyticsEventInput = {
  eventType: AnalyticsEventType;
  actorType: AnalyticsActorType;
  actorUserId?: number | null;
  managerId?: number | null;
  clientId?: string | null;
  priceListId?: number | null;
  shareLinkId?: number | null;
  token?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  referer?: string | null;
  metadata?: Record<string, unknown> | null;
};

function hashIp(ip?: string | null) {
  const normalized = ip?.trim();
  if (!normalized || normalized === 'unknown') return '';
  const salt = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'kts-analytics';
  return createHash('sha256').update(`${salt}:${normalized}`).digest('hex');
}

function truncate(value: string | null | undefined, maxLength: number) {
  return (value ?? '').slice(0, maxLength);
}

function safeMetadata(metadata: Record<string, unknown> | null | undefined) {
  const json = JSON.stringify(metadata ?? {});
  if (json.length <= 8000) return json;
  return JSON.stringify({ truncated: true });
}

export async function trackAnalyticsEvent(input: TrackAnalyticsEventInput) {
  try {
    await ensureSiteSchema();
    await query(
      `insert into wholesale_analytics_events (
         event_type,
         actor_type,
         actor_user_id,
         manager_id,
         client_id,
         price_list_id,
         share_link_id,
         token,
         session_id,
         ip_hash,
         user_agent,
         referer,
         metadata
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        input.eventType,
        input.actorType,
        input.actorUserId ?? null,
        input.managerId ?? null,
        input.clientId ?? null,
        input.priceListId ?? null,
        input.shareLinkId ?? null,
        truncate(input.token, 160),
        truncate(input.sessionId, 160),
        hashIp(input.ip),
        truncate(input.userAgent, 500),
        truncate(input.referer, 500),
        safeMetadata(input.metadata),
      ],
    );
  } catch (error) {
    console.error('Failed to track analytics event', error);
  }
}

export async function clearWholesaleAnalyticsEvents() {
  await ensureSiteSchema();
  const result = await query<{ deleted: string }>(
    `with deleted as (
       delete from wholesale_analytics_events
       returning 1
     )
     select count(*)::text as deleted from deleted`,
  );
  return Number(result.rows[0]?.deleted ?? 0);
}
