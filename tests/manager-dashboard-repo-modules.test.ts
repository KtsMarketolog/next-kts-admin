import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const entry = new URL('../src/shared/lib/db/managerDashboardRepo.ts', import.meta.url);
const directory = new URL('./managerDashboardRepo/', entry);
const parse = (url: URL) => ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true);

test('personal repository facade retains the complete public API without exposing internal operations', () => {
  const source = parse(entry);
  const expectedValues = [
    'activatePersonalDashboardHtml', 'confirmPersonalDashboardSnapshotReplacement', 'confirmPersonalDashboardSnapshotRollback',
    'createPersonalDashboardHtml', 'deletePersonalDashboardHtml', 'getPersonalDashboardHtml', 'getPersonalDashboardReportDates',
    'getPersonalDashboardReviewHtml', 'getPersonalDashboardReviewOverview', 'getPersonalDashboardReviewSnapshot',
    'getPersonalDashboardSnapshot', 'getPersonalDashboardStatus', 'importPersonalDashboardSnapshot', 'listPersonalDashboardAdmin',
    'listPersonalDashboardImports', 'preparePersonalDashboardSnapshotReplacement', 'preparePersonalDashboardSnapshotRollback',
    'recordPersonalDashboardImportFailure', 'resolvePersonalDashboardManager', 'resolvePersonalDashboardRecipient',
  ];
  const expectedTypes = [
    'ImportPersonalDashboardSnapshotInput', 'PersonalDashboardHtmlVersion', 'PersonalDashboardImportResult',
    'PersonalDashboardImportStatus', 'PersonalDashboardManagerBinding', 'PersonalDashboardRecipient',
    'PersonalDashboardRecipientBinding', 'PersonalDashboardReportDates', 'PersonalDashboardReviewer',
    'PersonalDashboardSnapshot', 'PersonalDashboardStatus',
  ];
  const actual = { values: [] as string[], types: [] as string[] };
  for (const statement of source.statements) {
    assert.ok(ts.isExportDeclaration(statement), 'the stable entry point only delegates; no new queries or side effects');
    assert.ok(statement.exportClause && ts.isNamedExports(statement.exportClause), 'explicit exports prevent accidental public helpers');
    for (const item of statement.exportClause.elements) {
      actual[statement.isTypeOnly || item.isTypeOnly ? 'types' : 'values'].push(item.name.text);
    }
  }
  assert.deepEqual(actual.values.sort(), expectedValues.sort());
  assert.deepEqual(actual.types.sort(), expectedTypes.sort());
});

test('personal repository implementation has no cycles or back imports through the facade', () => {
  const graph = new Map<string, string[]>();
  for (const file of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
    const dependencies = parse(new URL(file, directory)).statements.filter(ts.isImportDeclaration)
      .map(statement => (statement.moduleSpecifier as ts.StringLiteral).text);
    assert.equal(dependencies.some(dependency => dependency === '../managerDashboardRepo'), false, file);
    graph.set(file, dependencies.filter(name => name.startsWith('./')).map(name => `${name.slice(2)}.ts`));
  }
  const visit = (file: string, trail: string[]) => {
    assert.equal(trail.includes(file), false, `Dependency cycle: ${[...trail, file].join(' -> ')}`);
    assert.ok(graph.has(file), `Missing local module: ${file}`);
    for (const dependency of graph.get(file)!) visit(dependency, [...trail, file]);
  };
  for (const file of graph.keys()) visit(file, []);
});

test('types, validation and result mapping stay independent from database and authorization operations', () => {
  for (const file of ['types.ts', 'validation.ts', 'records.ts']) {
    const source = parse(new URL(file, directory));
    const dependencies = source.statements.filter(ts.isImportDeclaration)
      .map(statement => (statement.moduleSpecifier as ts.StringLiteral).text);
    assert.equal(dependencies.some(name => /(?:client|schema|access|importJournal|snapshotReplacement)$/.test(name)), false, file);
    assert.doesNotMatch(source.text, /\b(?:withTransaction|ensureSiteSchema)\s*\(|\b(?:client|pool)\.query\s*\(/, file);
  }
});

test('read-only modules do not acquire ownership of import, publication or replacement mutations', () => {
  for (const file of ['snapshotReads.ts', 'reviewReads.ts', 'reportDates.ts', 'adminReads.ts']) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    assert.doesNotMatch(source, /\b(?:insert\s+into|delete\s+from|update\s+personal_dashboard_)\b/i, file);
    assert.doesNotMatch(source, /\b(?:createPersonalReplacementToken|enqueueDashboardUploadUsage)\s*\(/, file);
  }
});
