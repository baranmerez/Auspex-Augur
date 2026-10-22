import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyDatabase } from '../src/db.js';
import { describeTables, describeFunctions, listFunctions, summarizeDescribedTable, viewDependenciesFromRows } from '../src/catalog.js';

// Catalog rows of the view dependency statement (see viewDependenciesSql):
// example.v_order_list (oid 31) reads example.orders (11) and
// example.customers (12) and calls example.order_total; example.mv_order_days
// (32) reads example.orders; example.orders is read by both.
const src = (relid, schema, name, column, relkind = 'r') => ({ dep: 'source', relid, ref_type: 'relation', ref_schema: schema, ref_name: name, ref_relkind: relkind, ref_column: column, ref_arguments: null, ref_volatility: null });
const dependencyRows = [
  src('31', 'example', 'orders', 'status_code'),
  src('31', 'example', 'orders', 'order_id'),
  src('31', 'example', 'orders', 'order_id'),
  src('31', 'example', 'customers', null),
  src('31', 'example', 'customers', 'customer_id'),
  { dep: 'source', relid: '31', ref_type: 'function', ref_schema: 'example', ref_name: 'order_total', ref_relkind: null, ref_column: null, ref_arguments: 'p_order_id bigint', ref_volatility: 'stable' },
  src('32', 'example', 'orders', 'created_at'),
  { dep: 'used_by', relid: '11', ref_type: 'relation', ref_schema: 'example', ref_name: 'v_order_list', ref_relkind: 'v' },
  { dep: 'used_by', relid: '11', ref_type: 'relation', ref_schema: 'example', ref_name: 'mv_order_days', ref_relkind: 'm' },
];

const relations = {
  'example.orders': { oid: '11', relkind: 'r' },
  'example.customers': { oid: '12', relkind: 'r' },
  'example.v_order_list': { oid: '31', relkind: 'v' },
  'example.mv_order_days': { oid: '32', relkind: 'm' },
};

function fakeDb({ rows = {} } = {}) {
  const sent = [];
  const client = {
    async query(q, values) {
      const text = typeof q === 'string' ? q : q.text;
      const params = typeof q === 'string' ? values : q.values;
      sent.push({ text, params });
      if (text.includes('pg_get_function_identity_arguments(p.oid) as arguments') && text.includes('limit $3')) return { rows: rows.list ?? [] };
      if (text.includes('pg_get_functiondef')) return { rows: rows.functions ?? [] };
      if (text.includes('with ordinality as r(schema, name, ord)')) {
        return { rows: params[0].map((schema, i) => ({ ord: i + 1, oid: relations[`${schema}.${params[1][i]}`]?.oid ?? null, relkind: relations[`${schema}.${params[1][i]}`]?.relkind ?? null, estimated_rows: null, comment: null })) };
      }
      if (text.includes('from pg_rewrite r')) return { rows: dependencyRows.filter(r => params[0].includes(r.relid)) };
      if (text.includes('pg_get_viewdef')) {
        return { rows: [
          { relid: '31', relkind: 'v', definition: ' SELECT o.order_id\n   FROM example.orders o;', options: ['security_barrier=true', 'check_option=local'], populated: true },
          { relid: '32', relkind: 'm', definition: ' SELECT 1;', options: null, populated: false },
        ].filter(r => params[0].includes(r.relid)) };
      }
      return { rows: [] };
    },
    release() {},
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['example', 'postgresql://u@127.0.0.1:1/a']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500,
  }, { audit: () => {} });
  db.pool = () => ({ connect: async () => client });
  db.roleChecks.set('example', { status: 'ok', blocking: [], warnings: [] });
  return { db, sent };
}

test('dependency rows group into sorted, distinct sources, functions and usedBy', () => {
  const d = viewDependenciesFromRows(dependencyRows);
  assert.deepEqual(d.sources.get('31'), [
    { schema: 'example', table: 'customers', kind: 'table', columns: ['customer_id'] },
    { schema: 'example', table: 'orders', kind: 'table', columns: ['order_id', 'status_code'] },
  ]);
  assert.deepEqual(d.functions.get('31'), [{ schema: 'example', name: 'order_total', arguments: 'p_order_id bigint', volatility: 'stable' }]);
  assert.deepEqual(d.usedBy.get('11'), [
    { schema: 'example', table: 'mv_order_days', kind: 'matview' },
    { schema: 'example', table: 'v_order_list', kind: 'view' },
  ]);
  assert.equal(d.sources.get('11'), undefined);
});

