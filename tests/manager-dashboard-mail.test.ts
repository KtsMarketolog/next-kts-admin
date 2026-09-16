import assert from 'node:assert/strict';
import test from 'node:test';

import { getManagerDashboardMailStatus, importManagerDashboardFromEmail } from '../src/shared/lib/managerDashboardMail';

test('dashboard mail stays disabled even with a complete stale enabled configuration', async () => {
  for (const env of [undefined, {}, {
    MANAGER_DASHBOARD_MAIL_ENABLED: 'true',
    MANAGER_DASHBOARD_MAIL_ALLOWED_FROM: 'sender@example.test',
    MANAGER_DASHBOARD_MAIL_HOST: 'imap.example.test',
    MANAGER_DASHBOARD_MAIL_USER: 'private-user',
    MANAGER_DASHBOARD_MAIL_PASSWORD: 'private-password',
    STOCK_MAIL_PASSWORD: 'private-stock-password',
    SMTP_PASSWORD: 'private-smtp-password',
  }]) {
    assert.deepEqual(getManagerDashboardMailStatus(env), { enabled: false, configured: false, reason: 'manual_only' });
    const result = await importManagerDashboardFromEmail({ env });
    assert.deepEqual(result, {
      status: 'disabled', reason: 'manual_only', checkedMessages: 0, attachments: 0,
      imported: 0, duplicates: 0, stale: 0, failed: 0,
      skipped: { sender: 0, messageSize: 0, noAttachment: 0, age: 0 },
      results: [], truncatedResults: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /private-|sender@example/);
  }
});

test('retired importer never reads credentials, constructs clients or touches receipt/journal storage', async () => {
  const forbidden = new Proxy({}, {
    get() { assert.fail('Retired importer must not read environment or dependencies'); },
    ownKeys() { assert.fail('Retired importer must not enumerate environment or dependencies'); },
  });
  assert.equal(getManagerDashboardMailStatus(forbidden).enabled, false);
  assert.equal((await importManagerDashboardFromEmail({ env: forbidden, dependencies: forbidden })).status, 'disabled');
  assert.equal((await importManagerDashboardFromEmail(forbidden)).reason, 'manual_only');
});

test('separate retired importer calls do not share mutable result state', async () => {
  const first = await importManagerDashboardFromEmail();
  first.skipped.sender = 42;
  const second = await importManagerDashboardFromEmail();
  assert.equal(second.skipped.sender, 0);
});
