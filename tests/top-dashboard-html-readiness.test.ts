import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import type { PoolClient } from 'pg';
import { applyTopDashboardHtmlReadinessMigration } from '../src/shared/lib/db/topDashboardHtmlReadinessMigration';
import { classifyTopDashboardHtmlReadiness } from '../src/shared/lib/db/topDashboardBlocksRepo/htmlReadiness';
import { addStandaloneTopDashboardMarker } from '../src/shared/lib/topDashboardStandalone';
import { ProfitabilityHtmlAnalysisLimitError } from '../src/shared/lib/dashboardProfitabilityRecognition';
import type { TopDashboardPublishedBlockRow } from '../src/shared/lib/db/topDashboardBlocksRepo/records';

function load<T>(file: string, modules: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const instance = { exports: {} };
  new Function('require', 'module', 'exports', source)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, instance, instance.exports);
  return instance.exports as T;
}

const sha = 'a'.repeat(64);
function row(overrides: Partial<TopDashboardPublishedBlockRow> = {}): TopDashboardPublishedBlockRow {
  return { id: '7', title: 'Synthetic report', created_at: '2026-10-23', active_version_id: '12',
    updated_at: '2026-10-23', data_uploaded_at: null, data_as_of: null, html_published_at: '2026-10-23',
    has_compatible_data: false, sha256: sha, self_contained_html: '<html>standalone</html>',
    is_self_contained: null, self_contained_revision: null, self_contained_sha256: null,
    self_contained_error: null, self_contained_retry_pending: false, ...overrides };
}

function harness(rows: TopDashboardPublishedBlockRow[], options: { failWrite?: boolean; failParse?: Error; failParseFor?: string } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let parses = 0;
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('update top_dashboard_block_versions')) {
      if (options.failWrite) throw new Error('Synthetic metadata outage');
      for (const value of rows) {
        if (Number(value.id) === params[0] && Number(value.active_version_id) === params[1] && value.sha256 === params[2]
          && (value.self_contained_revision === null || value.self_contained_revision <= Number(params[4]))) {
          value.is_self_contained = params[3] === null ? null : Boolean(params[3]); value.self_contained_revision = Number(params[4]);
          value.self_contained_sha256 = String(params[2]);
          value.self_contained_error = params[5] === 'analysis_limit' ? 'analysis_limit' : null;
          value.self_contained_retry_pending = value.self_contained_error !== null;
        }
      }
      return { rows: [] };
    }
    const content = sql.includes('versions.html_content,');
    const selected = rows.filter(value => params.length < 2 || Number(value.id) === params[0]);
    return { rows: selected.map(value => ({ ...value,
      ...(content ? { id: value.active_version_id, html_content: value.self_contained_html,
        original_name: 'synthetic.html', file_size: '42' }
        : { self_contained_html: value.has_compatible_data || (value.self_contained_revision === 1
          && value.self_contained_sha256 === value.sha256 && (typeof value.is_self_contained === 'boolean'
            || (value.self_contained_error === 'analysis_limit' && value.self_contained_retry_pending)))
          ? null : value.self_contained_html }),
    })) };
  };
  const readiness = load<typeof import('../src/shared/lib/db/topDashboardBlocksRepo/htmlReadiness')>(
    'src/shared/lib/db/topDashboardBlocksRepo/htmlReadiness.ts', {
      '../client': { query }, '../../topDashboardContentSecurity': { detectTopDashboardDataContract: (html: string) => {
        parses++; if (options.failParse && (!options.failParseFor || html.includes(options.failParseFor))) throw options.failParse;
        return html.includes('standalone')
          ? { mode: 'disabled', profile: 'standalone', snapshotFormat: null }
          : { mode: 'generic', profile: 'generic', snapshotFormat: 'multi-file-v1' };
      } }, '../../dashboardProfitabilityRecognition': { ProfitabilityHtmlAnalysisLimitError },
    });
  const repo = load<typeof import('../src/shared/lib/db/topDashboardBlocksRepo/publishedReads')>(
    'src/shared/lib/db/topDashboardBlocksRepo/publishedReads.ts', {
      '../client': { query }, '../schema': { ensureSiteSchema: async () => {} }, './htmlReadiness': readiness,
    });
  return { repo, readiness, calls, parses: () => parses };
}

