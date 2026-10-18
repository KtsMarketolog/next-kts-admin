import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as deviceHelpers from '../src/shared/lib/currencyDashboardDeviceState';
import * as rpcHelpers from '../src/shared/lib/currencyDashboardRpc';
import * as schedulerHelpers from '../src/shared/lib/currencyDashboardScheduler';
import {
  createCurrencyDeviceBridge, createCurrencyDeviceState, currencyDashboardDeviceScope,
  isCurrencyDeviceMethod, validateCurrencyDeviceValues,
} from '../src/shared/lib/currencyDashboardDeviceState';
import { parseCurrencyRpcRequest } from '../src/shared/lib/currencyDashboardRpc';

const event = (day: number, msg = 'Курс ЦБ изменился') => ({ t: `2026-10-${String(day).padStart(2, '0')}T06:23:00.000Z`, msg, risk: false });
function fixture() {
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); } };
  return { rows, storage };
}

test('account scope survives sessions and role selection while separating admin and manager identities', () => {
  assert.equal(currencyDashboardDeviceScope({ role: 'top', adminUserId: 7, sessionId: 'secret-one' }), 'user:7');
  assert.equal(currencyDashboardDeviceScope({ role: 'admintop', adminUserId: 7, sessionId: 'secret-two' }), 'user:7');
  assert.equal(currencyDashboardDeviceScope({ role: 'manager', managerId: 7, adminUserId: 7 }), 'manager:7');
  assert.equal(currencyDashboardDeviceScope({ role: 'support_manager', managerId: 7 }), 'manager:7');
  assert.equal(currencyDashboardDeviceScope({ role: 'admin' }), 'admin:primary');
  assert.equal(currencyDashboardDeviceScope({ role: 'top' }), null);
  assert.equal(currencyDashboardDeviceScope(null), null);
});

test('seen, preferences and device log survive recreation; other accounts cannot read them', () => {
  const { storage, rows } = fixture();
  const page = createCurrencyDeviceState('user:7', () => storage);
  const values = { kts_seen: { cbrDate: '2026-10-13T00:00:00+03:00', moex: { CNYRUB_TOM: 12.52 }, fut: { COPPER: 14660, BR: 80 }, copper: { date: '2026-10-13', cash: 14700 } }, kts_prefs: { sound: true, notif: true, auto: true }, kts_log: [event(13)] };
  for (const [key, value] of Object.entries(values)) assert.deepEqual(page.set(key, value), { persistent: true });
  assert.deepEqual(createCurrencyDeviceState('user:7', () => storage).get(), { values, persistent: true });
  assert.deepEqual(createCurrencyDeviceState('manager:7', () => storage).get().values, {});
  assert.equal(rows.size, 1);
  assert.equal([...rows.keys()][0], 'kts:currency-device:v1:user:7');
});

test('another report writing a key preserves current preferences and merges distinct log entries', () => {
  const { storage } = fixture();
  const first = createCurrencyDeviceState('user:7', () => storage), second = createCurrencyDeviceState('user:7', () => storage);
  first.get(); second.get();
  first.set('kts_prefs', { sound: true });
  second.set('kts_log', [event(12)]);
  first.set('kts_log', [event(13)]);
  second.set('kts_log', [event(12), event(11)]);
  assert.deepEqual(first.get().values, { kts_prefs: { sound: true }, kts_log: [event(13), event(12), event(11)] });
  first.set('kts_seen', { cbrDate: '2026-10-13T00:00:00+03:00', fut: { COPPER: 14660 } });
  second.set('kts_seen', { cbrDate: '2026-10-12T00:00:00+03:00', moex: { CNYRUB_TOM: 12.52 } });
  assert.deepEqual(first.get().values.kts_seen, { cbrDate: '2026-10-13T00:00:00+03:00', fut: { COPPER: 14660 }, moex: { CNYRUB_TOM: 12.52 } });
});

