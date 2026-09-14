#!/usr/bin/env node
'use strict';

// Proposed cron entrypoint. Installing this file does not enable or schedule imports.
// Supply the private application environment with Node's --env-file flag; never pass the token as an argument.
async function main() {
  if (process.env.MANAGER_DASHBOARD_MAIL_ENABLED !== 'true'
    || !process.env.MANAGER_DASHBOARD_MAIL_ALLOWED_FROM?.trim()) {
    console.log('Manager dashboard mail import is disabled.');
    return;
  }
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) throw new Error('Cron authentication is not configured');
  const response = await fetch('http://127.0.0.1:3000/api/cron/manager-dashboard-import', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) throw new Error(`Manager dashboard mail check returned HTTP ${response.status}`);
  const result = await response.json();
  // Do not write sender addresses, filenames, employee names, tokens, or response bodies to a shared cron log.
  console.log(JSON.stringify({
    at: new Date().toISOString(), status: result.status,
    checkedMessages: result.checkedMessages, imported: result.imported,
    duplicates: result.duplicates, stale: result.stale, failed: result.failed,
  }));
  if (result.failed > 0) process.exitCode = 1;
}

main().catch(() => {
  console.error('Manager dashboard mail check failed; inspect the protected admin import log.');
  process.exitCode = 1;
});
