/** Explicit maintenance only; never run on reads, startup or as a migration. */
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { pruneTopDashboardBlockHistory } from '../src/shared/lib/db/topDashboardBlocksRepo';
import { deleteTopDashboardDataFiles } from '../src/shared/lib/topDashboardDataStorage';

const usage = 'Usage: node --env-file=/path/to/env --import tsx scripts/prune-top-dashboard-history.ts '
  + '--block-id ID --html-active ID|null --html-previous ID|null '
  + '--data-active ID|null --data-previous ID|null [--apply]';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return;
  }
  const allowed = new Set(['--block-id', '--html-active', '--html-previous', '--data-active', '--data-previous']);
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply' && !apply) {
      apply = true;
      continue;
    }
    if (!allowed.has(flag) || values.has(flag) || index + 1 >= args.length) throw new Error(usage);
    values.set(flag, args[++index]);
  }
  function id(flag: string, nullable = true): number | null {
    const value = values.get(flag);
    if (nullable && value === 'null') return null;
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(usage);
    return Number(value);
  }
  if (apply) {
    // A maintenance shell does not inherit the application's PM2 storage setting.
    // Never acknowledge file deletions against an accidental cwd-based directory.
    const configured = process.env.TOP_DASHBOARD_DATA_DIR?.trim();
    if (!configured) throw new Error('--apply requires an explicit TOP_DASHBOARD_DATA_DIR');
    const directory = await realpath(configured);
    if (directory === path.parse(directory).root || !(await stat(directory)).isDirectory()) {
      throw new Error('Invalid TOP_DASHBOARD_DATA_DIR');
    }
    process.env.TOP_DASHBOARD_DATA_DIR = directory;
  }
  const result = await pruneTopDashboardBlockHistory({
    blockId: id('--block-id', false)!,
    expectedActiveHtmlVersionId: id('--html-active'),
    expectedPreviousHtmlVersionId: id('--html-previous'),
    expectedActiveDataVersionId: id('--data-active'),
    expectedPreviousDataVersionId: id('--data-previous'),
    dryRun: !apply,
  });
  console.log(JSON.stringify(result));
  if (apply) {
    // The transaction has committed; the durable queue protects against interruption.
    await deleteTopDashboardDataFiles(result.prunedStoragePaths);
    console.log('Committed. Unreferenced files are deleted or durably queued for retry.');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'History maintenance failed');
  process.exitCode = 1;
}).finally(async () => {
  await globalThis.__ktsPgPool?.end();
});