test('futures prices retain matching contract identities when merging per asset or migrating legacy state', () => {
  const { storage } = fixture();
  const first = createCurrencyDeviceState('user:7', () => storage), second = createCurrencyDeviceState('user:7', () => storage);
  first.set('kts_seen', { fut: { COPPER: 14660 }, futContracts: { COPPER: 'CEZ6' } });
  second.set('kts_seen', { fut: { BR: 80 }, futContracts: { BR: 'BRX6' } });
  assert.deepEqual(first.get().values.kts_seen, { fut: { COPPER: 14660, BR: 80 }, futContracts: { COPPER: 'CEZ6', BR: 'BRX6' } });
  first.set('kts_seen', { fut: { COPPER: 14800 }, futContracts: { COPPER: 'CEH7' } });
  assert.deepEqual(second.get().values.kts_seen, { fut: { COPPER: 14800, BR: 80 }, futContracts: { COPPER: 'CEH7', BR: 'BRX6' } });
  second.set('kts_seen', { fut: { COPPER: 14700 } });
  assert.deepEqual(first.get().values.kts_seen, { fut: { COPPER: 14700, BR: 80 }, futContracts: { BR: 'BRX6' } });
  assert.deepEqual(validateCurrencyDeviceValues({ kts_seen: { fut: { COPPER: 14700 } } }).kts_seen, { fut: { COPPER: 14700 } });
  for (const contracts of [{ COPPER: 'cez6' }, { COPPER: 'CE-Z6' }, { COPPER: '' }, { COPPER: 'A'.repeat(33) }, { COPPER: 12 }, { OTHER: 'CEZ6' }]) {
    assert.throws(() => validateCurrencyDeviceValues({ kts_seen: { fut: { COPPER: 14700 }, futContracts: contracts } }));
  }
  assert.throws(() => validateCurrencyDeviceValues({ kts_seen: { futContracts: { COPPER: 'CEH7' } } }));
});

test('storage failures keep session memory and honestly report missing persistence', () => {
  for (const accessor of [() => null, () => { throw new Error('SecurityError'); }, () => ({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } })]) {
    const state = createCurrencyDeviceState('user:7', accessor);
    assert.deepEqual(state.set('kts_prefs', { voice: true }), { persistent: false });
    assert.deepEqual(state.get(), { values: { kts_prefs: { voice: true } }, persistent: false });
  }
  const noAccount = createCurrencyDeviceState(null, () => { throw new Error('Must not access storage'); });
  assert.deepEqual(noAccount.set('kts_seen', {}), { persistent: false });
});

test('corrupt persisted values are never supplied to the iframe or allowed to choose keys', () => {
  const { storage, rows } = fixture();
  const key = 'kts:currency-device:v1:user:7';
  for (const raw of ['{broken', '{"kts_cpsRates":{"eur":100}}', '{"kts_prefs":{"sound":"yes"}}', 'x'.repeat(1024 * 1024 + 1)]) {
    rows.set(key, raw);
    assert.deepEqual(createCurrencyDeviceState('user:7', () => storage).get(), { values: {}, persistent: false });
    assert.equal(rows.get(key), raw, 'invalid data is not rewritten');
  }
  const state = createCurrencyDeviceState('user:7', () => storage);
  for (const name of ['kts_cpsRates', 'session', '__proto__', 'kts:currency-device:v1:user:9']) assert.throws(() => state.set(name, {}));
  assert.throws(() => createCurrencyDeviceState('session:secret-token', () => storage));
});

test('recovered storage merges unsaved memory with another report updates', () => {
  const { storage } = fixture();
  let failed = true;
  const first = createCurrencyDeviceState('user:7', () => ({ ...storage, setItem: (key, value) => {
    if (failed) throw new Error('Quota exceeded');
    storage.setItem(key, value);
  } }));
  const second = createCurrencyDeviceState('user:7', () => storage);
  first.set('kts_log', [event(12)]);
  second.set('kts_prefs', { sound: true });
  second.set('kts_log', [event(13)]);
  failed = false;
  first.set('kts_seen', { copper: { date: '2026-10-13', cash: 14700 } });
  assert.deepEqual(second.get().values, { kts_prefs: { sound: true }, kts_log: [event(13), event(12)], kts_seen: { copper: { date: '2026-10-13', cash: 14700 } } });
});

