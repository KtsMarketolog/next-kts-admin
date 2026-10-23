import { createHash } from 'crypto';

import { getAdminSessionSecret } from './authSecret';
import { query } from './db/client';
import { ensureSiteSchema } from './db/schema';

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateLimitEntry>();

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
  /** Only for admitted work that was rejected before password verification. */
  refundUnconsumedAttempt?: () => Promise<void>;
};

export function getClientIp(request: Request) {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedFor || request.headers.get('x-real-ip') || 'unknown';
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((current.resetAt - now) / 1000),
    };
  }

  current.count += 1;
  return {
    allowed: true,
    remaining: limit - current.count,
    retryAfter: 0,
  };
}

export function getRateLimitStatus(key: string, limit: number): RateLimitResult {
  const now = Date.now();
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    if (current) buckets.delete(key);
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((current.resetAt - now) / 1000),
    };
  }

  return {
    allowed: true,
    remaining: limit - current.count,
    retryAfter: Math.ceil((current.resetAt - now) / 1000),
  };
}

export function resetRateLimit(key: string) {
  buckets.delete(key);
}

function rateLimitSecret() {
  return getAdminSessionSecret();
}

function hashRateLimitKey(key: string) {
  return createHash('sha256').update(`${rateLimitSecret()}:${key}`).digest('hex');
}

export async function checkDbRateLimit(
  key: string, limit: number, windowMs: number, options: { refundable?: boolean } = {},
): Promise<RateLimitResult> {
  const hashedKey = hashRateLimitKey(key);
  const resetAt = new Date(Date.now() + windowMs);

  try {
    await ensureSiteSchema();
    const reservationSql = `insert into rate_limit_buckets (key, count, reset_at, updated_at)
       values ($1, 1, $2, now())
       on conflict (key) do update
       set
         count = case
           when rate_limit_buckets.reset_at <= now() then 1
           else rate_limit_buckets.count + 1
         end,
         reset_at = case
           when rate_limit_buckets.reset_at <= now() then $2
           else rate_limit_buckets.reset_at
         end,
         updated_at = now()`;
    const result = await query<{ count: number; reset_at: string; admitted?: boolean }>(
      options.refundable
        // Do not charge denied reservations: otherwise a burst arriving while
        // the queue is full could leave a lockout after admitted work is refunded.
        ? `with reserved as (
             ${reservationSql}
             where rate_limit_buckets.reset_at <= now() or rate_limit_buckets.count < $3
             returning count, reset_at::text
           )
           select count, reset_at, true as admitted from reserved
           union all
           select count, reset_at::text, false as admitted from rate_limit_buckets
           where key = $1 and not exists (select 1 from reserved)
           limit 1`
        : `${reservationSql} returning count, reset_at::text`,
      options.refundable ? [hashedKey, resetAt, limit] : [hashedKey, resetAt],
    );
    const row = result.rows[0];
    const count = Number(row?.count ?? 0);
    const retryAfter = Math.max(0, Math.ceil((new Date(row?.reset_at ?? resetAt).getTime() - Date.now()) / 1000));

    if (!row || row.admitted === false || count > limit) {
      return { allowed: false, remaining: 0, retryAfter };
    }

    let refunded = false;
    return {
      allowed: true, remaining: Math.max(0, limit - count), retryAfter: 0,
      ...(options.refundable ? { refundUnconsumedAttempt: async () => {
        if (refunded) return;
        refunded = true;
        // Never reset other guesses or decrement a later window. The stored
        // timestamp is returned as text so PostgreSQL precision is preserved.
        await query(
          `update rate_limit_buckets set count = greatest(0, count - 1), updated_at = now()
           where key = $1 and reset_at = $2::timestamptz`,
          [hashedKey, row.reset_at],
        );
      } } : {}),
    };
  } catch (error) {
    console.error('DB rate limit failed, using in-memory fallback', error);
    const fallbackKey = `fallback:${hashedKey}`;
    const result = checkRateLimit(fallbackKey, limit, windowMs);
    const reservedBucket = buckets.get(fallbackKey);
    let refunded = false;
    if (options.refundable && result.allowed && reservedBucket) {
      result.refundUnconsumedAttempt = async () => {
        if (refunded) return;
        refunded = true;
        if (buckets.get(fallbackKey) === reservedBucket) reservedBucket.count = Math.max(0, reservedBucket.count - 1);
      };
    }
    return result;
  }
}

export async function resetDbRateLimit(key: string) {
  try {
    await ensureSiteSchema();
    await query(`delete from rate_limit_buckets where key = $1`, [hashRateLimitKey(key)]);
  } catch (error) {
    console.error('Failed to reset DB rate limit', error);
    resetRateLimit(`fallback:${hashRateLimitKey(key)}`);
  }
}
