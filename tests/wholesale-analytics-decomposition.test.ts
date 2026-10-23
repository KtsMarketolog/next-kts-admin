import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadAnalyticsModule, runAnalyticsScenario } from './helpers/wholesaleAnalyticsHarness';

// Response digests captured before decomposition from commit 1211726 stay intact.
// SQL digests intentionally updated for the shared client-event aggregate and
// two-scan period comparison; old/new SQL equivalence runs in isolated PostgreSQL
// (wholesale-analytics-db.integration.ts). Ordered parameters and concurrency
// remain protected here; this is not merely a snapshot of selected response fields.
const baseline = [
  {"scenario":"admin","period":"7d","empty":false,"result":"e1573933d694816197db183ecd073f35f3e9ada9fef9ff4112fdd8abe3ddf89d","calls":"1b0f7a9ec6f1ea82b1a4e1e40ab398c2b9d79a654a5499a4c3908d39f593f87b","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","start:9","end:8","end:9"]},
  {"scenario":"admin","period":"7d","empty":true,"result":"2246471cf3b5f22899787fe9bcba5bd5f2f3b6b8cadc87150f0d69ef6943334b","calls":"1b0f7a9ec6f1ea82b1a4e1e40ab398c2b9d79a654a5499a4c3908d39f593f87b","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","start:9","end:8","end:9"]},
  {"scenario":"admin","period":"30d","empty":false,"result":"b1fd22fa61000320ceb0c8a139ac4eb0c2302da9a46c16e9b1f64e66548e0f36","calls":"997fec2d2e817c0f1dcd77ebc77d5e0890d3e97919c3ba4dcc1c3bf9d7e92459","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","start:9","end:8","end:9"]},
  {"scenario":"admin","period":"30d","empty":true,"result":"d01d0f02f769d7baeadfba1c090c05bc8230848ad41efccacad82ba292379ea0","calls":"997fec2d2e817c0f1dcd77ebc77d5e0890d3e97919c3ba4dcc1c3bf9d7e92459","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","start:9","end:8","end:9"]},
  {"scenario":"admin","period":"all","empty":false,"result":"f7d3413f341fad3f0a5d643de27bfbe5feb3f2db28e9640155dee5b486348c39","calls":"fb4690f586a635026b2c2502791a5bde392a1cf8581d5875f7ee8e1144027943","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","end:8"]},
  {"scenario":"admin","period":"all","empty":true,"result":"dcd24d1cf0db0c579412e34756f8387b0000899c13603d6fab074cd6e8eb4452","calls":"fb4690f586a635026b2c2502791a5bde392a1cf8581d5875f7ee8e1144027943","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","end:8"]},
  {"scenario":"manager","period":"7d","empty":false,"result":"3a3cf76d7820070c8df32492224de42d718b96cf5adb28f1a131725c67dcb0dd","calls":"e0cfb394a5daca31f97c6b24f2e2dcd7bda3ae1d6092e0519fcfb1f8078747db","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7"]},
  {"scenario":"manager","period":"7d","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"064ddafe814cd6cae1268b29501d36ad4a45fce58e34f80c006438f2fe6f7eca","timeline":["schema","start:0","end:0"]},
  {"scenario":"manager","period":"30d","empty":false,"result":"3a3cf76d7820070c8df32492224de42d718b96cf5adb28f1a131725c67dcb0dd","calls":"babd14daba0651c974f7542dfc666a75bc64240b2fd89d0fa3ef784a15455cab","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7"]},
  {"scenario":"manager","period":"30d","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"064ddafe814cd6cae1268b29501d36ad4a45fce58e34f80c006438f2fe6f7eca","timeline":["schema","start:0","end:0"]},
  {"scenario":"manager","period":"all","empty":false,"result":"3a3cf76d7820070c8df32492224de42d718b96cf5adb28f1a131725c67dcb0dd","calls":"79fba25f3e20384877d6c57bf19c42a183afdaaf9ebe9f742e5d2b14bc68c2b0","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7"]},
  {"scenario":"manager","period":"all","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"064ddafe814cd6cae1268b29501d36ad4a45fce58e34f80c006438f2fe6f7eca","timeline":["schema","start:0","end:0"]},
  {"scenario":"extended","period":"7d","empty":false,"result":"29d2ff33e1aba7e3283f70a11f494ce42b95ed3d49fdaeda210229c0fb71af96","calls":"2255346c0ef60ec4f8c0ca8df5e9ebabf1b0ad1fcf599e443f8a921213a7e67a","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","end:8","start:9","end:9","start:10","end:10","start:11","end:11","start:12","start:13","end:12","end:13"]},
  {"scenario":"extended","period":"7d","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"064ddafe814cd6cae1268b29501d36ad4a45fce58e34f80c006438f2fe6f7eca","timeline":["schema","start:0","end:0"]},
  {"scenario":"extended","period":"30d","empty":false,"result":"29d2ff33e1aba7e3283f70a11f494ce42b95ed3d49fdaeda210229c0fb71af96","calls":"5347ce6465e348faa2417d140adad10a6fc9fe45adc55c7a866c145c902e7bee","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","end:8","start:9","end:9","start:10","end:10","start:11","end:11","start:12","start:13","end:12","end:13"]},
  {"scenario":"extended","period":"30d","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"064ddafe814cd6cae1268b29501d36ad4a45fce58e34f80c006438f2fe6f7eca","timeline":["schema","start:0","end:0"]},
  {"scenario":"extended","period":"all","empty":false,"result":"002aac0ddbe66dfed627facd1fde1c4bc51be597a74b26cb18410310abea0513","calls":"03831924c01e7d3243dd7883ed58299d3e04b65a461a86637b263a6e47585336","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","end:8","start:9","end:9","start:10","end:10","start:11","end:11","start:12","end:12"]},
  {"scenario":"extended","period":"all","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"064ddafe814cd6cae1268b29501d36ad4a45fce58e34f80c006438f2fe6f7eca","timeline":["schema","start:0","end:0"]},
] as const;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

