#!/usr/bin/env node
const secret = process.env.PRICE_REQUEST_MAIL_CRON_SECRET;
if (!secret || secret.length < 32 || secret.length > 512) throw new Error('PRICE_REQUEST_MAIL_CRON_SECRET must contain 32–512 characters');
const endpoint = new URL(process.env.PRICE_REQUEST_MAIL_CRON_URL || 'http://127.0.0.1:3000/api/cron/price-request-mail');
// Never forward the server credential to a configurable external address.
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/cron/price-request-mail'
  || endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
  throw new Error('Use the loopback HTTP URL for the request mail endpoint');
}
try {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(70_000),
    headers: { authorization: `Bearer ${secret}`, accept: 'application/json' } });
  if (!response.ok) throw new Error(`Mail queue endpoint returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty mail queue response');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new Error('Unexpectedly large mail queue response'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const fields = ['sent', 'deferred', 'pending', 'failed'];
  if (fields.some((field) => !Number.isSafeInteger(result[field]) || result[field] < 0)
    || result.sent + result.deferred > 5) throw new Error('Unexpected mail queue response');
  // Log aggregate counts only, never payloads, recipients or SMTP errors.
  console.log(JSON.stringify(Object.fromEntries(fields.map((field) => [field, result[field]]))));
  if (result.failed > 0) console.error('PRICE_REQUEST_MAIL_REQUIRES_ATTENTION');
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Mail queue failed' }));
  process.exitCode = 1;
}
