import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the scope block of src/viewer.html (the Schema picker of the Schema
// tab) in isolation over a small invented graph.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ scope:start[\s\S]*?\/\/ scope:end/)?.[0];

function loadScope() {
  assert.ok(block, 'scope block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nthis.scopeGraph = scopeGraph; this.defaultRoot = defaultRoot; this.schemaCenter = schemaCenter; this.schemaTables = schemaTables;`, context);
  return context;
}

const node = (id, state = 'explored') => ({ id, schema: id.split('.')[0], table: id.split('.')[1], state });
const fk = (from, to) => ({ level: 'fk', from, to, columns: ['x_id'], refColumns: ['id'] });
function graph() {
  return {
    nodes: [
      node('app.orders'), node('app.order_lines'), node('app.customers'), node('app.notes', 'unexplored'),
      node('billing.invoices'), node('billing.payments'), node('billing.rates', 'unexplored'),
      node('audit.log_entries', 'unexplored'), node('audit.sessions', 'unexplored'),
      node('stage.raw_rows', 'unexplored'), node('stage.raw_files', 'seen'),
    ],
    edges: [
      fk('app.order_lines', 'app.orders'), fk('app.orders', 'app.customers'),
      fk('billing.invoices', 'app.orders'), fk('billing.payments', 'billing.invoices'), fk('billing.invoices', 'app.customers'),
      fk('audit.log_entries', 'app.customers'), fk('audit.log_entries', 'audit.sessions'),
      fk('stage.raw_rows', 'stage.raw_files'), fk('stage.raw_rows', 'stage.raw_rows'),
      { level: 'suggested', from: 'billing.rates', to: 'app.orders', columns: ['order_id'], refColumns: ['id'] },
    ],
  };
}

test('no schema (or an unknown one) keeps every table and every edge but self references', () => {
  const { scopeGraph } = loadScope();
  for (const schema of ['', undefined, 'missing']) {
    const g = scopeGraph(graph(), schema);
    assert.equal(g.schema, '');
    assert.equal(g.nodes.length, 11);
    assert.equal(g.edges.length, 9, 'the stage self reference is dropped');
    assert.equal(g.outside.size, 0);
    assert.ok(g.inSchema('audit.sessions'));
  }
});

test('a schema keeps its tables and its direct cross-schema neighbours, marked outside', () => {
  const { scopeGraph } = loadScope();
  const g = scopeGraph(graph(), 'billing');
  assert.equal(g.schema, 'billing');
  assert.deepEqual(Array.from(g.nodes, n => n.id).sort(), ['app.customers', 'app.orders', 'billing.invoices', 'billing.payments', 'billing.rates']);
  assert.deepEqual([...g.outside].sort(), ['app.customers', 'app.orders']);
  assert.ok(g.inSchema('billing.rates') && !g.inSchema('app.orders'));
  // Edges between two outside tables (app.orders -> app.customers) are dropped.
  assert.ok(!g.edges.some(e => e.from === 'app.orders' && e.to === 'app.customers'));
  assert.ok(g.edges.every(e => g.inSchema(e.from) || g.inSchema(e.to)));
  assert.equal(g.adj.get('billing.invoices').size, 3);
  // Unrelated schemas stay out entirely.
  assert.ok(!g.byId.has('audit.sessions') && !g.byId.has('stage.raw_rows'));
});

test('the center of a picked schema is its most connected explored table, never an outside one', () => {
  const { scopeGraph, schemaCenter, defaultRoot } = loadScope();
  const billing = scopeGraph(graph(), 'billing');
  assert.equal(schemaCenter(billing), 'billing.invoices');
  assert.equal(defaultRoot(billing), 'billing.invoices');
  // app.orders has the most links overall but is outside the audit scope.
  const audit = scopeGraph(graph(), 'audit');
  assert.equal(schemaCenter(audit), null, 'nothing explored in audit');
  assert.equal(defaultRoot(audit), 'audit.log_entries', 'the graph still focuses the most connected own table');
  assert.ok(audit.outside.has('app.customers'));
  // A schema without any relation: the graph root is its first table, no center.
  const stage = scopeGraph(graph(), 'stage');
  assert.equal(schemaCenter(stage), null);
  assert.equal(defaultRoot(stage), 'stage.raw_rows');
  // Unscoped, the explored table with the most relations wins.
  assert.equal(defaultRoot(scopeGraph(graph(), '')), 'app.orders');
});

test('the pick list of a schema has explored tables first, then by relations, then by name', () => {
  const { scopeGraph, schemaTables } = loadScope();
  assert.deepEqual(Array.from(schemaTables(scopeGraph(graph(), 'audit')), n => n.id), ['audit.log_entries', 'audit.sessions']);
  assert.deepEqual(Array.from(schemaTables(scopeGraph(graph(), 'stage')), n => n.id), ['stage.raw_files', 'stage.raw_rows']);
  assert.deepEqual(Array.from(schemaTables(scopeGraph(graph(), 'app')), n => n.id), ['app.orders', 'app.customers', 'app.order_lines', 'app.notes']);
});
