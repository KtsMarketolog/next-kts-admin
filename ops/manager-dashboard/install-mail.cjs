#!/usr/bin/env node
'use strict';

// Old commissioning commands stop before reading any env or writing files.
function install() {
  return {
    status: 'disabled', reason: 'manual_only',
    message: 'Dashboard mail installation is retired. Upload snapshots manually; use disable-mail.cjs --dry-run / --apply to remove its old cron block.',
  };
}

module.exports = { install };

if (require.main === module) console.log(JSON.stringify(install()));
