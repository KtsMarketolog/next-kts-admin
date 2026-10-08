import { timingSafeEqual } from 'node:crypto';
import { pruneExpiredDashboardUsage } from '@/shared/lib/db/dashboardUsageRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

async function hasEmptyBody(request: Request) {
  if (request.signal.aborted || request.bodyUsed) return false;
  // Next's Node adapter supplies a stream even for a POST with zero bytes.
  if (!request.body) return true;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = request.body.getReader(); } catch { return false; }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => {
        // Do not buffer the body or trust Content-Length. Any payload is invalid.
        for (let chunks = 0; chunks < 32; chunks++) {
          const { done, value } = await reader.read();
          if (done) return !request.signal.aborted;
          if (value.byteLength > 0) return false;
        }
        return false;
      })(),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 2_000);
        onAbort = () => resolve(false);
        request.signal.addEventListener('abort', onAbort, { once: true });
        if (request.signal.aborted) onAbort();
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    if (onAbort) request.signal.removeEventListener('abort', onAbort);
    // Cancellation of a tee'd Next stream can await the other consumer.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  const secret = process.env.DASHBOARD_USAGE_CRON_SECRET;
  if (!secret || secret.length < 32 || secret.length > 512) return Response.json({ error: 'Usage retention scheduler is not configured' }, { status: 503, headers });
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const actual = Buffer.from(token);
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  // The cutoff and deletion scope are server-defined, never supplied by callers.
  if (!await hasEmptyBody(request)) return Response.json({ error: 'Request body is not accepted' }, { status: 400, headers });
  try {
    return Response.json(await pruneExpiredDashboardUsage(), { headers });
  } catch {
    console.error('DASHBOARD_USAGE_RETENTION_FAILED');
    return Response.json({ error: 'Usage retention failed; retry later' }, { status: 503, headers });
  }
}
