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

// cargo.orders references cargo.customer_accounts and cargo.status_codes;
// cargo.order_items and cargo.order_events reference cargo.orders; cargo.shipments
// references cargo.order_items; cargo.customer_accounts references billing.invoices.
const edge = (from, to, level = 'fk', linkedRows) => ({ level, from, to, columns: ['x'], refColumns: ['id'], linkedRows });
const edges = [
  edge('cargo.orders', 'cargo.customer_accounts', 'fk', 500), edge('cargo.orders', 'cargo.status_codes', 'fk', 900),
  edge('cargo.order_items', 'cargo.orders', 'fk', 2000), edge('cargo.order_events', 'cargo.orders', 'used'),
  edge('cargo.shipments', 'cargo.order_items'), edge('cargo.customer_accounts', 'billing.invoices'),
  edge('cargo.orders', 'cargo.orders'),
];
// 21 distinct ids from the example schemas and tables, for wide layers.
const pool = ['cargo', 'billing', 'logs'].flatMap(sc => ['orders', 'order_items', 'customer_accounts', 'shipments', 'order_events', 'status_codes', 'invoices'].map(tb => `${sc}.${tb}`));
const at = (r, id) => r.nodes.find(n => n.id === id);
const ids = r => Array.from(r.nodes, n => n.id).sort();

test('depth 1: references on the left, dependents on the right, the center at 0', () => {
  const { layeredLayout, gap } = load();
  const r = layeredLayout(edges, 'cargo.orders', { depth: 1, soft: true });
  assert.deepEqual({ ...at(r, 'cargo.orders') }, { id: 'cargo.orders', side: 'center', depth: 0, rank: 1, x: 0, y: 0, z: 0 });
  for (const id of ['cargo.customer_accounts', 'cargo.status_codes']) { assert.equal(at(r, id).side, 'ref'); assert.equal(at(r, id).x, -gap); }
  for (const id of ['cargo.order_items', 'cargo.order_events']) { assert.equal(at(r, id).side, 'dep'); assert.equal(at(r, id).x, gap); }
  assert.ok(!at(r, 'billing.invoices') && !at(r, 'cargo.shipments'));
  assert.equal(r.canGrow, true);
});

test('depth 2 follows the direction of each side', () => {
  const { layeredLayout, gap } = load();
  const r = layeredLayout(edges, 'cargo.orders', { depth: 2, soft: true });
  assert.deepEqual([at(r, 'billing.invoices').side, at(r, 'billing.invoices').depth, at(r, 'billing.invoices').x], ['ref', 2, -2 * gap]);
  assert.deepEqual([at(r, 'cargo.shipments').side, at(r, 'cargo.shipments').depth, at(r, 'cargo.shipments').x], ['dep', 2, 2 * gap]);
  assert.equal(r.nodes.length, 7);
  assert.equal(r.canGrow, false);
  assert.deepEqual(Array.from(r.layers, l => `${l.side}${l.depth}`), ['center0', 'ref1', 'dep1', 'ref2', 'dep2']);
});

test('ranks follow linked rows, then row estimates, then id; rank 1 on top', () => {
  const { layeredLayout } = load();
  const r = layeredLayout(edges, 'cargo.orders', { depth: 1, soft: true });
  assert.equal(at(r, 'cargo.status_codes').rank, 1);
  assert.equal(at(r, 'cargo.customer_accounts').rank, 2);
  assert.ok(at(r, 'cargo.status_codes').y > at(r, 'cargo.customer_accounts').y);
  const rows = { 'cargo.customer_accounts': 10, 'cargo.status_codes': 99 };
  const r2 = layeredLayout([edge('cargo.orders', 'cargo.customer_accounts'), edge('cargo.orders', 'cargo.status_codes'), edge('cargo.orders', 'billing.invoices')], 'cargo.orders', { depth: 1, rows: id => rows[id] ?? null });
  assert.deepEqual(Array.from(r2.nodes.filter(n => n.side === 'ref').sort((a, b) => a.rank - b.rank), n => n.id), ['cargo.status_codes', 'cargo.customer_accounts', 'billing.invoices']);
});

