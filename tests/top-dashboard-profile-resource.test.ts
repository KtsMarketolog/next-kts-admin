import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { detectTopDashboardExpectedProfile } from '../src/shared/lib/topDashboardContentSecurity/dataContract';

test('purchase title hints still recognize ordinary and attributed titles', () => {
  for (const title of ['<title>Управление закупками</title>', '<title lang="ru">КТС — Управление закупками</title>',
    'Дашборд «Управление закупками»', '<script>PARSERS.purchases = {};</script>']) {
    assert.equal(detectTopDashboardExpectedProfile('<input id="snapInp" type="file">' + title), 'purchases');
  }
});

test('unfinished title hints do not rescan the remaining document quadratically', { timeout: 15_000 }, () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { detectTopDashboardExpectedProfile } from ${JSON.stringify(new URL('../src/shared/lib/topDashboardContentSecurity/dataContract.ts', import.meta.url).href)};
    const html = '<input id="snapInp" type="file">' + '<title '.repeat(150_000);
    assert.equal(detectTopDashboardExpectedProfile(html), null);
    console.log('bounded title scan');
  `], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.equal(child.status, 0, `${child.error?.message ?? ''}\n${child.stderr}`);
  assert.match(child.stdout, /bounded title scan/);
});
