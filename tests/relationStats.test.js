import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyDatabase } from '../src/db.js';
import { relationStats, linkedRowsEstimate, rankNeighbours } from '../src/catalog.js';
import { SchemaMemory } from '../src/memory/store.js';

const edge = (role, table, columns, estRows, extra = {}) => ({
  role, constraint: `${table}_fk_${columns.join('_')}`, schema: 'example', table, relkind: 'r', estRows, canSelect: true, columns, refColumns: columns.map(() => 'id'), ...extra,
});

// example.orders (1000 rows) references status, customer and region_country (a
// two-column key) and a table the role cannot read; seven tables reference it.
const centers = {
  'example.orders': {
    oid: '10', relkind: 'r', est_rows: '1000', can_select: true,
    edges: [
      edge('instance', 'customer', ['customer_id'], 200),
      edge('instance', 'status', ['status_id'], 5),
      edge('instance', 'region_country', ['country', 'region'], 50),
      edge('instance', 'secret', ['secret_id'], 3, { canSelect: false }),
      edge('dependent', 'order_lines', ['order_id'], 5000),
      edge('dependent', 'payments', ['order_id'], 900),
      edge('dependent', 'shipments', ['order_id'], 900),
      edge('dependent', 'notes', ['order_id'], 300),
      edge('dependent', 'audit', ['order_id'], null),
      edge('dependent', 'order_log', ['order_id'], 100, { relkind: 'p' }),
      edge('dependent', 'hidden_child', ['order_id'], 7, { canSelect: false }),
    ],
  },
  'example.lonely': { oid: '11', relkind: 'r', est_rows: '3', can_select: true, edges: [] },
  'example.locked': { oid: '12', relkind: 'r', est_rows: '3', can_select: false, edges: [] },
};
for (let n = 1; n <= 10; n++) {
  centers[`example.t${n}`] = { oid: String(100 + n), relkind: 'r', est_rows: '10', can_select: true, edges: [edge('instance', 'status', ['status_id'], 5)] };
}

// null_frac per schema.table.column; a missing key = no pg_stats row.
const nullFracs = {
  'example.orders.customer_id': 0.2, 'example.orders.status_id': 0, 'example.orders.country': 0.1, 'example.orders.region': 0.3,
  'example.order_lines.order_id': 0, 'example.payments.order_id': 0, 'example.shipments.order_id': 0, 'example.audit.order_id': 0,
  'example.order_log.order_id': 0.5,
};
for (let n = 1; n <= 10; n++) nullFracs[`example.t${n}.status_id`] = 0;

function fakeDb() {
  const sent = [];
  const audit = [];
  const client = {
    async query(q, values) {
      const text = typeof q === 'string' ? q : q.text;
      const params = typeof q === 'string' ? values : q.values;
      sent.push({ text, params });
      if (text.includes("values ('instance'), ('dependent')")) {
        return {
          rows: params[0].map((schema, i) => {
            const c = centers[`${schema}.${params[1][i]}`];
            if (!c) return { ord: i + 1, oid: null, edges: null };
            const edges = params[2] ? c.edges.filter(e => e.schema === params[2]) : c.edges;
            return { ord: i + 1, ...c, edges };
          }),
        };
      }
      if (text.includes('pg_stats')) {
        return { rows: params[0].map((schema, i) => ({ ord: i + 1, null_frac: nullFracs[`${schema}.${params[1][i]}.${params[2][i]}`] ?? null })) };
      }
      return { rows: [] };
    },
    release() {},
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['example', 'postgresql://u@127.0.0.1:1/a']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500,
  }, { audit: e => audit.push(e) });
  db.pool = () => ({ connect: async () => client });
  db.roleChecks.set('example', { status: 'ok', blocking: [], warnings: [] });
  return { db, sent, audit };
}

const brief = items => items.map(i => [i.relation, i.linkedRows, i.tableEstRows, i.stats, i.rank]);