test('per-side limits cut each layer; cut tables do not reappear deeper', () => {
  const { layeredLayout } = load();
  const kids = pool.filter(id => id !== 'cargo.orders');
  const many = kids.map((id, i) => edge(id, 'cargo.orders', 'fk', 100 - i));
  many.push(edge(kids[19], kids[0]));
  const r = layeredLayout(many, 'cargo.orders', { depth: 2, limits: { ref: 5, dep: 10 } });
  const dep1 = r.nodes.filter(n => n.side === 'dep' && n.depth === 1);
  assert.equal(dep1.length, 10);
  assert.equal(dep1.find(n => n.rank === 1).id, kids[0]);
  assert.ok(!at(r, kids[19]));
  const dl = r.layers.find(l => l.side === 'dep');
  assert.deepEqual([dl.shown, dl.total], [10, 20]);
  const all = layeredLayout(many, 'cargo.orders', { depth: 1, limits: { dep: Infinity } });
  assert.equal(all.nodes.length, 21);
});

test('no two tables share a position, even in wide layers', () => {
  const { layeredLayout, maxRows } = load();
  const kids = pool.filter(id => id !== 'cargo.orders');
  const many = [...kids.slice(0, 13).map(id => edge(id, 'cargo.orders')), ...kids.slice(13).map(id => edge('cargo.orders', id))];
  const r = layeredLayout(many, 'cargo.orders', { depth: 1, limits: { ref: Infinity, dep: Infinity } });
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
  const cyc = [edge('cargo.orders', 'cargo.order_items'), edge('cargo.order_items', 'cargo.orders'), edge('cargo.shipments', 'cargo.order_items'), edge('cargo.order_items', 'cargo.shipments'), edge('cargo.orders', 'cargo.orders')];
  const r = layeredLayout(cyc, 'cargo.orders', { depth: 3 });
  assert.deepEqual(ids(r), ['cargo.order_items', 'cargo.orders', 'cargo.shipments']);
  assert.equal(at(r, 'cargo.order_items').side, 'ref');
  assert.equal(at(r, 'cargo.shipments').side, 'ref');
  assert.equal(at(r, 'cargo.shipments').depth, 2);
  assert.ok(r.links.every(l => l.from !== l.to));
  assert.equal(r.links.filter(l => l.from === 'cargo.order_items' && l.to === 'cargo.orders').length, 1);
  assert.equal(r.links.find(l => l.from === 'cargo.order_items' && l.to === 'cargo.orders').kind, 'cross');
  assert.equal(r.links.find(l => l.from === 'cargo.orders' && l.to === 'cargo.order_items').kind, 'ref');
});

test('FK only unless soft relations are asked for; link kinds and ranks', () => {
  const { layeredLayout } = load();
  const hard = layeredLayout(edges, 'cargo.orders', { depth: 1 });
  assert.ok(!at(hard, 'cargo.order_events'));
  const r = layeredLayout(edges, 'cargo.orders', { depth: 1, soft: true });
  const l = r.links.find(x => x.from === 'cargo.order_events');
  assert.deepEqual([l.level, l.kind], ['used', 'dep']);
  assert.equal(r.links.find(x => x.to === 'cargo.status_codes').rank, 1);
});

test('self references and unknown centers give nothing extra', () => {
  const { layeredLayout } = load();
  assert.deepEqual(ids(layeredLayout([edge('cargo.orders', 'cargo.orders')], 'cargo.orders', { depth: 2 })), ['cargo.orders']);
  assert.equal(layeredLayout(edges, null, {}).nodes.length, 0);
  assert.equal(layeredLayout(edges, 'logs.order_events', { depth: 1 }).canGrow, false);
});

test('top connected tables for the All labels', () => {
  const { topConnected } = load();
  assert.deepEqual(Array.from(topConnected(edges, 2)), ['cargo.orders', 'cargo.customer_accounts']);
});