for (const expected of baseline) {
  test(`analytics parity: ${expected.scenario}/${expected.period}/${expected.empty ? 'empty' : 'populated'}`, async () => {
    const actual = await runAnalyticsScenario(expected.scenario, expected.period, expected.empty);
    assert.equal(digest(actual.result), expected.result, 'Complete analytics response changed');
    assert.equal(digest(actual.calls), expected.calls, 'SQL, parameters or query order changed');
    assert.deepEqual(actual.timeline, expected.timeline, 'Query concurrency changed');
  });
}

test('analytics preserves role-specific actor identity and checks client visibility before reading', async () => {
  const calls: unknown[] = [];
  const helpers = loadAnalyticsModule<typeof import('../src/shared/lib/db/wholesaleAdminRepo/analyticsHelpers')>('analyticsHelpers',
    async (...args) => { calls.push(args); return { rows: [{ id: '42', title: 'Client' }] }; },
    { assertClientCompanyVisible: async (...args) => { calls.push(['access', ...args]); } });
  assert.equal(helpers.sessionManagerId({ role: 'support_manager', managerId: 9 } as never), 9);
  assert.equal(helpers.sessionManagerId({ role: 'manager' } as never), -1);
  assert.equal(helpers.sessionManagerId({ role: 'admin' } as never), null);
  assert.deepEqual(helpers.actorMeta({ role: 'support_manager', managerId: 9 } as never), {
    actorManagerId: 9, actorRole: 'support_manager', actorFallback: 'Менеджер по сопровождению',
  });
  const session = { role: 'manager', managerId: 9 } as never;
  assert.deepEqual(await helpers.resolveWholesaleClientCompany(42, session), { id: 42, title: 'Client' });
  assert.deepEqual(calls[0], ['access', 42, session]);
  assert.equal(calls.length, 2);
  await assert.rejects(helpers.resolveWholesaleClientCompany(0, session), /Выберите клиента/);
  assert.equal(calls.length, 2);
});

test('analytics does not swallow schema/query or client access failures', async () => {
  const failure = new Error('synthetic failure');
  const repository = loadAnalyticsModule<typeof import('../src/shared/lib/db/wholesaleAdminRepo/analyticsRepo')>('analyticsRepo', async () => { throw failure; });
  await assert.rejects(repository.getWholesaleAdminAnalytics(), (error) => error === failure);
  await assert.rejects(repository.getWholesaleManagerAnalytics(9), (error) => error === failure);
  await assert.rejects(repository.getWholesaleManagerAnalyticsExtended(9), (error) => error === failure);
  const helpers = loadAnalyticsModule<typeof import('../src/shared/lib/db/wholesaleAdminRepo/analyticsHelpers')>('analyticsHelpers',
    async () => { assert.fail('Access denial must precede SQL'); },
    { assertClientCompanyVisible: async () => { throw failure; } });
  await assert.rejects(helpers.resolveWholesaleClientCompany(42, {} as never), (error) => error === failure);
});
