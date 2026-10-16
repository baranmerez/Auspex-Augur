import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { roleGraph } from './fixtures/roleGraph.js';

// Runs the graph3d block of src/viewer.html (data mapping and focus rings of
// the 3D Graph view) in isolation, and checks the vendored library it loads.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ graph3d:start[\s\S]*?\/\/ graph3d:end/)?.[0];

function load() {
  assert.ok(block, 'graph3d block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nthis.graph3dVendor = graph3dVendor; this.graph3dVal = graph3dVal; this.graph3dData = graph3dData; this.focusRings = focusRings; this.focusCanGrow = focusCanGrow;`, context);
  return context;
}

// app.orders references app.customers and app.currencies; app.order_lines and
// app.order_notes reference app.orders; app.shipments references app.order_lines;
// app.customers references app.regions. app.audit is not connected.
const edge = (from, to, level = 'fk') => ({ level, from, to, columns: ['x'], refColumns: ['id'] });
const edges = [
  edge('app.orders', 'app.customers'), edge('app.orders', 'app.currencies'),
  edge('app.order_lines', 'app.orders'), edge('app.order_notes', 'app.orders', 'used'),
  edge('app.shipments', 'app.order_lines'), edge('app.customers', 'app.regions'),
  edge('app.orders', 'app.orders'),
];
// Maps come from the vm realm; plain arrays compare across realms.
const sorted = m => Array.from(m.entries(), ([k, v]) => [k, v]).sort((a, b) => a[0].localeCompare(b[0]));

test('depth 1: the center, the tables it references and the tables referencing it', () => {
  const { focusRings } = load();
  const r = focusRings(edges, 'app.orders', 1);
  assert.deepEqual(sorted(r), [['app.currencies', 1], ['app.customers', 1], ['app.order_lines', 1], ['app.order_notes', 1], ['app.orders', 0]]);
});

test('depth 2 adds the next ring only; self references add nothing', () => {
  const { focusRings } = load();
  const r = focusRings(edges, 'app.orders', 2);
  assert.equal(r.get('app.regions'), 2);
  assert.equal(r.get('app.shipments'), 2);
  assert.equal(r.size, 7);
  assert.ok(!r.has('app.audit'));
});

test('a table without relations is alone; no center gives an empty set', () => {
  const { focusRings, focusCanGrow } = load();
  assert.deepEqual(sorted(focusRings(edges, 'app.audit', 1)), [['app.audit', 0]]);
  assert.equal(focusRings(edges, null, 1).size, 0);
  assert.equal(focusCanGrow(edges, 'app.audit', 1), false);
});

test('+1 depth is offered only while another ring adds tables', () => {
  const { focusCanGrow } = load();
  assert.equal(focusCanGrow(edges, 'app.orders', 1), true);
  assert.equal(focusCanGrow(edges, 'app.orders', 2), false);
  assert.equal(focusCanGrow(edges, 'app.shipments', 2), true);
});

test('fixture graph: depth 1 around a center covers its Reference and Dependent tables', () => {
  const { focusRings } = load();
  const data = roleGraph();
  const center = 'app.stock_moves';
  const direct = new Set(data.edges.filter(e => e.from !== e.to && (e.from === center || e.to === center)).map(e => (e.from === center ? e.to : e.from)));
  const r = focusRings(data.edges, center, 1);
  assert.equal(r.size, direct.size + 1);
  for (const id of direct) assert.equal(r.get(id), 1);
  assert.ok(focusRings(data.edges, center, 2).size >= r.size);
});

test('graph data: one node per table, links keep their ids and level, size grows with rows', () => {
  const { graph3dData, graph3dVal } = load();
  const data = roleGraph();
  const g = { nodes: data.nodes, edges: data.edges.filter(e => e.from !== e.to) };
  const gd = graph3dData(g);
  assert.equal(gd.nodes.length, data.nodes.length);
  assert.equal(gd.links.length, g.edges.length);
  for (const [i, l] of gd.links.entries()) {
    assert.equal(l.from, g.edges[i].from);
    assert.equal(l.to, g.edges[i].to);
    assert.equal(l.source, l.from);
    assert.equal(l.target, l.to);
    assert.equal(l.level, g.edges[i].level);
  }
  assert.ok(gd.nodes.every(n => ['explored', 'seen', 'unexplored'].includes(n.state) && n.val >= 1));
  assert.equal(graph3dVal({}), 1);
  assert.equal(graph3dVal({ estimatedRows: null }), 1);
  assert.equal(graph3dVal({ estimatedRows: 0 }), 1);
  assert.ok(graph3dVal({ estimatedRows: 1_000_000 }) > graph3dVal({ estimatedRows: 1_000 }));
  assert.ok(graph3dVal({ estRows: 1_000 }) > 1);
  assert.ok(graph3dVal({ estimatedRows: 1e9 }) < 16, 'log scale keeps huge tables bounded');
});

test('the vendored library exists, matches its recorded sha256 and is served by the viewer', () => {
  const { graph3dVendor } = load();
  const file = new URL(`../src/${graph3dVendor}`, import.meta.url);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const readme = fs.readFileSync(new URL('../src/vendor/README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(hash), 'README records the bundle sha256');
  const name = graph3dVendor.split('/').pop();
  assert.ok(fs.readFileSync(new URL('../src/viewer.js', import.meta.url), 'utf8').includes(`'${name}'`), 'viewer.js serves the file');
  assert.ok(fs.existsSync(new URL(`../src/vendor/${name.replace('.min.js', '.LICENSE.txt')}`, import.meta.url)), 'license kept next to it');
});
