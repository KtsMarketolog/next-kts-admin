#!/usr/bin/env node
// No financial data or secrets are written to disk by this caller.
const secret = process.env.CURRENCY_DASHBOARD_CRON_SECRET;
if (!secret || secret.length < 32) throw new Error('CURRENCY_DASHBOARD_CRON_SECRET must contain at least 32 characters');
const endpoint = new URL(process.env.CURRENCY_DASHBOARD_CRON_URL || 'http://127.0.0.1:3000/api/cron/currency-dashboard');
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/cron/currency-dashboard' ||
  (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
  throw new Error('Use HTTPS or a loopback HTTP URL for the currency-dashboard cron endpoint');
}

try {
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
    headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Refresh endpoint returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > 256 * 1024) throw new Error('Unexpectedly large refresh response');
  const body = await response.json();
  // The endpoint can wrap its operational result as {ok:true, result:...}.
  const result = body.result ?? body;
  if (typeof result.ok !== 'boolean' || !result.baseline || !Array.isArray(result.sources)) throw new Error('Unexpected refresh response');
  console.log(JSON.stringify({
    ok: result.ok, at: result.at, skipped: result.skipped, baseline: result.baseline,
    sources: result.sources.map(({ kind, fetchedAt, stale, error }) => ({ kind, fetchedAt, stale, error })),
  }));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Currency refresh failed' }));
  process.exitCode = 1;
}
