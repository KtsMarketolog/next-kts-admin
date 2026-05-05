import { hashSensitiveValue, safeHeaderValue } from '../securityHash';
import { query } from './client';
import { ensureSiteSchema } from './schema';

export type SecurityActorType = 'admin' | 'wholesale_admin' | 'manager' | 'client' | 'system';

export type SecurityEventType =
  | 'login_success'
  | 'login_failed'
  | 'login_rate_limited'
  | 'logout'
  | 'two_factor_challenge_created'
  | 'two_factor_success'
  | 'two_factor_failed'
  | 'password_changed'
  | 'admin_user_created'
  | 'admin_user_updated'
  | 'admin_user_deleted'
  | 'manager_created'
  | 'manager_updated'
  | 'manager_deleted'
  | 'price_deleted'
  | 'price_token_changed'
  | 'admin_pdf_downloaded'
  | 'admin_excel_downloaded'
  | 'rate_limit_blocked';

export type RecordSecurityEventInput = {
  eventType: SecurityEventType;
  actorType?: SecurityActorType;
  adminUserId?: number | null;
  managerId?: number | null;
  sessionId?: string | null;
  login?: string | null;
  entityType?: string | null;
  entityId?: string | number | null;
  ip?: string | null;
  userAgent?: string | null;
  referer?: string | null;
  metadata?: Record<string, unknown>;
};

function trimMetadata(metadata: Record<string, unknown> | undefined) {
  const json = JSON.stringify(metadata ?? {});
  if (json.length <= 4000) return metadata ?? {};
  return { truncated: true };
}

export async function recordSecurityEvent(input: RecordSecurityEventInput) {
  try {
    await ensureSiteSchema();
    await query(
      `insert into security_audit_events (
         event_type,
         actor_type,
         admin_user_id,
         manager_id,
         session_id,
         login,
         entity_type,
         entity_id,
         ip_hash,
         user_agent,
         referer,
         metadata
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        input.eventType,
        input.actorType ?? 'system',
        input.adminUserId ?? null,
        input.managerId ?? null,
        safeHeaderValue(input.sessionId, 160),
        safeHeaderValue(input.login, 160),
        safeHeaderValue(input.entityType, 80),
        input.entityId === null || input.entityId === undefined ? '' : String(input.entityId).slice(0, 120),
        hashSensitiveValue(input.ip || ''),
        safeHeaderValue(input.userAgent, 500),
        safeHeaderValue(input.referer, 500),
        JSON.stringify(trimMetadata(input.metadata)),
      ],
    );
  } catch (error) {
    console.error('Failed to record security event', error);
  }
}