test('describe_tables: views get definition, options, populated, sources and functions; every relation usedByViews', async () => {
  const { db, sent } = fakeDb();
  const r = await describeTables(db, 'example', ['example.orders', 'example.v_order_list', 'example.mv_order_days']);
  assert.equal(r.statements, 8, '6 + view dependencies + view facts');
  const [orders, view, matview] = r.tables;
  assert.deepEqual(orders.usedByViews.map(v => `${v.table}:${v.kind}`), ['mv_order_days:matview', 'v_order_list:view']);
  assert.equal(orders.viewDefinition, undefined);
  assert.equal(orders.viewSources, undefined);
  assert.deepEqual(view.viewOptions, { securityBarrier: true, checkOption: 'local' });
  assert.equal(view.populated, undefined, 'populated only for materialized views');
  assert.deepEqual(view.viewSources.map(s => s.table), ['customers', 'orders']);
  assert.deepEqual(view.viewFunctions.map(f => f.name), ['order_total']);
  assert.deepEqual(view.usedByViews, []);
  assert.deepEqual([matview.kind, matview.populated, matview.viewOptions], ['matview', false, { securityBarrier: false, checkOption: null }]);
  assert.deepEqual(sent.find(s => s.text.includes('from pg_rewrite r')).params, [['11', '31', '32']]);
  const deps = sent.find(s => s.text.includes('from pg_rewrite r')).text;
  assert.equal(deps.match(/r\.ev_type = '1'/g)?.length, 2, 'both branches read the SELECT rule only, not DO INSTEAD rules');
  // Sequences read by a view are sources too, so a later view description does not
  // drop the sequence's own Used by views entry in the viewer.
  assert.match(deps, /rc\.relkind in \('r', 'p', 'v', 'm', 'f', 'S'\)/);

  const s = summarizeDescribedTable(view);
  assert.equal(s.viewDefinitionOmitted, true);
  assert.equal(s.viewSources, 'example.customers(customer_id), example.orders(order_id, status_code)');
  assert.equal(s.viewFunctions, 'example.order_total(p_order_id bigint)');
  assert.equal(summarizeDescribedTable(orders).usedByViews, 'example.mv_order_days, example.v_order_list');
  assert.equal(summarizeDescribedTable(matview).populated, false);
});

test('describe_tables without views: one dependency statement, no view facts; none at all when nothing is found', async () => {
  const plain = fakeDb();
  assert.equal((await describeTables(plain.db, 'example', ['example.orders', 'example.customers'])).statements, 7);
  assert.equal(plain.sent.filter(s => s.text.includes('pg_get_viewdef')).length, 0);
  const missing = fakeDb();
  const r = await describeTables(missing.db, 'example', ['example.nope']);
  assert.equal(r.statements, 1);
  assert.equal(missing.sent.filter(s => s.text.includes('pg_rewrite')).length, 0);
});

test('describe_functions keeps 200000 characters for the memory whatever maxChars returns', async () => {
  const definition = `CREATE FUNCTION example.f()\n LANGUAGE sql\nAS $function$ SELECT 1 $function$${'x'.repeat(300)}`;
  const { db, sent } = fakeDb({ rows: { functions: [{ ord: 1, schema: 'example', name: 'f', arguments: '', kind: 'function', language: 'sql', config: null, used_by_triggers: [], definition, definition_length: String(definition.length) }] } });
  const r = await describeFunctions(db, 'example', { functions: ['example.f'], maxChars: 10 });
  const [f] = r.functions;
  assert.equal(f.definition, definition.slice(0, 10));
  assert.equal(f.truncated, true);
  assert.equal(f.memoryDefinition, definition, 'not enumerable');
  assert.equal(JSON.stringify(f).includes('memoryDefinition'), false);
  assert.match(sent.find(s => s.text.includes('pg_get_functiondef')).text, /greatest\(\$1::int, 200000\)/);
});

test('list_functions: one statement, limit + 1 to detect truncation, input checked before connecting', async () => {
  const row = i => ({ schema: 'example', name: `order_fn_${i}`, arguments: null, returns: 'void', kind: 'function', language: 'sql', volatility: 'volatile' });
  const { db, sent } = fakeDb({ rows: { list: [row(1), row(2), row(3)] } });
  const r = await listFunctions(db, 'example', { schema: 'example', pattern: 'order', limit: 2 });
  assert.deepEqual([r.statements, r.rowCount, r.truncated, r.pattern], [1, 2, true, '%order%']);
  assert.deepEqual(r.functions[0], { schema: 'example', name: 'order_fn_1', arguments: '', returns: 'void', kind: 'function', language: 'sql', volatility: 'volatile', returnsTrigger: false, usedByTriggers: [] });
  const statement = sent.find(s => s.text.includes('limit $3'));
  assert.deepEqual(statement.params, ['example', '%order%', 3, false]);
  assert.match(statement.text, /deptype = 'e'/);
  assert.match(statement.text, /not like 'pg\\_%'/);
  const all = fakeDb();
  await listFunctions(all.db, 'example', { includeExtensions: true });
  assert.deepEqual(all.sent.find(s => s.text.includes('limit $3')).params, [null, null, 501, true]);
  for (const limit of [0, 2001, 1.5]) {
    const fresh = fakeDb();
    await assert.rejects(listFunctions(fresh.db, 'example', { limit }), /limit must be/);
    assert.equal(fresh.sent.length, 0);
  }
});
