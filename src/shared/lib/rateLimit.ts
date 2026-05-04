import { createHash } from 'crypto';

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
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'kts-rate-limit';
}

function hashRateLimitKey(key: string) {
  return createHash('sha256').update(`${rateLimitSecret()}:${key}`).digest('hex');
}

export async function checkDbRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const hashedKey = hashRateLimitKey(key);
  const resetAt = new Date(Date.now() + windowMs);

  try {
    await ensureSiteSchema();
    const result = await query<{ count: number; reset_at: string }>(
      `insert into rate_limit_buckets (key, count, reset_at, updated_at)
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
         updated_at = now()
       returning count, reset_at::text`,
      [hashedKey, resetAt],
    );
    const row = result.rows[0];
    const count = Number(row?.count ?? 0);
    const retryAfter = Math.max(0, Math.ceil((new Date(row?.reset_at ?? resetAt).getTime() - Date.now()) / 1000));

    if (count > limit) {
      return { allowed: false, remaining: 0, retryAfter };
    }

    return { allowed: true, remaining: Math.max(0, limit - count), retryAfter: 0 };
  } catch (error) {
    console.error('DB rate limit failed, using in-memory fallback', error);
    return checkRateLimit(`fallback:${hashedKey}`, limit, windowMs);
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
