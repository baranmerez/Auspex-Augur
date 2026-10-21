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

test('a describe newer than relation_stats wins: a dropped foreign key is not published from old figures', () => {
  const mem = new SchemaMemory(tempRoot(), { now });
  const customers = describe('example', 'customers', [col('id', 1)], [pk('customers_pkey', ['id'])]);
  const orders = constraints => describe('example', 'orders', [col('id', 1), col('customer_id', 2), col('status_code', 3)], [pk('orders_pkey', ['id']), ...constraints]);
  const customerFk = fk('orders_customer_fk', ['customer_id'], 'example', 'customers', ['id']);
  const statusFk = fk('orders_status_fk', ['status_code'], 'example', 'status_codes', ['code']);
  mem.recordDescribe(customers);
  mem.recordDescribe(orders([customerFk, statusFk]));
  const item = (table, constraint, columns, refColumns, linkedRows) => ({ schema: 'example', table, constraint, columns, refColumns, linkedRows, tableEstRows: 10 });
  mem.recordRelationStats('exampledb', [{
    schema: 'example', table: 'orders', estRows: 10,
    instance: [item('customers', 'orders_customer_fk', ['customer_id'], ['id'], 9), item('status_codes', 'orders_status_fk', ['status_code'], ['code'], 8)],
    dependent: [],
  }]);
  assert.deepEqual(mem.knowledge('exampledb', 'example', 'orders').relations.fk.sort(), ['customer_id -> example.customers(id)', 'status_code -> example.status_codes(code)']);

  // The customer FK is dropped outside Auspex; both tables are described again.
  const res = mem.recordDescribe(orders([statusFk]));
  assert.deepEqual(res.changesSinceLast, ['constraint orders_customer_fk dropped']);
  mem.recordDescribe(customers);

  const k = mem.knowledge('exampledb', 'example', 'orders');
  assert.deepEqual(k.relations.fk, ['status_code -> example.status_codes(code)']);
  const edges = mem.graph('exampledb').edges.filter(e => e.level === 'fk');
  assert.equal(edges.some(e => e.from === 'example.orders' && e.to === 'example.customers'), false, 'the dropped FK is gone from the graph');
  const status = edges.find(e => e.from === 'example.orders' && e.to === 'example.status_codes');
  assert.equal(status.linkedRows, 8, 'figures of a still declared FK are kept');
  assert.ok(status.statsAt);

  // A measurement newer than the describe is newer evidence: the FK came back.
  mem.recordRelationStats('exampledb', [{ schema: 'example', table: 'orders', estRows: 10, instance: [item('customers', 'orders_customer_fk', ['customer_id'], ['id'], 7)], dependent: [] }]);
  assert.deepEqual(mem.knowledge('exampledb', 'example', 'orders').relations.fk.sort(), ['customer_id -> example.customers(id)', 'status_code -> example.status_codes(code)']);
});

test('a describe of the target table newer than relation_stats wins too', () => {
  const mem = new SchemaMemory(tempRoot(), { now });
  const incoming = (table, columns) => ({ name: `${table}_customer_fk`, from_schema: 'example', from_name: table, columns, ref_columns: ['id'] });
  const customers = referencedBy => describe('example', 'customers', [col('id', 1)], [pk('customers_pkey', ['id'])], { referencedBy });
  mem.recordDescribe(customers([incoming('orders', ['customer_id']), incoming('shipments', ['customer_id'])]));
  const item = (table, linkedRows) => ({ schema: 'example', table, constraint: `${table}_customer_fk`, columns: ['customer_id'], refColumns: ['id'], linkedRows, tableEstRows: 10 });
  mem.recordRelationStats('exampledb', [{ schema: 'example', table: 'customers', estRows: 10, instance: [], dependent: [item('orders', 9), item('shipments', 6)] }]);
  assert.deepEqual(mem.knowledge('exampledb', 'example', 'customers').relations.referencedBy.sort(), ['example.orders(customer_id) -> id', 'example.shipments(customer_id) -> id']);

  // Only the target is described again; orders no longer references it.
  mem.recordDescribe(customers([incoming('shipments', ['customer_id'])]));
  assert.deepEqual(mem.knowledge('exampledb', 'example', 'customers').relations.referencedBy, ['example.shipments(customer_id) -> id']);
  const fkEdges = mem.graph('exampledb').edges.filter(e => e.level === 'fk');
  assert.deepEqual(fkEdges.map(e => [e.from, e.to, e.linkedRows]), [['example.shipments', 'example.customers', 6]]);
});

test('dotted schema and table names stay distinct tables in the graph and in table_knowledge', () => {
  const mem = new SchemaMemory(tempRoot(), { now });
  mem.recordDescribe(describe('example', 'customers', [col('id', 1)], [pk('customers_pkey', ['id'])]));
  mem.recordDescribe(describe('example', 'orders.history', [col('id', 1), col('customer_id', 2)], [pk('history_pkey', ['id']), fk('history_customer_fk', ['customer_id'], 'example', 'customers', ['id'])]));
  mem.recordDescribe(describe('example.orders', 'history', [col('note', 1, 'text')]));

  const graph = mem.graph('exampledb');
  const ids = graph.nodes.map(n => n.id).sort();
  assert.deepEqual(ids, ['"example.orders".history', 'example."orders.history"', 'example.customers']);
  const node = id => graph.nodes.find(n => n.id === id);
  assert.deepEqual([node('"example.orders".history').schema, node('"example.orders".history').table], ['example.orders', 'history']);
  assert.deepEqual([node('example."orders.history"').schema, node('example."orders.history"').table], ['example', 'orders.history']);
  assert.deepEqual(graph.edges.map(e => [e.from, e.to]), [['example."orders.history"', 'example.customers']]);

  const other = mem.knowledge('exampledb', 'example.orders', 'history');
  assert.equal(other.relation, '"example.orders".history');
  assert.deepEqual(other.relations.fk, [], 'the FK belongs to the other table');
  assert.deepEqual(mem.knowledge('exampledb', 'example', 'orders.history').relations.fk, ['customer_id -> example.customers(id)']);
  assert.deepEqual(mem.knowledge('exampledb', 'example', 'customers').relations.referencedBy, ['example."orders.history"(customer_id) -> id']);

  // An unexplored neighbour with a dotted name keeps its schema and table.
  mem.recordDescribe(describe('example', 'notes', [col('id', 1), col('order_id', 2)], [fk('notes_order_fk', ['order_id'], 'example.archive', 'orders', ['id'])]));
  const unexplored = mem.graph('exampledb').nodes.find(n => n.state === 'unexplored');
  assert.deepEqual([unexplored.id, unexplored.schema, unexplored.table], ['"example.archive".orders', 'example.archive', 'orders']);
});

test('ordinary names keep the plain schema.table text', () => {
  const mem = new SchemaMemory(tempRoot(), { now });
  mem.recordDescribe(describe('Example', 'Orders', [col('id', 1), col('customer_id', 2)], [fk('orders_customer_fk', ['customer_id'], 'example', 'customers', ['id'])]));
  const graph = mem.graph('exampledb');
  assert.deepEqual(graph.nodes.map(n => n.id).sort(), ['Example.Orders', 'example.customers']);
  assert.equal(mem.knowledge('exampledb', 'Example', 'Orders').relation, 'Example.Orders');
});
