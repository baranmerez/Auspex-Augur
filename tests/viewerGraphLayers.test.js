import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the graph3d block of src/viewer.html in isolation and checks the
// directed layer layout of the focused 3D Graph.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ graph3d:start[\s\S]*?\/\/ graph3d:end/)?.[0];

function load() {
  assert.ok(block, 'graph3d block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nthis.layeredLayout = layeredLayout; this.topConnected = topConnected; this.gap = layerGap; this.maxRows = layerMaxRows;`, context);
  return context;
}

// example.orders references example.customers and example.status_codes;
// example.order_items and example.order_events reference example.orders; example.shipments
// references example.order_items; example.customers references test.invoices.
const edge = (from, to, level = 'fk', linkedRows) => ({ level, from, to, columns: ['x'], refColumns: ['id'], linkedRows });
const edges = [
  edge('example.orders', 'example.customers', 'fk', 500), edge('example.orders', 'example.status_codes', 'fk', 900),
  edge('example.order_items', 'example.orders', 'fk', 2000), edge('example.order_events', 'example.orders', 'used'),
  edge('example.shipments', 'example.order_items'), edge('example.customers', 'test.invoices'),
  edge('example.orders', 'example.orders'),
];
// 21 distinct ids from the example schemas and tables, for wide layers.
const pool = ['example', 'test', 'logs'].flatMap(sc => ['orders', 'order_items', 'customers', 'shipments', 'order_events', 'status_codes', 'invoices'].map(tb => `${sc}.${tb}`));
const at = (r, id) => r.nodes.find(n => n.id === id);
const ids = r => Array.from(r.nodes, n => n.id).sort();

test('depth 1: references on the left, dependents on the right, the center at 0', () => {
  const { layeredLayout, gap } = load();
  const r = layeredLayout(edges, 'example.orders', { depth: 1, soft: true });
  assert.deepEqual({ ...at(r, 'example.orders') }, { id: 'example.orders', side: 'center', depth: 0, rank: 1, x: 0, y: 0, z: 0 });
  for (const id of ['example.customers', 'example.status_codes']) { assert.equal(at(r, id).side, 'ref'); assert.equal(at(r, id).x, -gap); }
  for (const id of ['example.order_items', 'example.order_events']) { assert.equal(at(r, id).side, 'dep'); assert.equal(at(r, id).x, gap); }
  assert.ok(!at(r, 'test.invoices') && !at(r, 'example.shipments'));
  assert.equal(r.canGrow, true);
});

test('depth 2 follows the direction of each side', () => {
  const { layeredLayout, gap } = load();
  const r = layeredLayout(edges, 'example.orders', { depth: 2, soft: true });
  assert.deepEqual([at(r, 'test.invoices').side, at(r, 'test.invoices').depth, at(r, 'test.invoices').x], ['ref', 2, -2 * gap]);
  assert.deepEqual([at(r, 'example.shipments').side, at(r, 'example.shipments').depth, at(r, 'example.shipments').x], ['dep', 2, 2 * gap]);
  assert.equal(r.nodes.length, 7);
  assert.equal(r.canGrow, false);
  assert.deepEqual(Array.from(r.layers, l => `${l.side}${l.depth}`), ['center0', 'ref1', 'dep1', 'ref2', 'dep2']);
});

test('ranks follow linked rows, then row estimates, then id; rank 1 on top', () => {
  const { layeredLayout } = load();
  const r = layeredLayout(edges, 'example.orders', { depth: 1, soft: true });
  assert.equal(at(r, 'example.status_codes').rank, 1);
  assert.equal(at(r, 'example.customers').rank, 2);
  assert.ok(at(r, 'example.status_codes').y > at(r, 'example.customers').y);
  const rows = { 'example.customers': 10, 'example.status_codes': 99 };
  const r2 = layeredLayout([edge('example.orders', 'example.customers'), edge('example.orders', 'example.status_codes'), edge('example.orders', 'test.invoices')], 'example.orders', { depth: 1, rows: id => rows[id] ?? null });
  assert.deepEqual(Array.from(r2.nodes.filter(n => n.side === 'ref').sort((a, b) => a.rank - b.rank), n => n.id), ['example.status_codes', 'example.customers', 'test.invoices']);
});

test('per-side limits cut each layer; cut tables do not reappear deeper', () => {
  const { layeredLayout } = load();
  const kids = pool.filter(id => id !== 'example.orders');
  const many = kids.map((id, i) => edge(id, 'example.orders', 'fk', 100 - i));
  many.push(edge(kids[19], kids[0]));
  const r = layeredLayout(many, 'example.orders', { depth: 2, limits: { ref: 5, dep: 10 } });
  const dep1 = r.nodes.filter(n => n.side === 'dep' && n.depth === 1);
  assert.equal(dep1.length, 10);
  assert.equal(dep1.find(n => n.rank === 1).id, kids[0]);
  assert.ok(!at(r, kids[19]));
  const dl = r.layers.find(l => l.side === 'dep');
  assert.deepEqual([dl.shown, dl.total], [10, 20]);
  const all = layeredLayout(many, 'example.orders', { depth: 1, limits: { dep: Infinity } });
  assert.equal(all.nodes.length, 21);
});

test('no two tables share a position, even in wide layers', () => {
  const { layeredLayout, maxRows } = load();
  const kids = pool.filter(id => id !== 'example.orders');
  const many = [...kids.slice(0, 13).map(id => edge(id, 'example.orders')), ...kids.slice(13).map(id => edge('example.orders', id))];
  const r = layeredLayout(many, 'example.orders', { depth: 1, limits: { ref: Infinity, dep: Infinity } });
  assert.equal(r.nodes.length, 21);
  let min = Infinity;
  for (let i = 0; i < r.nodes.length; i++) for (let j = i + 1; j < r.nodes.length; j++) {
    const a = r.nodes[i], b = r.nodes[j];
    min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
  }
  assert.ok(min >= 20, `closest pair ${min}`);
  const dep = r.nodes.filter(n => n.side === 'dep');
  assert.equal(new Set(dep.map(n => n.z)).size, 2);
  assert.ok(new Set(dep.map(n => n.y)).size <= maxRows * 2);
});

test('cycles: a table both referenced and referencing appears once, on the side found first', () => {
  const { layeredLayout } = load();
  const cyc = [edge('example.orders', 'example.order_items'), edge('example.order_items', 'example.orders'), edge('example.shipments', 'example.order_items'), edge('example.order_items', 'example.shipments'), edge('example.orders', 'example.orders')];
  const r = layeredLayout(cyc, 'example.orders', { depth: 3 });
  assert.deepEqual(ids(r), ['example.order_items', 'example.orders', 'example.shipments']);
  assert.equal(at(r, 'example.order_items').side, 'ref');
  assert.equal(at(r, 'example.shipments').side, 'ref');
  assert.equal(at(r, 'example.shipments').depth, 2);
  assert.ok(r.links.every(l => l.from !== l.to));
  assert.equal(r.links.filter(l => l.from === 'example.order_items' && l.to === 'example.orders').length, 1);
  assert.equal(r.links.find(l => l.from === 'example.order_items' && l.to === 'example.orders').kind, 'cross');
  assert.equal(r.links.find(l => l.from === 'example.orders' && l.to === 'example.order_items').kind, 'ref');
});

test('FK only unless soft relations are asked for; link kinds and ranks', () => {
  const { layeredLayout } = load();
  const hard = layeredLayout(edges, 'example.orders', { depth: 1 });
  assert.ok(!at(hard, 'example.order_events'));
  const r = layeredLayout(edges, 'example.orders', { depth: 1, soft: true });
  const l = r.links.find(x => x.from === 'example.order_events');
  assert.deepEqual([l.level, l.kind], ['used', 'dep']);
  assert.equal(r.links.find(x => x.to === 'example.status_codes').rank, 1);
});

test('self references and unknown centers give nothing extra', () => {
  const { layeredLayout } = load();
  assert.deepEqual(ids(layeredLayout([edge('example.orders', 'example.orders')], 'example.orders', { depth: 2 })), ['example.orders']);
  assert.equal(layeredLayout(edges, null, {}).nodes.length, 0);
  assert.equal(layeredLayout(edges, 'logs.order_events', { depth: 1 }).canGrow, false);
});

test('top connected tables for the All labels', () => {
  const { topConnected } = load();
  assert.deepEqual(Array.from(topConnected(edges, 2)), ['example.orders', 'example.customers']);
});
