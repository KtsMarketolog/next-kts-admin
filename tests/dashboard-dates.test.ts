import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { JSONParser } from '@streamparser/json';
import ts from 'typescript';

import { normalizeDashboardDataDate, formatDashboardTimestamp } from '../src/shared/lib/dashboardDates';
import { createDashboardSnapshotDateInspector } from '../src/shared/lib/dashboardSnapshotDate';
import { readTopDashboardDataUpload } from '../src/app/api/admin/top-dashboard/blocks/dataUpload';
import { applyDashboardDatesMigration } from '../src/shared/lib/db/dashboardDatesMigration';
import { getReportEntries } from '../src/shared/lib/dashboardAccess';
import type { AdminSession } from '../src/shared/lib/adminAuth';

function reportDatesHarness(bindingStatus = 'matched') {
  const calls: Array<{sql: string; params: unknown[]}> = [];
  const personalIds: number[] = [];
  const modules: Record<string, unknown> = {
    '../dashboardAccess': {getReportEntries}, './schema': {ensureSiteSchema: async () => {}},
    './client': {query: async (sql: string, params: unknown[] = []) => {
      calls.push({sql, params});
      return {rows: [{html_published_at: '2026-10-01T07:00:00Z', data_uploaded_at: null, data_as_of: null}]};
    }},
    './managerDashboardRepo': {getPersonalDashboardStatus: async (managerId: number) => {
      personalIds.push(managerId);
      return {bindingStatus, snapshot: {receivedAt: '2026-10-07T05:30:00Z', issued: '2026-10-06'}};
    }},
  };
  const source = readFileSync(new URL('../src/shared/lib/db/dashboardReportDatesRepo.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const loaded = {exports: {} as typeof import('../src/shared/lib/db/dashboardReportDatesRepo')};
  new Function('require', 'module', 'exports', code)((key: string) => {
    assert.ok(key in modules, `Unexpected dependency ${key}`); return modules[key];
  }, loaded, loaded.exports);
  return {read: loaded.exports.getDashboardReportDates, calls, personalIds};
}

function inspect(json: string) {
  const inspector = createDashboardSnapshotDateInspector();
  const parser = new JSONParser({ paths: [], keepStack: false });
  parser.onToken = inspector.visit;
  for (let offset = 0; offset < json.length; offset += 7) parser.write(json.slice(offset, offset + 7));
  if (!parser.isEnded) parser.end();
  return inspector.result();
}

test('dashboard dates are explicit ISO metadata, reject invalid dates and always render upload time in Moscow', () => {
  assert.equal(normalizeDashboardDataDate('2026-02-30'), null);
  assert.equal(normalizeDashboardDataDate('2026-01-01T08:30:00'), null);
  assert.equal(normalizeDashboardDataDate(17777777), null);
  assert.equal(normalizeDashboardDataDate('2026-10-07'), '2026-10-07');
  assert.equal(normalizeDashboardDataDate('2026-10-07T08:30:00+03:00'), '2026-10-07T05:30:00.000Z');
  assert.match(formatDashboardTimestamp('2026-10-07T05:30:00Z'), /07\.10\.2026.*08:30 МСК/);
});

test('snapshot date streaming ignores row dates and handles nested metadata and duplicate last values', () => {
  assert.equal(inspect('{"dataAsOf":"2026-09-30","rows":[{"dataAsOf":"2026-10-01"}]}'), '2026-09-30');
  assert.equal(inspect('{"meta":{"asOf":"2026-09-30"}}'), '2026-09-30');
  assert.equal(inspect('{"metadata":{"savedAt":"2026-09-30T08:30:00Z"}}'), '2026-09-30T08:30:00.000Z');
  assert.equal(inspect('{"meta":{"asOf":"2026-09-30"},"meta":{}}'), null);
  assert.equal(inspect('{"dataAsOf":"2026-09-30","dataAsOf":null}'), null);
  assert.equal(inspect('{"rows":[{"savedAt":"2026-09-30"}],"name":"2026-09-30.json"}'), null);
  assert.equal(inspect('{"meta":{"nested":{"asOf":"2026-09-30"}}}'), null);
});

test('plain and gzip TOP uploads persist metadata dates without treating filenames as data dates', async () => {
  for (const compressed of [false, true]) {
    for (const dataAsOf of ['2026-09-30', undefined]) {
      const bytes = Buffer.from(JSON.stringify({ format: 'kts-bundle', version: 1, n: 1, dict: {}, cols: {}, extra: { plan: {} }, meta: { dataAsOf } }));
      const form = new FormData();
      form.set('file', new File([compressed ? gzipSync(bytes) : bytes], `report-2026-10-07.json${compressed ? '.gz' : ''}`));
      const result = await readTopDashboardDataUpload(new Request('https://example.test/upload', { method: 'PUT', body: form }));
      assert.ok(result.parsed);
      assert.equal(result.parsed.upload.dataAsOf, dataAsOf ?? null);
    }
  }
});

test('dates migration only adds nullable metadata and does not invent dates for existing snapshots', async () => {
  let sql = '';
  await applyDashboardDatesMigration({ query: async (text: string) => { sql = text; } } as never);
  assert.match(sql, /add column if not exists data_as_of text/);
  assert.doesNotMatch(sql, /update|delete|drop|default now/i);
});

test('catalog query dates come from active data and publication, never renaming a block', () => {
  const source = readFileSync(new URL('../src/shared/lib/db/topDashboardBlocksRepo.ts', import.meta.url), 'utf8');
  const catalogQueries = source.slice(source.indexOf('export async function getTopDashboardBlocks'), source.indexOf('export async function createTopDashboardBlock('));
  assert.match(catalogQueries, /native_active_data\.created_at::text as data_uploaded_at/);
  assert.match(catalogQueries, /native_active\.first_published_at::text as html_published_at/);
  assert.doesNotMatch(catalogQueries, /greatest\(blocks\.updated_at/);
});

test('special report dates respect explicit report grants and never disclose another personal audience', async () => {
  const session: AdminSession = {role: 'manager', sessionId: 'synthetic', managerId: 71, dashboardAccess: []};
  const denied = reportDatesHarness();
  assert.deepEqual(await denied.read(session), []);
  assert.deepEqual(denied.calls, []);
  const own = reportDatesHarness();
  const dates = await own.read({...session, dashboardAccess: ['manager:development', 'manager:support']});
  assert.deepEqual(dates.map(({key}) => key), ['manager:development']);
  assert.equal(dates[0].dataUploadedAt, '2026-10-07T05:30:00Z');
  assert.equal(dates[0].dataAsOf, '2026-10-06');
  assert.deepEqual(own.personalIds, [71]);
  assert.deepEqual(own.calls[0].params, ['development', false, 'manager']);
});

test('a missing or ambiguous personal email binding hides retained private snapshot dates', async () => {
  for (const bindingStatus of ['missing_email', 'ambiguous', 'mismatch']) {
    const harness = reportDatesHarness(bindingStatus);
    const [dates] = await harness.read({role: 'support_manager', sessionId: 'synthetic', managerId: 72,
      dashboardAccess: ['manager:support']});
    assert.equal(dates.dataUploadedAt, null);
    assert.equal(dates.dataAsOf, null);
    assert.equal(dates.htmlPublishedAt, '2026-10-01T07:00:00Z');
  }
});
