import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaMemory, MemoryError, fileSegment, diffTable, recordFromDescribe } from '../src/memory/store.js';
import { relationsFromJsonPlan, relationsFromTextPlan } from '../src/memory/planUsage.js';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1) + (clock++) * 60000).toISOString();

function tempMemory(approvedJoins) {
  return new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-mem-test-')), { now, approvedJoins });
}

const col = (column, attnum, type = 'integer', extra = {}) => ({ column, attnum, type, not_null: false, default: null, comment: null, ...extra });

// Shape of a describe_table result (catalog.describeTable).
function ordersDescribe(overrides = {}) {
  return {
    profile: 'example', relation: 'sales.orders', schema: 'sales', table: 'orders', kind: 'table', oid: 1001, estimated_rows: 250000, comment: null,
    columns: [col('id', 1, 'integer', { not_null: true }), col('customer_id', 2), col('status_id', 3), col('note', 4, 'text')],
    constraints: [
      { name: 'orders_pkey', type: 'primary key', definition: 'PRIMARY KEY (id)', columns: ['id'], ref_schema: null, ref_table: null, ref_columns: null },
      { name: 'orders_customer_fk', type: 'foreign key', definition: 'FOREIGN KEY (customer_id) REFERENCES sales.customers(id)', columns: ['customer_id'], ref_schema: 'sales', ref_table: 'customers', ref_columns: ['id'] },
    ],
    indexes: [{ name: 'orders_pkey', definition: 'CREATE UNIQUE INDEX orders_pkey ON sales.orders USING btree (id)' }],
    referencedBy: [{ from_table: 'sales.order_lines', from_schema: 'sales', from_name: 'order_lines', name: 'lines_order_fk', definition: 'FOREIGN KEY (order_id) REFERENCES orders(id)', columns: ['order_id'], ref_columns: ['id'] }],
    ...overrides,
  };
}

test('file segments keep simple names and encode everything else without collisions', () => {
  assert.equal(fileSegment('orders'), 'orders');
  assert.equal(fileSegment('order_lines-2'), 'order_lines-2');
  assert.notEqual(fileSegment('Orders'), fileSegment('orders'));
  assert.equal(fileSegment('a.b'), 'a~2eb');
  assert.equal(fileSegment('çay'), '~c3a7ay');
  assert.equal(fileSegment('con'), '~con');
  assert.throws(() => fileSegment(''), MemoryError);
});

test('first describe records the table; the next one reports structural changes only', () => {
  const mem = tempMemory();
  const first = mem.recordDescribe(ordersDescribe());
  assert.equal(first.recorded, 'first time');
  assert.equal(first.changesSinceLast, undefined);

  // same structure, new row estimate and comment: no change
  assert.equal(mem.recordDescribe(ordersDescribe({ estimated_rows: 260000, comment: 'x' })).changesSinceLast, undefined);

  const changed = ordersDescribe({
    columns: [col('id', 1, 'integer', { not_null: true }), col('customer_id', 2, 'bigint'), col('state_id', 3), col('created_at', 5, 'timestamp without time zone')],
    indexes: [],
  });
  const res = mem.recordDescribe(changed);
  assert.equal(res.recorded, 'updated');
  assert.deepEqual(res.changesSinceLast.sort(), [
    'column created_at added (timestamp without time zone)',
    'column customer_id type integer -> bigint',
    'column note dropped (was text)',
    'column status_id renamed to state_id',
    'index orders_pkey dropped',
  ]);
  const rec = mem.readTable('example', 'sales', 'orders');
  assert.equal(rec.history.length, 1);
  assert.equal(rec.estimatedRows, 250000);
  assert.deepEqual(mem.readChangelog('example').map(e => e.event), ['explored', 'changed']);
});

test('a recreated table (new oid) is diffed by name, without rename guesses', () => {
  const prev = recordFromDescribe(ordersDescribe());
  const next = recordFromDescribe(ordersDescribe({ oid: 2002, columns: [col('id', 1, 'integer', { not_null: true }), col('customer_id', 2), col('state_id', 3), col('note', 4, 'text')] }));
  const kinds = diffTable(prev, next).map(c => c.change).sort();
  assert.deepEqual(kinds, ['column-added', 'column-dropped']);
  assert.deepEqual(diffTable(prev, recordFromDescribe(ordersDescribe({ oid: 2002 }))), [], 'restore with the same structure is not a change');
});

test('plans record seen tables and used columns; neighbors come from foreign keys', () => {
  const mem = tempMemory();
  mem.recordDescribe(ordersDescribe());
  const out = mem.recordSeen('example', [{ schema: 'sales', table: 'orders', columns: ['status_id'] }, { schema: 'sales', table: 'regions', columns: ['name'] }]);
  const seen = mem.readTable('example', 'sales', 'regions');
  assert.equal(seen.describedAt, null);
  assert.equal(seen.usedColumns.name.count, 1);
  assert.equal(mem.readTable('example', 'sales', 'orders').usedColumns.status_id.count, 1);
  assert.deepEqual(out.unexploredNeighbors, { tables: ['sales.customers', 'sales.order_lines'], more: 0 });
});