test('published lists classify legacy immutable HTML once and another process reuses only stored metadata', async () => {
  const rows = [row(), row({ id: '8', active_version_id: '13', self_contained_html: '<input type="file">' })];
  const h = harness(rows);
  assert.deepEqual((await h.repo.getPublishedTopDashboardBlocks()).map(value => value.id), [7]);
  assert.equal(h.parses(), 2);
  assert.deepEqual((await h.repo.getPublishedTopDashboardBlocks()).map(value => value.id), [7]);
  assert.equal(h.parses(), 2, 'Both true and false classifications are reusable');
  const otherProcess = harness(rows);
  assert.deepEqual((await otherProcess.repo.getPublishedTopDashboardBlocks()).map(value => value.id), [7]);
  assert.equal(otherProcess.parses(), 0);
  assert.equal((await otherProcess.repo.getPublishedTopDashboardBlockOverview(7))?.activeVersionId, 12);
  assert.equal((await otherProcess.repo.getPublishedTopDashboardBlockVersionContent(7, 12))?.htmlContent, '<html>standalone</html>');
  assert.equal(otherProcess.parses(), 0);
  for (const { sql } of h.calls.filter(value => value.sql.includes('as self_contained_html'))) {
    assert.match(sql, /case when native_active_data.id is null and \(/);
    assert.match(sql, /self_contained_revision is distinct from \$[12]/);
    assert.match(sql, /self_contained_sha256 is distinct from native_active.sha256/);
    assert.match(sql, /then native_active.html_content end as self_contained_html/);
  }
  const update = h.calls.find(value => value.sql.startsWith('update'))!;
  assert.deepEqual(update.params, [7, 12, sha, true, 1, null]);
  assert.match(update.sql, /where block_id = \$1 and id = \$2 and sha256 = \$3/);
  assert.match(update.sql, /self_contained_revision <= \$5/);
  assert.doesNotMatch(update.sql, /set\s+html_content|active_version_id|updated_at|delete|insert/i);
});

test('a snapshot-backed report bypasses recognition; current metadata does not bypass fresh publication reads', async () => {
  const rows = [row({ has_compatible_data: true, self_contained_html: '<input type="file">' })];
  const h = harness(rows, { failParse: new Error('Must not parse snapshot-backed HTML') });
  assert.equal((await h.repo.getPublishedTopDashboardBlocks()).length, 1);
  assert.equal(h.parses(), 0);
  rows.splice(0);
  assert.deepEqual(await h.repo.getPublishedTopDashboardBlocks(), []);
  assert.equal(await h.repo.getPublishedTopDashboardBlockOverview(7), null);
  assert.equal(await h.repo.getPublishedTopDashboardBlockVersionContent(7, 12), null);
});

test('hash changes invalidate derived readiness and newer parser revisions cannot be downgraded by an older process', async () => {
  const value = row({ is_self_contained: false, self_contained_revision: 1, self_contained_sha256: 'b'.repeat(64) });
  const h = harness([value]);
  assert.equal((await h.repo.getPublishedTopDashboardBlocks()).length, 1);
  assert.equal(h.parses(), 1);
  assert.equal(value.self_contained_sha256, sha);
  value.self_contained_revision = 2;
  value.is_self_contained = false;
  assert.equal((await h.repo.getPublishedTopDashboardBlocks()).length, 1);
  assert.equal(value.self_contained_revision, 2, 'Do not overwrite newer metadata during rolling deployments');
  assert.equal(value.is_self_contained, false);
});

test('recognition failures never persist false readiness, and optional metadata failures do not fail the read', async (t) => {
  const failure = new Error('Synthetic parsing deadline');
  const failedParse = harness([row()], { failParse: failure });
  await assert.rejects(failedParse.repo.getPublishedTopDashboardBlocks(), error => error === failure);
  assert.equal(failedParse.calls.some(value => value.sql.startsWith('update')), false);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const failedWrite = harness([row()], { failWrite: true });
  assert.equal((await failedWrite.repo.getPublishedTopDashboardBlocks()).length, 1);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /<html>|standalone|Synthetic metadata outage/);
});

