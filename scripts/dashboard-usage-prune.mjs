#!/usr/bin/env node
const secret = process.env.DASHBOARD_USAGE_CRON_SECRET;
if (!secret || secret.length < 32 || secret.length > 512) throw new Error('DASHBOARD_USAGE_CRON_SECRET must contain 32–512 characters');
const endpoint = new URL(process.env.DASHBOARD_USAGE_CRON_URL || 'http://127.0.0.1:3000/api/cron/dashboard-usage');
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/cron/dashboard-usage' ||
  (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
  throw new Error('Use HTTPS or a loopback HTTP URL for the usage retention endpoint');
}
try {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(70_000),
    headers: { authorization: `Bearer ${secret}`, accept: 'application/json' } });
  if (!response.ok) throw new Error(`Retention endpoint returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty retention response');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new Error('Unexpectedly large retention response'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (result.ok !== true || !Number.isSafeInteger(result.deleted) || result.deleted < 0 || result.deleted > 10000
    || ![null, 'running'].includes(result.skipped) || ![null, true, false].includes(result.remaining)) throw new Error('Unexpected retention response');
  console.log(JSON.stringify({ ok: true, deleted: result.deleted, remaining: result.remaining, skipped: result.skipped }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Usage retention failed' }));
  process.exitCode = 1;
}
