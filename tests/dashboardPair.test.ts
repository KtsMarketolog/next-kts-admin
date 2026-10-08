import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultOfficeDashboardPair, isPairReportKey, parseDashboardPairConfig } from '../src/shared/lib/dashboardPair';

test('fixed pair accepts exactly two distinct known common report identifiers', () => {
  const value = { keys: ['top:4', 'currency-rates'], layout: 'columns', revision: 0 };
  assert.deepEqual(parseDashboardPairConfig(value), value);
  assert.ok(parseDashboardPairConfig({ ...value, keys: ['route-planner', 'top:7'], layout: 'rows' }));
});

test('office pair defaults to the unique sales report and does not guess duplicate or missing reports', () => {
  assert.deepEqual(defaultOfficeDashboardPair([{id:4,title:'Аналитика продаж'}]), {
    keys:['currency-rates','top:4'],views:['default','sales-office'],layout:'columns',revision:0,
  });
  assert.equal(defaultOfficeDashboardPair([{id:8,title:'Рентабельность сделок'}]),null);
  assert.equal(defaultOfficeDashboardPair([{id:4,title:'Аналитика продаж'},{id:8,title:'Аналитика продаж'}]),null);
});

test('office mode is an allowlisted subview of a TOP report, never an arbitrary URL or script', () => {
  const value = { keys:['currency-rates','top:4'],views:['default','sales-office'],layout:'columns',revision:0 };
  assert.deepEqual(parseDashboardPairConfig(value),value);
  for (const views of [['sales-office','default'],['default','https://evil.test'],['default'],['default','default','sales-office'],[null,'sales-office']]) {
    assert.equal(parseDashboardPairConfig({...value,views}),null);
  }
});

test('pair rejects arbitrary URLs, private audiences, duplicates and unsafe IDs', () => {
  for (const key of ['https://example.com', '/admin/top/4', 'manager:development', 'top:0', 'top:-1', 'top:1.5', 'top:01', 'top:9007199254740992', null]) {
    assert.equal(isPairReportKey(key), false, String(key));
  }
  for (const keys of [[], ['top:1'], ['top:1','top:1'], ['top:1','top:2','top:3']]) {
    assert.equal(parseDashboardPairConfig({ keys, layout:'columns', revision:0 }), null);
  }
  assert.equal(parseDashboardPairConfig({ keys:['top:1','top:2'], layout:'columns', revision:-1 }), null);
  assert.equal(parseDashboardPairConfig({ keys:['top:1','top:2'], layout:'url', revision:0 }), null);
});
