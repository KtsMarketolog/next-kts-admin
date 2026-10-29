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
const {inspectReferences, verifyReferences, verifyKnowledgeBaseReferences} = moduleObject.exports;
const sha = 'a'.repeat(64);
const live = {path: 'knowledge-base/00112233-4455-4677-8899-aabbccddeeff.html', size: '22', sha256: sha};
const archived = {path: 'knowledge-base/11112233-4455-4677-8899-aabbccddeeff.pdf', size: '30', sha256: 'b'.repeat(64)};
const deleted = {path: 'knowledge-base/22112233-4455-4677-8899-aabbccddeeff.txt', size: '10', sha256: 'c'.repeat(64)};
const clone = value => JSON.parse(JSON.stringify(value));
function client(feature) {
  return {query: async sql => {
    if (sql.includes('information_schema.columns')) {
      assert.match(sql, /table_name='knowledge_base_nodes' and column_name='deleted_at'/);
      return {rows: feature ? [{'exists': 1}] : []};
    }
    if (sql.includes('from public.knowledge_base_nodes')) {
      assert.equal(feature, true);
      assert.match(sql, /kind='file' and deleted_at is null/);
      assert.doesNotMatch(sql, /archived_at/, 'archived-but-restorable files must remain required');
      // Simulate the queried live rows; tombstones are intentionally not returned.
      return {rows: [live, archived]};
    }
    return {rows: []};
  }};
}
const files = [live, archived].map(item => ({source: 'uploads', ...item, size: Number(item.size)}));

test('legacy database snapshots retain the exact old manifest and restore reference shape', async () => {
  const references = await inspectReferences(client(false));
  assert.deepEqual(clone(references), {topDashboard: [], clientDocuments: []});
  assert.doesNotThrow(() => verifyReferences([], references));
  assert.doesNotThrow(() => verifyKnowledgeBaseReferences(new Map(), references));
});

test('KB live and archived references are required; irreversible tombstones need no file but remain in database metadata', async () => {
  const references = await inspectReferences(client(true));
  assert.deepEqual(clone(references), {topDashboard: [], clientDocuments: [], knowledgeBase: [live, archived].map(item => ({...item, size: Number(item.size)}))});
  assert.ok(!references.knowledgeBase.some(item => item.path === deleted.path));
  assert.doesNotThrow(() => verifyReferences(files, references));
  assert.doesNotThrow(() => verifyKnowledgeBaseReferences(new Map(files.map(item => [`uploads/${item.path}`, item])), references));
});

test('missing, changed or wrong-storage KB files fail capture and the shared restore check closed', async () => {
  const references = await inspectReferences(client(true));
  for (const altered of [files.slice(0, 1), files.map(item => ({...item, sha256: 'f'.repeat(64)})),
    files.map(item => ({...item, size: item.size + 1})), files.map(item => ({...item, source: 'shared-uploads'}))]) {
    assert.throws(() => verifyReferences(altered, references), {code: 'KNOWLEDGE_BASE_REFERENCE_MISMATCH'});
    assert.throws(() => verifyKnowledgeBaseReferences(new Map(altered.map(item => [`${item.source}/${item.path}`, item])), references),
      {code: 'KNOWLEDGE_BASE_REFERENCE_MISMATCH'});
  }
  for (const invalid of [{...live, path: 'knowledge-base/../../private.txt', size: 22}, {...live, size: 0}, {...live, size: 22, sha256: 'bad'},
    {...live, size: 25 * 1024 * 1024 + 1}]) {
    assert.throws(() => verifyReferences(files, {...references, knowledgeBase: [invalid]}), {code: 'INVALID_KNOWLEDGE_BASE_REFERENCE'});
  }
  assert.throws(() => verifyReferences(files, {...references, knowledgeBase: null}), {code: 'INVALID_KNOWLEDGE_BASE_REFERENCE'});
});

test('restore compares references before requiring exact KB file hashes and reports count only for the new schema', () => {
  const restore = fs.readFileSync(path.join(__dirname, '../restore.cjs'), 'utf8');
  assert.match(restore, /compareRows\(references, manifest.references, 'RESTORE_REFERENCES_MISMATCH'\);\s*capture.verifyKnowledgeBaseReferences\(files, references\)/);
  assert.match(restore, /Object.hasOwn\(references, 'knowledgeBase'\) \? \{ knowledgeBaseFiles: references.knowledgeBase.length \} : \{\}/);
});

test('deployment requires the installed KB backup verifier before backup and production migrations', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/deploy.yml'), 'utf8');
  const gate = workflow.indexOf('typeof backup.verifyKnowledgeBaseReferences !== "function"');
  const backup = workflow.indexOf('if ! "$BACKUP_RUNNER" predeploy; then');
  const canary = workflow.indexOf('pm2 start "$RELEASE/ecosystem.config.cjs" --only kts-next-admin-canary');
  assert.ok(gate > 0 && backup > gate && canary > backup);
});
