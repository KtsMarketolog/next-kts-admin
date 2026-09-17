import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { selectWorkingVersionPair } from '../src/features/admin/top-dashboard/topDashboardHistory';

test('working history follows exact active and previous pointers, not recency', () => {
  const versions = [{ id: 72 }, { id: 70 }, { id: 69 }, { id: 44 }];
  assert.deepEqual(selectWorkingVersionPair(versions, 70, 72), [{ id: 70 }, { id: 72 }]);
  assert.deepEqual(selectWorkingVersionPair(versions, 72, 70), [{ id: 72 }, { id: 70 }]);
  assert.equal(versions.length, 4, 'previous HTML data is not removed from the API model');
});

test('history does not substitute arbitrary archive rows for missing pointers', () => {
  assert.deepEqual(selectWorkingVersionPair([{ id: 3 }], 4, null), []);
  assert.deepEqual(selectWorkingVersionPair([{ id: 3 }], 3, 3), [{ id: 3 }]);
  assert.deepEqual(selectWorkingVersionPair([{ id: 3 }], null, 3), [{ id: 3 }]);
});

test('TOP management separates the working HTML pair and drafts and labels previous HTML', () => {
  const source = readFileSync(new URL('../src/features/admin/top-dashboard/AdminTopDashboardSection.tsx', import.meta.url), 'utf8');
  assert.match(source, /versions: workingHtmlVersions/);
  assert.match(source, /versions: overview\.versions\.filter\(\(version\) => version\.status === 'draft'\)/);
  assert.match(source, /workingDataVersions\.map/);
  assert.match(source, /versionCountLabel\(workingDataVersions\.length\)/);
  assert.match(source, /version\.id === overview\.previousVersionId \? 'previous' : version\.status/);
});

test('maintenance apply rejects missing explicit storage before connecting to a database', () => {
  const env = { ...process.env };
  delete env.TOP_DASHBOARD_DATA_DIR;
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/prune-top-dashboard-history.ts',
    '--block-id', '7', '--html-active', '51', '--html-previous', '40',
    '--data-active', '72', '--data-previous', '70', '--apply'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--apply requires an explicit TOP_DASHBOARD_DATA_DIR/);
  assert.doesNotMatch(result.stderr, /DATABASE_URL/);
});
