import assert from 'node:assert/strict';
import test from 'node:test';
import { DASHBOARD_USAGE_MARKER, parseDashboardUsageBatch, parseDashboardUsageEvent, parseDashboardUsageUpload, readDashboardUsageMessageDetails } from '../src/shared/lib/dashboardUsage';
import { applyDashboardUsageDetailsMigration } from '../src/shared/lib/db/dashboardUsageDetailsMigration';

const id = 'synthetic-event-123456';
const upload = { name: 'Счёт № 123.xlsx', size: 1024 };
const batch = (event: unknown) => ({ dashboardKey: 'top:4', preview: false, versionId: 7, events: [event] });

test('upload metadata accepts only a bounded basename and size, never paths, raw data or form values', () => {
  assert.deepEqual(parseDashboardUsageUpload(upload), upload);
  assert.equal(parseDashboardUsageUpload({ ...upload, name: 'я'.repeat(255) }).name.length, 255);
  for (const name of ['', '  ', '.', '..', '../invoice.xlsx', 'C:\\private.xlsx', 'a\nb', 'a\u202eb', 'x'.repeat(256)]) {
    assert.throws(() => parseDashboardUsageUpload({ ...upload, name }), /Некорректные события/);
  }
  for (const size of [-1, 1.5, Infinity, '1024', 2147483649]) assert.throws(() => parseDashboardUsageUpload({ ...upload, size }));
  for (const extra of [{ contents: 'private' }, { password: 'secret' }, { path: '/private' }]) assert.throws(() => parseDashboardUsageUpload({ ...upload, ...extra }));
  assert.deepEqual(parseDashboardUsageBatch(batch({ id, action: 'data_loaded', upload })).events[0].upload, upload);
  for (const action of ['report_open', 'filter_changed', 'viewing_time']) assert.throws(() => parseDashboardUsageBatch(batch({ id, action, upload })));
});

test('server upload confirmation is never accepted from ordinary client API or iframe messages', () => {
  const event = { id, action: 'file_uploaded', upload, uploadType: 'html' };
  assert.throws(() => parseDashboardUsageBatch(batch(event)));
  assert.equal(parseDashboardUsageBatch(batch(event), { allowServerUpload: true }).events[0].uploadType, 'html');
  for (const uploadType of ['unknown', ['html'], null]) assert.throws(() => parseDashboardUsageEvent({ ...event, uploadType }, { allowServerUpload: true }));
  assert.throws(() => parseDashboardUsageEvent({ id, action: 'file_uploaded', uploadType: 'html' }, { allowServerUpload: true }));
  assert.equal(readDashboardUsageMessageDetails({ marker: DASHBOARD_USAGE_MARKER, type: 'event', nonce: id, action: 'file_uploaded', upload }, id), null);
});

test('view duration is bounded and requires a shared deduplication window; iframe cannot manufacture it', () => {
  const event = { id, action: 'viewing_time', durationSeconds: 15, viewingWindowId: 'synthetic-window-12345' };
  assert.deepEqual(parseDashboardUsageEvent(event), event);
  for (const durationSeconds of [0, -1, 61, 2.5, '15']) assert.throws(() => parseDashboardUsageEvent({ ...event, durationSeconds }));
  for (const viewingWindowId of ['', 'short', '../file', 'x'.repeat(81)]) assert.throws(() => parseDashboardUsageEvent({ ...event, viewingWindowId }));
  assert.throws(() => parseDashboardUsageEvent({ ...event, action: 'filter_changed' }));
  assert.throws(() => parseDashboardUsageEvent({ ...event, upload }));
  assert.equal(readDashboardUsageMessageDetails({ marker: DASHBOARD_USAGE_MARKER, type: 'event', nonce: id, action: 'viewing_time' }, id), null);
});

test('iframe details reader retains only reviewed successful import metadata and pins the nonce', () => {
  const message = { marker: DASHBOARD_USAGE_MARKER, type: 'event', nonce: id, action: 'data_loaded', upload };
  assert.deepEqual(readDashboardUsageMessageDetails(message, id), { action: 'data_loaded', upload });
  assert.equal(readDashboardUsageMessageDetails(message, 'another-valid-nonce'), null);
  assert.equal(readDashboardUsageMessageDetails({ ...message, path: '/private/file' }, id), null);
  assert.equal(readDashboardUsageMessageDetails({ ...message, upload: { ...upload, secret: 'private' } }, id), null);
});

test('metadata migration is additive, cascades only with expired event deletion and bounds nullable fields', async () => {
  let sql = '';
  await applyDashboardUsageDetailsMigration({ query: async (value: string) => { sql = value; } } as never);
  assert.match(sql, /create table dashboard_usage_event_details/);
  assert.match(sql, /references dashboard_usage_events\(id\) on delete cascade/);
  assert.match(sql, /upload_size is not null and upload_size between 0 and 2147483648/);
  assert.match(sql, /duration_seconds is not null and duration_seconds between 1 and 60/);
  assert.doesNotMatch(sql, /drop table|delete from|truncate|update |password|top_dashboard_block_versions/i);
});
