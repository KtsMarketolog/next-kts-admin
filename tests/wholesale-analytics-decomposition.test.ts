import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadAnalyticsModule, runAnalyticsScenario } from './helpers/wholesaleAnalyticsHarness';

// Captured before decomposition from commit 1211726. Each digest covers the
// complete response or exact ordered SQL strings + parameters, not selected
// properties. The explicit start/end timeline also protects sequential reads
// and the existing final Promise.all against accidental extra concurrency.
const baseline = [
  {"scenario":"admin","period":"7d","empty":false,"result":"e1573933d694816197db183ecd073f35f3e9ada9fef9ff4112fdd8abe3ddf89d","calls":"e3ac763f1c63a8e7b224b1f313525fe3a132d5b7fb180886b63b9c6c3adc4aed","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","start:9","end:8","end:9"]},
  {"scenario":"admin","period":"7d","empty":true,"result":"2246471cf3b5f22899787fe9bcba5bd5f2f3b6b8cadc87150f0d69ef6943334b","calls":"e3ac763f1c63a8e7b224b1f313525fe3a132d5b7fb180886b63b9c6c3adc4aed","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","start:9","end:8","end:9"]},
  {"scenario":"admin","period":"30d","empty":false,"result":"b1fd22fa61000320ceb0c8a139ac4eb0c2302da9a46c16e9b1f64e66548e0f36","calls":"1670742fd7a77cb8fd68634b82d1f858ce303e37b24743e439397f20c2e28e7a","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","start:9","end:8","end:9"]},
  {"scenario":"admin","period":"30d","empty":true,"result":"d01d0f02f769d7baeadfba1c090c05bc8230848ad41efccacad82ba292379ea0","calls":"1670742fd7a77cb8fd68634b82d1f858ce303e37b24743e439397f20c2e28e7a","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","start:9","end:8","end:9"]},
  {"scenario":"admin","period":"all","empty":false,"result":"f7d3413f341fad3f0a5d643de27bfbe5feb3f2db28e9640155dee5b486348c39","calls":"054e5893d937e3b3cb09b1b3190d4f05bb8ce64908e72034b45b928fa518194e","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","end:8"]},
  {"scenario":"admin","period":"all","empty":true,"result":"dcd24d1cf0db0c579412e34756f8387b0000899c13603d6fab074cd6e8eb4452","calls":"054e5893d937e3b3cb09b1b3190d4f05bb8ce64908e72034b45b928fa518194e","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","end:8"]},
  {"scenario":"manager","period":"7d","empty":false,"result":"3a3cf76d7820070c8df32492224de42d718b96cf5adb28f1a131725c67dcb0dd","calls":"c67a2db96b10e2e37b762e4d20ee74251cb5b06ca5d141876874ef40ecfc35d0","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7"]},
  {"scenario":"manager","period":"7d","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"03f05edfcef4bdf73a15432b25b9f8cffbafa02fa9f771e56d522aedb54f85b8","timeline":["schema","start:0","end:0"]},
  {"scenario":"manager","period":"30d","empty":false,"result":"3a3cf76d7820070c8df32492224de42d718b96cf5adb28f1a131725c67dcb0dd","calls":"0d2bc6d1879ee170a04a824ccd93aeebeb14f013d8bf2904d7f5393fc4b456e5","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7"]},
  {"scenario":"manager","period":"30d","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"03f05edfcef4bdf73a15432b25b9f8cffbafa02fa9f771e56d522aedb54f85b8","timeline":["schema","start:0","end:0"]},
  {"scenario":"manager","period":"all","empty":false,"result":"3a3cf76d7820070c8df32492224de42d718b96cf5adb28f1a131725c67dcb0dd","calls":"7863bbb7c25e8a02b8734c3fb3795bbd84710842f05da8ac4dfe9123e49a58c5","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7"]},
  {"scenario":"manager","period":"all","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"03f05edfcef4bdf73a15432b25b9f8cffbafa02fa9f771e56d522aedb54f85b8","timeline":["schema","start:0","end:0"]},
  {"scenario":"extended","period":"7d","empty":false,"result":"29d2ff33e1aba7e3283f70a11f494ce42b95ed3d49fdaeda210229c0fb71af96","calls":"449594a8359b794430a687699c96deef658d90392770d253a05d1201eee9ea62","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","end:8","start:9","end:9","start:10","end:10","start:11","end:11","start:12","start:13","end:12","end:13"]},
  {"scenario":"extended","period":"7d","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"03f05edfcef4bdf73a15432b25b9f8cffbafa02fa9f771e56d522aedb54f85b8","timeline":["schema","start:0","end:0"]},
  {"scenario":"extended","period":"30d","empty":false,"result":"29d2ff33e1aba7e3283f70a11f494ce42b95ed3d49fdaeda210229c0fb71af96","calls":"3039b2a2f47ee2fd114929c581d0d69f7635f1760485681cef828ddee4a7f17c","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","end:8","start:9","end:9","start:10","end:10","start:11","end:11","start:12","start:13","end:12","end:13"]},
  {"scenario":"extended","period":"30d","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"03f05edfcef4bdf73a15432b25b9f8cffbafa02fa9f771e56d522aedb54f85b8","timeline":["schema","start:0","end:0"]},
  {"scenario":"extended","period":"all","empty":false,"result":"002aac0ddbe66dfed627facd1fde1c4bc51be597a74b26cb18410310abea0513","calls":"1ae74db698104815c4e67c8586157e469b48997eb8cb885eabe9a9072710d02a","timeline":["schema","start:0","end:0","start:1","end:1","start:2","end:2","start:3","end:3","start:4","end:4","start:5","end:5","start:6","end:6","start:7","end:7","start:8","end:8","start:9","end:9","start:10","end:10","start:11","end:11","start:12","end:12"]},
  {"scenario":"extended","period":"all","empty":true,"result":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","calls":"03f05edfcef4bdf73a15432b25b9f8cffbafa02fa9f771e56d522aedb54f85b8","timeline":["schema","start:0","end:0"]},
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