test('device values are bounded and accept only text logs and known typed fields', () => {
  for (const value of [
    { kts_seen: { cbrDate: '2026-02-30T00:00:00+03:00' } },
    { kts_seen: { cbrDate: '2026-10-13T24:00:00Z' } },
    { kts_seen: { moex: { CNYRUB_TOM: Infinity } } },
    { kts_seen: { fut: { COPPER: 0 } } },
    { kts_seen: { moex: { OTHER: 12 } } },
    { kts_seen: { copper: { date: '2026-02-30', cash: 12000 } } },
    { kts_seen: { copper: { date: '2026-10-13', cash: -1 } } },
    { kts_seen: { copper: { date: '2026-10-13', cash: 12000, secret: 1 } } },
    { kts_prefs: { sound: 1 } }, { kts_prefs: { secret: false } },
    { kts_log: [event(13, '<img src=x>')] }, { kts_log: [event(13, 'x'.repeat(2001))] },
    { kts_log: [event(13, 'bad\u0000text')] }, { kts_log: Array(1) },
    { kts_log: Array.from({ length: 201 }, () => event(13)) },
    JSON.parse('{"__proto__":{}}'),
  ]) assert.throws(() => validateCurrencyDeviceValues(value));
  assert.equal(validateCurrencyDeviceValues({ kts_log: Array.from({ length: 200 }, () => event(13, 'я'.repeat(2000))) }).kts_log?.length, 200);
});

test('local methods never become server RPC methods and malformed local commands are rejected', async () => {
  const { storage } = fixture();
  const command = createCurrencyDeviceBridge('user:7', () => storage, () => null);
  for (const method of ['device:get', 'device:set', 'notification:permission', 'notification:show']) {
    assert.equal(isCurrencyDeviceMethod(method), true);
    assert.throws(() => parseCurrencyRpcRequest({ method, params: {} }));
  }
  assert.equal(isCurrencyDeviceMethod('source'), false);
  for (const [method, params] of [
    ['device:get', { scope: 'user:8' }], ['device:set', { key: 'kts_prefs', value: {}, scope: 'user:8' }],
    ['device:set', { key: 'kts_prefs' }], ['notification:permission', { url: 'https://example.com' }],
    ['notification:show', { body: 'Rate changed', title: 'Arbitrary title' }],
    ['notification:show', { body: 'x'.repeat(2001) }], ['notification:show', { body: '<script>' }],
  ]) await assert.rejects(command(method, params));
});

test('notifications require both browser permission and opted-in device preference', async () => {
  const { storage } = fixture();
  let permission: NotificationPermission = 'default', requested = 0;
  const shown: string[] = [];
  const command = createCurrencyDeviceBridge('user:7', () => storage, () => ({
    permission: () => permission, requestPermission: async () => { requested++; return permission; }, show: (body) => { shown.push(body); },
  }));
  assert.deepEqual(await command('notification:permission'), { permission: 'default' });
  assert.equal(requested, 1);
  assert.deepEqual(await command('notification:show', { body: 'Rate changed' }), { shown: false, permission: 'default' });
  permission = 'granted';
  assert.deepEqual(await command('notification:show', { body: 'Rate changed' }), { shown: false, permission: 'granted' });
  await command('device:set', { key: 'kts_prefs', value: { notif: true } });
  assert.deepEqual(await command('notification:show', { body: 'Rate changed' }), { shown: true, permission: 'granted' });
  permission = 'denied';
  assert.deepEqual(await command('notification:show', { body: 'Rate changed' }), { shown: false, permission: 'denied' });
  assert.deepEqual(shown, ['Rate changed']);
});

test('missing or failing browser notification APIs return unsupported without throwing', async () => {
  const { storage } = fixture();
  for (const api of [() => null, () => ({ permission: () => 'granted' as const, requestPermission: async (): Promise<NotificationPermission> => { throw new Error('unsupported'); }, show: () => { throw new Error('unsupported'); } })]) {
    const command = createCurrencyDeviceBridge('user:7', () => storage, api);
    await command('device:set', { key: 'kts_prefs', value: { notif: true } });
    assert.deepEqual(await command('notification:permission'), { permission: 'unsupported' });
    assert.deepEqual(await command('notification:show', { body: 'Rate changed' }), { shown: false, permission: 'unsupported' });
  }
});