test('relations: fk, used from approved reports, suggested by primary key name', () => {
  const mem = tempMemory(() => [{ left: 'sales.orders.status_id', right: 'sales.statuses.id' }, { left: 'sales.orders.customer_id', right: 'sales.customers.id' }]);
  mem.recordDescribe(ordersDescribe({ columns: [...ordersDescribe().columns, col('warehouse_id', 6)] }));
  mem.recordDescribe({
    profile: 'example', relation: 'stock.warehouses', schema: 'stock', table: 'warehouses', kind: 'table', oid: 3003, estimated_rows: 12, comment: null,
    columns: [col('warehouse_id', 1)], indexes: [], referencedBy: [],
    constraints: [{ name: 'wh_pkey', type: 'primary key', definition: 'PRIMARY KEY (warehouse_id)', columns: ['warehouse_id'] }],
  });
  const levels = mem.edges('example').map(e => `${e.level} ${e.from} -> ${e.to}`).sort();
  assert.deepEqual(levels, [
    'fk sales.order_lines -> sales.orders',
    'fk sales.orders -> sales.customers',
    'suggested sales.orders -> stock.warehouses',
    'used sales.orders -> sales.statuses',
  ], 'a join that is already a foreign key is not repeated as used');
  const k = mem.knowledge('example', 'sales', 'orders');
  assert.equal(k.known, true);
  assert.deepEqual(k.relations.suggested, ['warehouse_id -> stock.warehouses(warehouse_id) (name match, unconfirmed)']);
  assert.ok(k.keyColumns.includes('id integer [pk]'));
  assert.ok(k.keyColumns.includes('customer_id integer [fk]'));
  assert.match(k.otherColumns, /note/);
  assert.deepEqual(k.unexploredNeighbors.tables, ['sales.customers', 'sales.order_lines', 'sales.statuses']);
  assert.deepEqual(mem.knowledge('example', 'sales', 'nothing').known, false);
});

test('notes: add, show on touched tables, confirm inferences, archive instead of delete', () => {
  const mem = tempMemory();
  mem.recordDescribe(ordersDescribe());
  const rule = mem.addNote('example', { kind: 'rule', schema: 'sales', table: 'orders', column: 'status_id', text: 'status_id = 50 means cancelled.' });
  const obs = mem.addNote('example', { kind: 'observation', schema: 'sales', table: 'orders', column: 'note', text: 'note is never filled.', evidence: { sql: 'select count(note) from sales.orders', figures: { rows: 250000, filled: 0 } } });
  const inf = mem.addNote('example', { kind: 'inference', schema: 'sales', table: 'orders', text: 'is_void may mean an invoice reversal.' });
  assert.equal(rule.source, 'user');
  assert.equal(obs.asOf, '2026-01-01');
  assert.deepEqual(obs.evidence.figures, { rows: 250000, filled: 0 });

  const desc = mem.recordDescribe(ordersDescribe());
  assert.equal(desc.notes.length, 3);
  assert.match(desc.notes[0], /^#1 rule status_id: status_id = 50 means cancelled\.$/);
  assert.match(desc.notes[2], /\(unconfirmed\)$/);
  assert.equal(mem.notesForSql('example', 'select 1 from SALES.Orders o').notes.length, 3);
  assert.deepEqual(mem.notesForSql('example', 'select 1 from sales.customers'), {});

  assert.equal(mem.confirmNote('example', inf.id, 'rule').kind, 'rule');
  assert.throws(() => mem.archiveNote('example', obs.id, ''), /reason/);
  mem.archiveNote('example', obs.id, 'column is filled since the new release');
  assert.equal(mem.knowledge('example', 'sales', 'orders').notes.length, 2);
  assert.equal(mem.readNotes('example').notes.filter(n => n.table === 'orders').length, 3, 'archived notes stay');
  mem.addNote('example', { kind: 'observation', schema: 'sales', table: 'returns', text: 'returns is not linked to orders.' });
  assert.deepEqual(mem.knowledge('example', 'sales', 'returns').notes.map(n => n.text), ['returns is not linked to orders.'], 'notes show before the table is explored');
  assert.throws(() => mem.addNote('example', { kind: 'guess', text: 'x' }), MemoryError);
  assert.throws(() => mem.addNote('example', { kind: 'rule', schema: 'sales', text: 'x' }), /both schema and table/);
});

test('graph lists explored, seen and unexplored tables', () => {
  const mem = tempMemory();
  mem.recordDescribe(ordersDescribe());
  mem.recordSeen('example', [{ schema: 'sales', table: 'regions', columns: [] }]);
  const g = mem.graph('example');
  const state = Object.fromEntries(g.nodes.map(n => [n.id, n.state]));
  assert.deepEqual(state, { 'sales.orders': 'explored', 'sales.regions': 'seen', 'sales.customers': 'unexplored', 'sales.order_lines': 'unexplored' });
  assert.equal(g.edges.length, 2);
  assert.deepEqual(mem.profiles(), ['example']);
  assert.equal(g.nodes.find(n => n.id === 'sales.orders').file, 'tables/sales/orders.json');
  const view = JSON.parse(fs.readFileSync(path.join(mem.root, 'example', 'graph.json'), 'utf8'));
  assert.deepEqual([view.summary.explored, view.summary.seen, view.summary.unexplored, view.summary.edges], [1, 1, 2, 2]);
  assert.deepEqual(view.changelog.map(e => e.event), ['explored']);
  assert.throws(() => mem.readTable('../x', 'a', 'b'), MemoryError);
});

test('relations and columns are read from JSON and text plans', () => {
  const plan = [{ Plan: {
    'Node Type': 'Hash Join', 'Hash Cond': '(o.customer_id = c.id)', Output: ['o.id', 'c.name'],
    Plans: [
      { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Schema: 'sales', Alias: 'o', Output: ['o.id', 'o.customer_id'], Filter: "(o.status_id = 50)" },
      { 'Node Type': 'Hash', Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'customers', Schema: 'sales', Alias: 'c', Output: ['c.id', 'c.name'], 'Index Cond': '(c.id > 0)' }] },
      { 'Node Type': 'Seq Scan', 'Relation Name': 'pg_class', Schema: 'pg_catalog', Alias: 'pc', Output: ['pc.oid'] },
    ],
  } }];
  const joins = [{ columnPairs: [{ left: 'sales.orders.customer_id', right: 'sales.customers.id' }] }];
  assert.deepEqual(relationsFromJsonPlan(plan, joins), [
    { schema: 'sales', table: 'orders', columns: ['customer_id', 'id', 'status_id'] },
    { schema: 'sales', table: 'customers', columns: ['id', 'name'] },
  ]);
  const text = [
    'Hash Join  (cost=1.00..2.00 rows=1 width=4)',
    '  ->  Seq Scan on sales.orders o  (cost=0.00..1.00 rows=1 width=4)',
    '  ->  Index Only Scan using customers_pkey on sales.customers c  (cost=0.00..1.00 rows=1 width=4)',
    '  ->  Function Scan on pg_catalog.generate_series g  (cost=0.00..1.00 rows=1 width=4)',
    '  ->  CTE Scan on per_region  (cost=0.00..1.00 rows=1 width=4)',
  ].join('\n');
  assert.deepEqual(relationsFromTextPlan(text).map(r => `${r.schema}.${r.table}`), ['sales.orders', 'sales.customers']);
});