test('relation_stats ranks instance and dependent tables by linked rows, then table rows, with shared ranks', async () => {
  const { db } = fakeDb();
  const r = await relationStats(db, 'example', ['example.orders']);
  const [orders] = r.tables;
  assert.equal(orders.estRows, 1000);
  assert.deepEqual(brief(orders.instance), [
    ['example.status', 1000, 5, 'ok', 1],
    ['example.customer', 800, 200, 'ok', 2],
    ['example.region_country', 700, 50, 'ok', 3], // two-column key: the larger null_frac (0.3)
  ]);
  assert.deepEqual(brief(orders.dependent), [
    ['example.order_lines', 5000, 5000, 'ok', 1],
    ['example.payments', 900, 900, 'ok', 2],
    ['example.shipments', 900, 900, 'ok', 2], // tie: same rank, then by name
    ['example.order_log', 50, 100, 'ok', 4],
    ['example.notes', null, 300, 'missing', 5], // no pg_stats row for the key column
    ['example.audit', null, null, 'missing', 6], // never analyzed: never a fabricated 0
  ]);
  assert.deepEqual(orders.instance[2].columns, ['country', 'region']);
  assert.deepEqual(orders.hidden, { instance: 1, dependent: 1 });
  assert.ok(!JSON.stringify(r).includes('secret'), 'a relation without privilege is not named');
  assert.ok(!JSON.stringify(r).includes('hidden_child'));
});

test('relation_stats takes at most 2 statements however many centers, and one audit entry', async () => {
  const one = fakeDb();
  const r1 = await relationStats(one.db, 'example', ['example.t1']);
  const ten = fakeDb();
  const r10 = await relationStats(ten.db, 'example', Array.from({ length: 10 }, (_, i) => `example.t${i + 1}`));
  assert.equal(r1.statements, 2);
  assert.equal(r10.statements, 2);
  assert.equal(one.sent.length, ten.sent.length);
  assert.equal(ten.audit.filter(e => e.tool === 'relation_stats').length, 1);
  assert.equal(ten.audit[0].statements, 2);
  assert.deepEqual(r10.tables.map(t => t.instance[0].linkedRows), Array(10).fill(10));
  const lonely = fakeDb();
  assert.equal((await relationStats(lonely.db, 'example', ['example.lonely'])).statements, 1, 'no pg_stats statement without neighbours');
});

test('relation_stats looks up each referencing column once, inherited statistics for a partitioned table', async () => {
  const { db, sent: s } = fakeDb();
  await relationStats(db, 'example', ['example.orders', 'example.t1']);
  const stats = s.find(x => x.text.includes('pg_stats'));
  const req = stats.params[0].map((schema, i) => `${schema}.${stats.params[1][i]}.${stats.params[2][i]}:${stats.params[3][i]}`);
  assert.equal(new Set(req).size, req.length, 'no duplicate lookups');
  assert.ok(req.includes('example.order_log.order_id:true'));
  assert.ok(req.includes('example.order_lines.order_id:false'));
  assert.ok(req.includes('example.orders.country:false') && req.includes('example.orders.region:false'));
  assert.ok(!req.some(x => x.includes('secret') || x.includes('hidden_child')), 'hidden relations are not looked up');
});

test('relation_stats reports unknown, invalid and unreadable centers per table and filters neighbours by schema', async () => {
  const { db, sent } = fakeDb();
  const r = await relationStats(db, 'example', ['example.missing', 'example.x";drop', 'example.locked', 'example.lonely']);
  assert.deepEqual([r.found, r.notFound], [1, 3]);
  assert.match(r.tables[0].error, /not found/);
  assert.match(r.tables[1].error, /Invalid table/);
  assert.match(r.tables[2].error, /No SELECT privilege/);
  assert.deepEqual(r.tables[3].instance, []);
  assert.ok(!sent.some(x => x.text.includes('drop')));
  const other = fakeDb();
  const filtered = await relationStats(other.db, 'example', ['example.orders'], 'elsewhere');
  assert.deepEqual([filtered.tables[0].instance, filtered.tables[0].dependent], [[], []]);
  assert.equal(filtered.schema, 'elsewhere');
  await assert.rejects(relationStats(db, 'example', []), /1 to 50/);
});