for (const preview of [false, true]) test(`the real ${preview ? 'preview' : 'published'} host isolates its nonce-bound local commands without server fetch`, async () => {
  const { storage, rows } = fixture();
  const replies: { result?: unknown; error?: unknown }[] = [];
  const frameWindow = { postMessage: (value: { result?: unknown; error?: unknown }) => { replies.push(value); } };
  let receive: (event: unknown) => Promise<void> = async () => {}, cleanup: (() => void) | undefined;
  let refs = 0, fetches = 0;
  const renderedTypes: unknown[] = [];
  const forbiddenFetch = () => { fetches++; throw new Error('Local command reached network'); };
  const requestExports = {};
  const requestCode = ts.transpileModule(readFileSync('src/features/admin/shared/adminRequest.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(requestCode, { exports: requestExports, fetch: forbiddenFetch, AbortController, Response, setTimeout, clearTimeout });
  const modules: Record<string, unknown> = {
    'next/link': {},
    'react': {
      useRef: () => ({ current: ++refs === 1 ? { contentWindow: frameWindow, addEventListener() {}, removeEventListener() {} } : null }),
      useState: (value: unknown) => [value, () => {}],
      useEffect: (effect: () => () => void) => { cleanup = effect(); },
    },
    'react/jsx-runtime': { jsx: (type: unknown) => { renderedTypes.push(type); return null; }, jsxs: () => null },
    '@/shared/lib/currencyDashboardRpc': rpcHelpers,
    '@/shared/lib/currencyDashboardDeviceState': deviceHelpers,
    '@/shared/lib/currencyDashboardScheduler': schedulerHelpers,
    '@/features/admin/shared/adminRequest': requestExports,
    '@/features/admin/dashboard-usage/useDashboardUsage': { useDashboardUsage() {} },
    '@/features/admin/dashboard-access/DashboardAudienceEditor': {},
    './CurrencyHtmlManagement': {},
    './currency-dashboard.module.scss': { default: {} },
  };
  const source = readFileSync('src/features/admin/currency-dashboard/CurrencyDashboard.tsx', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: { CurrencyDashboard?: (props: object) => void } = {};
  runInNewContext(compiled, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
    window: { localStorage: storage, isSecureContext: false, addEventListener: (name: string, callback: typeof receive) => { if (name === 'message') receive = callback; }, removeEventListener() {}, setInterval, clearInterval },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    AbortController, setTimeout, clearTimeout, TextEncoder, fetch: forbiddenFetch,
  });
  exports.CurrencyDashboard!({ nonce: 'test-device-nonce', deviceScope: 'user:7', canManage: preview, ...(preview ? { previewVersion: 3 } : {}) });
  const message = (id: string, method: string, params = {}) => ({ channel: 'kts-currency-v1', nonce: 'test-device-nonce', id, method, params });
  try {
    const write = message('1', 'device:set', { key: 'kts_prefs', value: { sound: true } });
    await receive({ source: {}, origin: 'null', data: write });
    await receive({ source: frameWindow, origin: 'https://example.com', data: write });
    await receive({ source: frameWindow, origin: 'null', data: { ...write, nonce: 'forged' } });
    assert.equal(replies.length, 0); assert.equal(rows.size, 0);
    await receive({ source: frameWindow, origin: 'null', data: write });
    assert.equal(rows.size, preview ? 0 : 1, 'preview must never touch persisted device settings');
    await receive({ source: frameWindow, origin: 'null', data: message('2', 'device:get') });
    assert.deepEqual(replies[1].result, { values: { kts_prefs: { sound: true } }, persistent: !preview });
    await receive({ source: frameWindow, origin: 'null', data: message('3', 'device:set', { key: 'session', value: 'secret' }) });
    assert.ok(replies[2].error);
    await receive({ source: frameWindow, origin: 'null', data: write });
    assert.equal(replies.length, 3, 'duplicate request id does not run again');
    assert.equal(renderedTypes.some((type) => typeof type === 'function' && type.name === 'CurrencyPublishedUsage'), !preview, 'preview does not mount usage telemetry');
    if (preview) {
      for (const method of ['snapshot:save', 'snapshot:rollback']) {
        await receive({ source: frameWindow, origin: 'null', data: message(method, method, { expectedRevision: 1 }) });
        assert.deepEqual(JSON.parse(JSON.stringify(replies.at(-1)?.error)), { message: 'На этом экране доступен только просмотр.', status: 403, code: 'CURRENCY_READ_ONLY' });
      }
      await receive({ source: frameWindow, origin: 'null', data: message('notification', 'notification:permission') });
      assert.deepEqual(replies.at(-1)?.result, { permission: 'unsupported' });
    }
    assert.equal(fetches, 0);
  } finally { cleanup?.(); }
});
