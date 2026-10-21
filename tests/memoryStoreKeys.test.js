import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaMemory } from '../src/memory/store.js';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1) + (clock++) * 60000).toISOString();
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-mem-keys-'));

const col = (column, attnum, type = 'integer') => ({ column, attnum, type, not_null: false, default: null, comment: null });
const pk = (name, columns) => ({ name, type: 'primary key', definition: `PRIMARY KEY (${columns.join(', ')})`, columns, ref_schema: null, ref_table: null, ref_columns: null });
const fk = (name, columns, refSchema, refTable, refColumns) => ({
  name, type: 'foreign key', definition: `FOREIGN KEY (${columns.join(', ')}) REFERENCES ${refSchema}.${refTable}(${refColumns.join(', ')})`,
  columns, ref_schema: refSchema, ref_table: refTable, ref_columns: refColumns,
});
const describe = (schema, table, columns, constraints = [], extra = {}) => ({
  profile: 'exampledb', relation: `${schema}.${table}`, schema, table, kind: 'table', oid: 1, estimated_rows: 10, comment: null,
  columns, constraints, indexes: [], referencedBy: [], ...extra,
});
// Table file as it is on disk, read without the instance cache.
const onDisk = (root, schema, table) => new SchemaMemory(root).readTable('exampledb', schema, table);

test('column names like __proto__ and constructor are ordinary keys in usedColumns', () => {
  const root = tempRoot();
  const mem = new SchemaMemory(root, { now });
  mem.recordDescribe(describe('example', 'orders', [col('id', 1), col('__proto__', 2), col('constructor', 3), col('toString', 4), col('total', 5)], [pk('orders_pkey', ['id'])]));

  const fresh = mem.knowledge('exampledb', 'example', 'orders');
  assert.deepEqual(fresh.keyColumns, ['id integer [pk]'], 'no column is used before any recorded usage');

  const used = ['__proto__', 'constructor', 'toString', 'total'];
  mem.recordSeen('exampledb', [{ schema: 'example', table: 'orders', columns: used }]);
  let rec = onDisk(root, 'example', 'orders');
  for (const name of used) {
    assert.ok(Object.hasOwn(rec.usedColumns, name), `${name} is stored as an own key`);
    assert.equal(rec.usedColumns[name].count, 1, name);
  }
  mem.recordSeen('exampledb', [{ schema: 'example', table: 'orders', columns: used }]);
  rec = onDisk(root, 'example', 'orders');
  assert.deepEqual(Object.entries(rec.usedColumns).map(([k, v]) => [k, v.count]), [['__proto__', 2], ['constructor', 2], ['toString', 2], ['total', 2]]);
  assert.equal(Object.getPrototypeOf(rec.usedColumns), Object.prototype, 'saved JSON keeps the plain-object shape');

  const k = mem.knowledge('exampledb', 'example', 'orders');
  assert.deepEqual(k.keyColumns.sort(), ['__proto__ integer [used]', 'constructor integer [used]', 'id integer [pk]', 'toString integer [used]', 'total integer [used]']);

  // A column in usedColumns that left the structure is listed once, as before.
  mem.recordDescribe(describe('example', 'orders', [col('id', 1), col('total', 5)], [pk('orders_pkey', ['id'])]));
  assert.deepEqual(mem.knowledge('exampledb', 'example', 'orders').keyColumns.sort(), ['__proto__ [used]', 'constructor [used]', 'id integer [pk]', 'toString [used]', 'total integer [used]']);
});