test('linked rows and ranks: helpers', () => {
  assert.deepEqual(linkedRowsEstimate(100, [0.25]), { linkedRows: 75, stats: 'ok' });
  assert.deepEqual(linkedRowsEstimate(100, [0.1, 0.4]), { linkedRows: 60, stats: 'ok' });
  assert.deepEqual(linkedRowsEstimate(0, [0]), { linkedRows: 0, stats: 'ok' });
  assert.deepEqual(linkedRowsEstimate(null, [0]), { linkedRows: null, stats: 'missing' });
  assert.deepEqual(linkedRowsEstimate(100, [0, null]), { linkedRows: null, stats: 'missing' });
  assert.deepEqual(linkedRowsEstimate(100, []), { linkedRows: null, stats: 'missing' });
  const ranked = rankNeighbours([
    { relation: 'b', constraint: 'x', linkedRows: null, tableEstRows: 9 },
    { relation: 'a', constraint: 'x', linkedRows: 5, tableEstRows: 1 },
    { relation: 'c', constraint: 'x', linkedRows: 5, tableEstRows: 1 },
    { relation: 'd', constraint: 'x', linkedRows: 5, tableEstRows: 2 },
  ]);
  assert.deepEqual(ranked.map(i => [i.relation, i.rank]), [['d', 1], ['a', 2], ['c', 2], ['b', 4]]);
});

test('relation_stats results enrich graph.json: edge linkedRows/estimated/statsAt, node estRows, neighbours seen', async () => {
  const { db } = fakeDb();
  const r = await relationStats(db, 'example', ['example.orders']);
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1) + (clock++) * 60000).toISOString();
  const memory = new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-relstats-')), { now });
  memory.recordDescribe({
    profile: 'example', relation: 'example.customer', schema: 'example', table: 'customer', kind: 'table', oid: 5, estimated_rows: 200, comment: null,
    columns: [{ column: 'id', attnum: 1, type: 'integer', not_null: true }], constraints: [], indexes: [], referencedBy: [],
  });
  const { explored } = memory.recordRelationStats('example', r.tables);
  assert.deepEqual([...explored], ['example.customer']);

  const graph = JSON.parse(fs.readFileSync(path.join(memory.profileDir('example'), 'graph.json'), 'utf8'));
  const node = id => graph.nodes.find(n => n.id === id);
  assert.equal(node('example.orders').state, 'seen');
  assert.equal(node('example.orders').estRows, 1000);
  assert.equal(node('example.order_lines').state, 'seen');
  assert.equal(node('example.audit').estRows, null, 'unknown stays null');
  assert.equal(node('example.customer').state, 'explored');
  assert.equal(node('example.secret'), undefined, 'hidden relations are not recorded');
  const edgeOf = (from, to) => graph.edges.find(e => e.from === from && e.to === to);
  const lines = edgeOf('example.order_lines', 'example.orders');
  assert.deepEqual(lines, { level: 'fk', from: 'example.order_lines', to: 'example.orders', columns: ['order_id'], refColumns: ['id'], linkedRows: 5000, estimated: true, statsAt: lines.statsAt });
  assert.match(lines.statsAt, /^2026-01-01T/);
  assert.equal(edgeOf('example.orders', 'example.region_country').linkedRows, 700);
  assert.equal(edgeOf('example.audit', 'example.orders').linkedRows, null);
  assert.equal(graph.summary.seen, 9); // orders and 8 neighbours; customer is explored

  // A later describe of the center keeps the measurement; edges merge with
  // the declared foreign key instead of doubling.
  memory.recordDescribe({
    profile: 'example', relation: 'example.orders', schema: 'example', table: 'orders', kind: 'table', oid: 10, estimated_rows: 1000, comment: null,
    columns: [{ column: 'id', attnum: 1, type: 'integer' }, { column: 'status_id', attnum: 2, type: 'integer' }],
    constraints: [{ name: 'orders_status_fk', type: 'foreign key', definition: 'x', columns: ['status_id'], ref_schema: 'example', ref_table: 'status', ref_columns: ['id'] }],
    indexes: [], referencedBy: [{ name: 'lines_order_fk', from_schema: 'example', from_name: 'order_lines', columns: ['order_id'], ref_columns: ['id'] }],
  });
  const after = memory.graph('example');
  assert.equal(after.nodes.find(n => n.id === 'example.orders').estRows, 1000);
  const status = after.edges.filter(e => e.from === 'example.orders' && e.to === 'example.status');
  assert.equal(status.length, 1);
  assert.equal(status[0].linkedRows, 1000);
  assert.ok(memory.knowledge('example', 'example', 'orders').relations.referencedBy.some(t => t.startsWith('example.order_lines(order_id)')));
});

test('graph.json stays backward compatible: no new fields without relation_stats', () => {
  const memory = new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-relstats-')));
  memory.recordSeen('example', [{ schema: 'example', table: 'orders', columns: ['id'] }]);
  const graph = memory.graph('example');
  assert.ok(!('estRows' in graph.nodes[0]));
  assert.equal(graph.edges.length, 0);
});