test('database-wide notes come back from table_knowledge, separate from table notes', () => {
  const mem = tempMemory();
  mem.recordDescribe(ordersDescribe());
  const rule = mem.addNote('example', { kind: 'rule', text: 'Reports exclude status_id 50 and below.' });
  const obs = mem.addNote('example', { kind: 'observation', text: 'Data ends in May 2023 on this copy.', evidence: { sql: 'select max(created_at) from sales.orders', figures: { lastMonth: '2023-05' } } });
  const inf = mem.addNote('example', { kind: 'inference', text: 'The copy may be a partial restore.' });
  const archived = mem.addNote('example', { kind: 'rule', text: 'Old rule.' });
  mem.archiveNote('example', archived.id, 'replaced');
  mem.addNote('example', { kind: 'rule', schema: 'sales', table: 'orders', text: 'Table rule.' });
  mem.addNote('example', { kind: 'rule', schema: 'sales', table: 'customers', text: 'Other table rule.' });

  const known = mem.knowledge('example', 'sales', 'orders');
  assert.deepEqual(known.notes.map(n => n.text), ['Table rule.'], 'table notes stay scoped');
  assert.deepEqual(known.databaseNotes.map(n => n.id), [rule.id, obs.id, inf.id], 'rules first, archived excluded');
  assert.deepEqual(known.databaseNotes.map(n => [n.scope, n.kind, n.confirmed]),
    [['database', 'rule', true], ['database', 'observation', true], ['database', 'inference', false]]);

  const unknown = mem.knowledge('example', 'sales', 'never_seen');
  assert.equal(unknown.known, false);
  assert.equal(unknown.notes, undefined);
  assert.equal(unknown.databaseNotes.length, 3, 'unknown tables get the database notes too');

  assert.equal(mem.knowledge('other', 'sales', 'orders').databaseNotes, undefined, 'notes are per profile');
});

test('database rules are never cut; other database notes are capped and counted', () => {
  const mem = tempMemory();
  for (let i = 0; i < 15; i++) mem.addNote('example', { kind: 'rule', text: `Rule ${i}.` });
  for (let i = 0; i < 14; i++) mem.addNote('example', { kind: 'inference', text: `Guess ${i}.` });
  const k = mem.knowledge('example', 'sales', 'orders');
  assert.equal(k.databaseNotes.filter(n => n.kind === 'rule').length, 15);
  assert.equal(k.databaseNotes.filter(n => n.kind === 'inference').length, 10);
  assert.equal(k.moreDatabaseNotes, 4);
});
