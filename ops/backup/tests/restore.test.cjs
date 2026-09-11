'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../restore.cjs'), 'utf8');
const moduleObject = { exports: {} };
vm.runInNewContext(code + '\nmodule.exports.logicalSchema = logicalSchema;', {
  require, module: moduleObject, process, Buffer, TextDecoder,
}, { filename: 'restore.cjs' });
const { logicalSchema } = moduleObject.exports;
const columns = [
  { table_schema: 'public', table_name: 'example', column_name: 'a', ordinal_position: 1, data_type: 'text' },
  { table_schema: 'public', table_name: 'example', column_name: 'b', ordinal_position: 3, data_type: 'text' },
];
const schema = { columns, indexes: [], constraints: [], sequences: [] };

test('logical schema removes only invisible DROP COLUMN position holes', () => {
  const restored = { ...schema, columns: columns.map((column, i) => ({ ...column, ordinal_position: i + 1 })) };
  assert.equal(JSON.stringify(logicalSchema(schema)), JSON.stringify(logicalSchema(restored)));
  assert.equal(columns[1].ordinal_position, 3);
});

test('logical schema preserves visible order and types', () => {
  const swapped = { ...schema, columns: columns.map((column, i) => ({ ...column, column_name: i ? 'a' : 'b' })) };
  const changed = { ...schema, columns: columns.map((column) => ({ ...column, data_type: 'integer' })) };
  assert.notEqual(JSON.stringify(logicalSchema(schema)), JSON.stringify(logicalSchema(swapped)));
  assert.notEqual(JSON.stringify(logicalSchema(schema)), JSON.stringify(logicalSchema(changed)));
});

test('logical schema rejects reversed and duplicate physical ordinal positions', () => {
  assert.throws(() => logicalSchema({ ...schema, columns: [...columns].reverse() }), { code: 'RESTORE_SCHEMA_COLUMN_ORDER_INVALID' });
  assert.throws(() => logicalSchema({ ...schema, columns: columns.map((column) => ({ ...column, ordinal_position: 1 })) }), { code: 'RESTORE_SCHEMA_COLUMN_ORDER_INVALID' });
});
