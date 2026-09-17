'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../capture.cjs'), 'utf8');
const moduleObject = {exports: {}};
vm.runInNewContext(code + '\nmodule.exports.verifyReferences = verifyReferences;', {
  require, module: moduleObject, process, Buffer, TextDecoder, console,
}, {filename: path.join(__dirname, '../capture.cjs')});
const {inspectReferences, verifyReferences} = moduleObject.exports;
const sha = 'a'.repeat(64);
const shared = {path: 'aa/' + sha + '-12345678-1234-1234-1234-123456789012.bin', size: '54256410', sha256: sha};
const clone = (value) => JSON.parse(JSON.stringify(value));
function client(exists) {
  return {query: async (sql) => ({rows: sql.includes('to_regclass') ? [{name: exists ? 'support_shared_dashboard_json_snapshots' : null}]
    : sql.includes('from public.support_shared_dashboard_json_snapshots') ? [shared] : []})};
}
test('old database manifests keep their original reference shape', async () => {
  assert.deepEqual(clone(await inspectReferences(client(false))), {topDashboard: [], clientDocuments: []});
});
test('shared JSON joins private storage integrity checks and restored references', async () => {
  const refs = await inspectReferences(client(true));
  assert.deepEqual(clone(refs), {topDashboard: [{...shared, size: 54256410}], clientDocuments: []});
  const file = {source: 'top-dashboard', ...shared, size: 54256410};
  assert.doesNotThrow(() => verifyReferences([file], refs));
  assert.throws(() => verifyReferences([], refs), {code: 'TOP_REFERENCE_MISMATCH'});
  assert.throws(() => verifyReferences([{...file, sha256: 'b'.repeat(64)}], refs), {code: 'TOP_REFERENCE_MISMATCH'});
  assert.throws(() => verifyReferences([{...file, size: 7}], refs), {code: 'TOP_REFERENCE_MISMATCH'});
});
