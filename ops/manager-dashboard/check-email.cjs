#!/usr/bin/env node
'use strict';

// Compatibility entrypoint for an old cron job. No env, network or database access.
async function checkManagerDashboardEmail(options = {}) {
  const log = options.log ?? console.log;
  log('Manager dashboard mail import is disabled; upload snapshots manually.');
  return 0;
}

module.exports = { checkManagerDashboardEmail };

if (require.main === module) {
  checkManagerDashboardEmail().then((exitCode) => { process.exitCode = exitCode; });
}