test('a typed analysis limit affects only its immutable report and is cached separately until a retry', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const rows = [row({ self_contained_html: '<html>standalone slow</html>' }), row({ id: '8', active_version_id: '13' })];
  const options: { failParse?: Error; failParseFor?: string } = {
    failParse: new ProfitabilityHtmlAnalysisLimitError(), failParseFor: 'slow',
  };
  const h = harness(rows, options);
  assert.deepEqual((await h.repo.getPublishedTopDashboardBlocks()).map(value => value.id), [8]);
  assert.equal(rows[0].is_self_contained, null, 'A timeout is not a completed negative classification');
  assert.equal(rows[0].self_contained_error, 'analysis_limit');
  assert.equal(h.readiness.cachedTopDashboardHtmlReadiness(rows[0]), 'analysis-limit');
  const otherProcess = harness(rows, options);
  assert.deepEqual((await otherProcess.repo.getPublishedTopDashboardBlocks()).map(value => value.id), [8]);
  assert.equal(await otherProcess.repo.getPublishedTopDashboardBlockOverview(7), null);
  assert.equal(await otherProcess.repo.getPublishedTopDashboardBlockVersionContent(7, 12), null);
  assert.equal(otherProcess.parses(), 0, 'Stored cooldown is shared across processes');
  const update = h.calls.find(value => value.sql.startsWith('update'))!;
  assert.deepEqual(update.params, [7, 12, sha, null, 1, 'analysis_limit']);
  assert.match(update.sql, /now\(\) \+ interval '5 minutes'/);
  const listing = h.calls.find(value => value.sql.includes('as self_contained_html'))!.sql;
  assert.match(listing, /self_contained_retry_after <= now\(\)/);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /<html>|slow/);
  options.failParse = undefined;
  rows[0].self_contained_retry_pending = false;
  assert.deepEqual((await otherProcess.repo.getPublishedTopDashboardBlocks()).map(value => value.id), [7, 8]);
  assert.equal(otherProcess.parses(), 1);
  assert.equal(rows[0].is_self_contained, true);
  assert.equal(rows[0].self_contained_error, null, 'Successful retry clears the error metadata');
});

test('readiness uses existing contract semantics for ordinary, standalone and connected HTML', () => {
  assert.equal(classifyTopDashboardHtmlReadiness('<html><body>Read-only page</body></html>'), true);
  assert.equal(classifyTopDashboardHtmlReadiness('<input type="file" id="files">'), false);
  assert.equal(classifyTopDashboardHtmlReadiness(addStandaloneTopDashboardMarker('<input type="file">')), true);
  assert.equal(classifyTopDashboardHtmlReadiness('<script>const DASH_NAME="аналитика_продаж"; const data={format:"kts-bundle"};</script>'), false);
});

test('readiness migration is additive without scanning or rewriting stored HTML/publications', async () => {
  let sql = '';
  await applyTopDashboardHtmlReadinessMigration({ query: async (value: string) => { sql = value; } } as unknown as PoolClient);
  assert.match(sql, /add column is_self_contained boolean/);
  assert.match(sql, /self_contained_revision is not null/);
  assert.doesNotMatch(sql, /\b(select|update|delete|drop|truncate)\b/i);
  assert.doesNotMatch(sql, /html_content|top_dashboard_block_state|top_dashboard_block_data/);
  const upload = readFileSync('src/shared/lib/db/topDashboardBlocksRepo/htmlVersions.ts', 'utf8');
  assert.ok(upload.indexOf('classifyTopDashboardHtmlReadiness(input.htmlContent)') < upload.indexOf('return withTransaction('));
  assert.match(upload, /values \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$5\)/);
});
