import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseDashboardUsageBatch, readDashboardUsageMessageDetails, DASHBOARD_USAGE_MARKER } from '../src/shared/lib/dashboardUsage';
import { applyDashboardUsageCapturedTimeMigration } from '../src/shared/lib/db/dashboardUsageMigration';
import { buildDashboardUsageWorkbook } from '../src/shared/lib/dashboardUsageExport';

const id = 'captured_time_test_event';
const capturedAt = '2026-10-22T01:02:03.456Z';
const batch = { dashboardKey: 'top:4', preview: false, versionId: 7, events: [{ id, action: 'filter_changed', capturedAt }] };

test('parent timestamps require an explicit parser opt-in; iframe messages cannot supply them', () => {
  assert.throws(() => parseDashboardUsageBatch(batch), /Некорректные события/);
  assert.deepEqual(parseDashboardUsageBatch(batch, { allowCapturedAt: true }), batch);
  assert.equal(readDashboardUsageMessageDetails({ marker: DASHBOARD_USAGE_MARKER, type: 'event', nonce: id,
    action: 'filter_changed', capturedAt }, id), null);
  for (const value of [null, 5, '', 'yesterday', '2026-02-31T01:02:03.456Z', '2026-10-22', '0000-01-01T00:00:00.000Z']) {
    assert.throws(() => parseDashboardUsageBatch({ ...batch, events: [{ ...batch.events[0], capturedAt: value }] }, { allowCapturedAt: true }));
  }
  assert.equal(parseDashboardUsageBatch({ ...batch, events: [{ id, action: 'viewing_time', durationSeconds: 15,
    viewingWindowId: 'captured_time_window_1', capturedAt }] }, { allowCapturedAt: true }).events[0].capturedAt, capturedAt);
  assert.throws(() => parseDashboardUsageBatch({ ...batch, events: [{ id: `upload_${'a'.repeat(64)}`, action: 'report_open' }] }), /Некорректные события/);
});

test('capture metadata migration preserves all existing timestamps and requires an explicit clock source', async () => {
  let sql = '';
  await applyDashboardUsageCapturedTimeMigration({ query: async (text: string) => { sql = text; } } as never);
  assert.match(sql, /add column captured_at timestamptz/);
  assert.match(sql, /captured_source in \('browser','server'\)/);
  assert.doesNotMatch(sql, /delete|drop|update|created_at/i);
});

test('Excel keeps server registration and original browser time in distinct labelled columns', () => {
  const bytes = buildDashboardUsageWorkbook({ view: 'events', rows: [{ id: '1', actorKey: 'admin:1', actorName: 'Test', actorRole: 'admin',
    dashboardKey: 'top:4', dashboardTitle: 'Report', action: 'filter_changed', preview: false, versionId: 7,
    createdAt: '2026-10-23T10:00:00.000Z', capturedAt, capturedSource: 'browser', hasProfitabilityDetails: false,
    upload: null, uploadType: null, durationSeconds: null }] }, {});
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets['События'], { header: 1 });
  assert.equal(rows[0][1], 'Зарегистрировано, МСК');
  assert.equal(rows[0][13], 'Зафиксировано источником, МСК');
  assert.match(rows[1][1], /23\.10/);
  assert.match(rows[1][13], /22\.10/);
  assert.equal(rows[1][14], 'Часы браузера (не подтверждены сервером)');
});
