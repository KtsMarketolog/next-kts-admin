import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as repository from '../src/shared/lib/db/topDashboardBlocksRepo';
import * as blocks from '../src/shared/lib/db/topDashboardBlocksRepo/blocks';
import * as history from '../src/shared/lib/db/topDashboardBlocksRepo/history';
import * as htmlVersions from '../src/shared/lib/db/topDashboardBlocksRepo/htmlVersions';
import * as publication from '../src/shared/lib/db/topDashboardBlocksRepo/publication';
import * as publishedReads from '../src/shared/lib/db/topDashboardBlocksRepo/publishedReads';
import * as reads from '../src/shared/lib/db/topDashboardBlocksRepo/reads';
import * as snapshots from '../src/shared/lib/db/topDashboardBlocksRepo/snapshots';
import * as types from '../src/shared/lib/db/topDashboardBlocksRepo/types';

test('dashboard block repository preserves its public operations and error identities without exposing internal helpers', () => {
  const expected = {
    TopDashboardBlockNotFoundError: types.TopDashboardBlockNotFoundError,
    TopDashboardBlockTitleValidationError: types.TopDashboardBlockTitleValidationError,
    TopDashboardBlockStateNotFoundError: types.TopDashboardBlockStateNotFoundError,
    TopDashboardDraftLimitError: types.TopDashboardDraftLimitError,
    TopDashboardDataStorageLimitError: types.TopDashboardDataStorageLimitError,
    pruneTopDashboardBlockHistory: history.pruneTopDashboardBlockHistory,
    getPublishedTopDashboardBlocks: publishedReads.getPublishedTopDashboardBlocks,
    getPublishedTopDashboardBlockOverview: publishedReads.getPublishedTopDashboardBlockOverview,
    isActiveTopDashboardHtmlVersion: publishedReads.isActiveTopDashboardHtmlVersion,
    isPublishedTopDashboardBlockVersion: publishedReads.isPublishedTopDashboardBlockVersion,
    getPublishedTopDashboardBlockVersionContent: publishedReads.getPublishedTopDashboardBlockVersionContent,
    getTopDashboardBlocks: reads.getTopDashboardBlocks,
    getTopDashboardBlockOverview: reads.getTopDashboardBlockOverview,
    getActiveTopDashboardBlockDataContent: reads.getActiveTopDashboardBlockDataContent,
    getActiveTopDashboardBlockHtmlContent: reads.getActiveTopDashboardBlockHtmlContent,
    getTopDashboardBlockVersionContent: reads.getTopDashboardBlockVersionContent,
    normalizeTopDashboardBlockTitle: blocks.normalizeTopDashboardBlockTitle,
    createTopDashboardBlock: blocks.createTopDashboardBlock,
    renameTopDashboardBlock: blocks.renameTopDashboardBlock,
    deleteTopDashboardBlock: blocks.deleteTopDashboardBlock,
    createTopDashboardBlockVersion: htmlVersions.createTopDashboardBlockVersion,
    deleteTopDashboardBlockVersion: htmlVersions.deleteTopDashboardBlockVersion,
    activateTopDashboardBlockVersion: publication.activateTopDashboardBlockVersion,
    createAndActivateTopDashboardBlockDataVersion: snapshots.createAndActivateTopDashboardBlockDataVersion,
    activateTopDashboardBlockDataVersion: snapshots.activateTopDashboardBlockDataVersion,
  } satisfies typeof repository;
  assert.deepEqual(Object.keys(repository).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    assert.equal(repository[key], expected[key], key);
  }
  assert.ok(new types.TopDashboardBlockNotFoundError() instanceof repository.TopDashboardBlockNotFoundError);
});

test('dashboard block repository modules have no runtime cycles or imports through their compatibility facade', () => {
  const directory = new URL('../src/shared/lib/db/topDashboardBlocksRepo/', import.meta.url);
  const dependencies = new Map<string, string[]>();
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
    const source = ts.createSourceFile(name, readFileSync(new URL(name, directory), 'utf8'), ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = statement.moduleSpecifier.text;
      assert.notEqual(target, '../topDashboardBlocksRepo', `${name} must not import its own facade`);
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.every((element) => element.isTypeOnly)) continue;
      if (target.startsWith('./')) imports.push(`${target.slice(2)}.ts`);
    }
    dependencies.set(name, imports);
  }
  const visit = (name: string, ancestors: string[]) => {
    assert.ok(!ancestors.includes(name), `Runtime cycle: ${[...ancestors, name].join(' -> ')}`);
    for (const dependency of dependencies.get(name) ?? []) visit(dependency, [...ancestors, name]);
  };
  for (const name of dependencies.keys()) visit(name, []);
});
