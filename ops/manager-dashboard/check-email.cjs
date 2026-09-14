#!/usr/bin/env node
'use strict';

// Proposed cron entrypoint. Installing this file does not enable or schedule imports.
// Supply the private application environment with Node's --env-file flag; never pass the token as an argument.
const FAILURE_MESSAGE = 'Manager dashboard mail check failed; inspect the protected admin import log.';
const COUNT_FIELDS = ['checkedMessages', 'imported', 'duplicates', 'stale', 'failed'];

// Importing this module never sends a request or changes process.exitCode.
async function checkManagerDashboardEmail({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  error = console.error,
  now = () => new Date(),
} = {}) {
  try {
    if (env.MANAGER_DASHBOARD_MAIL_ENABLED !== 'true'
      || !env.MANAGER_DASHBOARD_MAIL_ALLOWED_FROM?.trim()) {
      log('Manager dashboard mail import is disabled.');
      return 0;
    }
    const secret = env.CRON_SECRET?.trim();
    if (!secret) throw new Error('Cron authentication is not configured');
    const response = await fetchImpl('http://127.0.0.1:3000/api/cron/manager-dashboard-import', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(240_000),
    });
    if (!response.ok) throw new Error('Cron request was unsuccessful');
    const result = await response.json();
    if (!result || Array.isArray(result) || typeof result !== 'object'
      || !['completed', 'busy', 'disabled'].includes(result.status)
      || !COUNT_FIELDS.every((field) => Number.isSafeInteger(result[field]) && result[field] >= 0)) {
      throw new Error('Invalid cron response');
    }
    // Only validated status/counts enter shared logs, never arbitrary response fields or error text.
    log(JSON.stringify({
      at: now().toISOString(), status: result.status,
      checkedMessages: result.checkedMessages, imported: result.imported,
      duplicates: result.duplicates, stale: result.stale, failed: result.failed,
    }));
    // A locally enabled wrapper must not silently accept a disabled application worker.
    if (result.status === 'disabled') throw new Error('Application import is disabled');
    return result.failed > 0 ? 1 : 0;
  } catch {
    error(FAILURE_MESSAGE);
    return 1;
  }
}

module.exports = { checkManagerDashboardEmail };

if (require.main === module) {
  checkManagerDashboardEmail().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    console.error(FAILURE_MESSAGE);
    process.exitCode = 1;
  });
}
