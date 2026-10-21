import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { roleGraph, roleTables } from './fixtures/roleGraph.js';

// Runs the roles block of src/viewer.html (Reference / Dependent ranking used
// by the Graph, ER diagram and Flow views) in isolation over the fixture graph.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const tableKeyLines = page.match(/^const tableKey = .*\r?\n^const splitTableKey = .*$/m)[0];
const block = page.match(/\/\/ roles:start[\s\S]*?\/\/ roles:end/)?.[0];

function loadRoles() {
  assert.ok(block, 'roles block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${tableKeyLines}\n${block}\nthis.roleGroups = roleGroups; this.roleColor = roleColor; this.flowWidth = flowWidth; this.roleTop = roleTop; this.roleShown = roleShown; this.roleLimitIn = roleLimitIn; this.roleLimitSet = roleLimitSet; this.roleMigrated = roleMigrated; this.roleOptions = roleOptions; this.roleActive = roleActive; this.tableOf = tableOf; this.joinLabel = joinLabel; this.joinLabels = joinLabels; this.centerColumns = centerColumns;`, context);
  return context;
}

test('a wide center splits into Reference and Dependent tables from FKs only', () => {
  const { roleGroups } = loadRoles();
  const g = roleGroups(roleGraph(), 'app.stock_moves');
  assert.equal(g.ref.length, 12);
  assert.equal(g.dep.length, 21);
  assert.equal(g.ref.length + g.dep.length, 33);
  assert.ok(g.ref.every(x => x.role === 'ref') && g.dep.every(x => x.role === 'dep'));
  assert.deepEqual(Array.from(g.ref, x => x.rank), Array.from({ length: 12 }, (_, i) => i + 1));
});

test('ranking: linked rows first, then the table row estimate, then name', () => {
  const { roleGroups } = loadRoles();
  const g = roleGroups(roleGraph(), 'app.stock_moves');
  // stock_items, stock_move_types and sube all link 9.4M rows: the bigger table wins, then the name.
  assert.deepEqual(Array.from(g.ref.slice(0, 3), x => x.id), ['app.stock_items', 'app.stock_move_types', 'app.sube']);
  const linked = g.ref.filter(x => x.linkedRows !== null);
  for (let i = 1; i < linked.length; i++) assert.ok(linked[i - 1].linkedRows >= linked[i].linkedRows);
  // Edges without linkedRows come after every edge with it, ordered by the table estimate.
  const tail = g.ref.slice(linked.length);
  assert.ok(tail.every(x => x.linkedRows === null && !x.fromLinks));
  assert.deepEqual(Array.from(tail, x => x.id), ['app.batches', 'app.ledger_accounts', 'app.locations', 'app.users']);
});

test('fallback: weight is linkedRows when known, else estRows or estimatedRows, else null', () => {
  const { roleGroups } = loadRoles();
  const g = roleGroups(roleGraph(), 'app.stock_moves');
  const byId = new Map([...g.ref, ...g.dep].map(x => [x.id, x]));
  assert.equal(byId.get('app.stock_items').weight, 9_400_000);
  assert.equal(byId.get('app.stock_items').fromLinks, true);
  assert.equal(byId.get('app.batches').weight, 88_000, 'estimatedRows of an explored table');
  assert.equal(byId.get('app.batches').fromLinks, false);
  assert.equal(byId.get('app.users').weight, null, 'unexplored, no figure at all');
  const estRowsOnly = g.dep.find(x => x.linkedRows === null && x.node.estRows !== undefined);
  assert.ok(estRowsOnly, 'fixture has a dependent known only by estRows');
  assert.equal(estRowsOnly.weight, estRowsOnly.node.estRows);
});

test('self references and non-FK relations take no role; several FKs to one table count once', () => {
  const { roleGroups } = loadRoles();
  const data = roleGraph();
  data.edges.push({ level: 'fk', from: 'app.orders', to: 'app.customers', columns: ['delivery_customer_id'], refColumns: ['id'], linkedRows: 90_000 });
  const g = roleGroups(data, 'app.orders');
  assert.deepEqual(Array.from(g.ref, x => x.id), ['app.status_codes', 'app.customers', 'app.currencies']);
  assert.deepEqual(Array.from(g.dep, x => x.id), ['app.order_items', 'app.order_services', 'app.order_notes']);
  const cari = g.ref.find(x => x.id === 'app.customers');
  assert.equal(cari.links.length, 2);
  assert.equal(cari.linkedRows, 1_240_000, 'the larger figure, not a sum');
  assert.ok(!g.ref.some(x => x.id === 'app.proje'), 'suggested relation is not a role');
  assert.ok(!g.ref.some(x => x.id === 'app.orders'), 'self reference is not a role');
});

test('depth 2: a dependent has dependents of its own', () => {
  const { roleGroups } = loadRoles();
  const g = roleGroups(roleGraph(), 'app.order_items');
  assert.deepEqual(Array.from(g.dep, x => x.id), ['app.order_item_deliveries', 'app.order_item_discounts']);
  assert.deepEqual(Array.from(g.ref, x => x.id).sort(), ['app.orders', 'app.stock_items']);
});

test('colors run from the -1 token (rank 1) to the -10 token (rank 10), grey beyond', () => {
  const { roleColor, roleTop } = loadRoles();
  assert.equal(roleTop, 10);
  assert.match(roleColor('ref', 1), /var\(--role-ref-1\), var\(--role-ref-10\) 0%/);
  assert.match(roleColor('dep', 10), /var\(--role-dep-1\), var\(--role-dep-10\) 100%/);
  assert.match(roleColor('dep', 5), /44%\)$/);
  assert.equal(roleColor('ref', 11), 'var(--role-other)');
});

test('flow edge width grows on a log scale and stays in range', () => {
  const { flowWidth } = loadRoles();
  assert.equal(flowWidth(null, 100), 1.5);
  assert.equal(flowWidth(100, 0), 1.5);
  assert.equal(flowWidth(1_000_000, 1_000_000), 8.5);
  const mid = flowWidth(1000, 1_000_000);
  assert.ok(mid > 1.5 && mid < 8.5);
  assert.ok(Math.abs(mid - (1.5 + 7 * Math.log10(1001) / Math.log10(1_000_001))) < 1e-9);
});

test('top-N limits are independent per view and side', () => {
  const { roleLimitIn, roleLimitSet, roleShown } = loadRoles();
  const sides = [['er', 'ref'], ['er', 'dep'], ['flow', 'ref'], ['flow', 'dep'], ['flow', 'dep2']];
  for (const [view, side] of sides) {
    for (const limit of [10, 25, 50, Infinity]) {
      const s = roleLimitSet(undefined, view, side, limit);
      for (const [v, k] of sides) {
        const want = v === view && k === side ? limit : roleShown;
        assert.equal(roleLimitIn(s, v, k), want, `${view}.${side}=${limit}: ${v}.${k}`);
      }
    }
  }
  // Several sides set together keep their own values through further changes.
  let s = roleLimitSet(roleLimitSet(undefined, 'er', 'ref', 25), 'er', 'dep', 50);
  s = roleLimitSet(s, 'er', 'ref', 5);
  assert.equal(roleLimitIn(s, 'er', 'ref'), 5);
  assert.equal(roleLimitIn(s, 'er', 'dep'), 50);
  assert.equal(roleLimitIn(s, 'flow', 'dep'), roleShown, 'the ER picker does not change the Flow lane');
  // The input object is never mutated (state is replaced, not shared).
  const frozen = Object.freeze({ 'flow.dep': 25 });
  assert.equal(roleLimitIn(roleLimitSet(frozen, 'flow', 'ref', 50), 'flow', 'dep'), 25);
  // All is stored as 'all' (JSON keeps it) and read back as Infinity.
  const all = roleLimitSet(undefined, 'flow', 'dep2', Infinity);
  assert.equal(all['flow.dep2'], 'all');
  assert.equal(roleLimitIn(JSON.parse(JSON.stringify(all)), 'flow', 'dep2'), Infinity);
  // Unknown values fall back to the default.
  assert.equal(roleLimitIn({ 'er.ref': 7 }, 'er', 'ref'), roleShown);
  assert.equal(roleLimitIn({ 'er.ref': '25' }, 'er', 'ref'), roleShown);
  assert.equal(roleLimitSet(undefined, 'er', 'ref', 7)['er.ref'], roleShown);
});

test('25, 50 and All draw exactly as many cards as the header counts', () => {
  const { roleGroups, roleLimitIn, roleLimitSet, roleOptions, roleActive } = loadRoles();
  // A wide fixture: 60 dependents of one center.
  const nodes = [{ id: 'app.orders', state: 'explored' }];
  const edges = [];
  for (let i = 0; i < 60; i++) {
    nodes.push({ id: `app.order_part_${String(i).padStart(2, '0')}`, state: 'unexplored', estRows: 1000 - i });
    edges.push({ level: 'fk', from: nodes[i + 1].id, to: 'app.orders', columns: ['order_id'], refColumns: ['id'], linkedRows: 100_000 - i });
  }
  const dep = roleGroups({ nodes, edges }, 'app.orders').dep;
  assert.equal(dep.length, 60);
  for (const [limit, drawn] of [[5, 5], [10, 10], [25, 25], [50, 50], [Infinity, 60]]) {
    const s = roleLimitSet(undefined, 'flow', 'dep', limit);
    const n = roleLimitIn(s, 'flow', 'dep');
    // The header shows "top {min(limit, count)} of {count}"; the lane draws slice(0, limit).
    assert.equal(dep.slice(0, n).length, drawn);
    assert.equal(Math.min(n, dep.length), drawn);
  }
  // The picker offers the limits below the count, then All.
  assert.deepEqual(Array.from(roleOptions(60)), [5, 10, 25, 50, Infinity]);
  assert.deepEqual(Array.from(roleOptions(30)), [5, 10, 25, Infinity]);
  assert.deepEqual(Array.from(roleOptions(12)), [5, 10, Infinity]);
  assert.deepEqual(Array.from(roleOptions(6)), [5, Infinity]);
  // A limit that covers every table marks All, so the picker names what is drawn.
  assert.equal(roleActive(50, 30), Infinity);
  assert.equal(roleActive(25, 30), 25);
  assert.equal(roleActive(10, 10), Infinity);
  assert.equal(roleActive(Infinity, 3), Infinity);
});

test('old top 5 / top 10 state migrates: true becomes 10, everything else the default', () => {
  const { roleMigrated, roleLimitIn, roleShown, roleTop } = loadRoles();
  const old = { 'er.ref': true, 'er.dep': false, 'flow.dep': true, 'flow.ref': 25, 'flow.dep2': 'all', junk: 'x' };
  const m = roleMigrated(old);
  assert.deepEqual({ ...m }, { 'er.ref': 10, 'flow.dep': 10, 'flow.ref': 25, 'flow.dep2': 'all' });
  assert.equal(roleLimitIn(m, 'er', 'ref'), roleTop);
  assert.equal(roleLimitIn(m, 'er', 'dep'), roleShown);
  assert.equal(roleLimitIn(m, 'flow', 'dep2'), Infinity);
  // Unmigrated state still reads true as 10.
  assert.equal(roleLimitIn(old, 'flow', 'dep'), 10);
  // Old shapes ({ ref: true }, true, null, arrays) open nothing.
  assert.equal(roleLimitIn({ ref: true, dep: true }, 'er', 'ref'), roleShown);
  assert.equal(roleLimitIn(true, 'er', 'ref'), roleShown);
  assert.deepEqual({ ...roleMigrated(true) }, {});
  assert.deepEqual({ ...roleMigrated(null) }, {});
  assert.deepEqual({ ...roleMigrated([true]) }, {});
});

test('join labels name the referencing column, then the referenced table and column', () => {
  const { roleGroups, joinLabel, joinLabels, tableOf } = loadRoles();
  assert.equal(tableOf('app.orders'), 'orders');
  assert.equal(tableOf('orders'), 'orders');
  const g = roleGroups(roleGraph(), 'app.orders');
  const satir = g.dep.find(x => x.id === 'app.order_items');
  assert.deepEqual(Array.from(joinLabels(satir, 'app.orders')), ['order_id → orders.id']);
  const cari = g.ref.find(x => x.id === 'app.customers');
  assert.deepEqual(Array.from(joinLabels(cari, 'app.orders')), ['customer_id → customers.id']);
  // The brief's examples and a composite key.
  assert.equal(joinLabel('dep', { centerCols: ['order_id'], nbCols: ['order_id'] }, 'app.orders', 'app.order_details'), 'order_id → orders.order_id');
  assert.equal(joinLabel('ref', { centerCols: ['customer_code'], nbCols: ['account_code'] }, 'app.orders', 'app.customer_accounts'), 'customer_code → customer_accounts.account_code');
  assert.equal(joinLabel('ref', { centerCols: ['a', 'b'], nbCols: ['x', 'y'] }, 'app.c', 'app.n'), '(a, b) → n.(x, y)');
  assert.equal(joinLabel('dep', { centerCols: [], nbCols: [] }, 'app.c', 'app.n'), '? → c.?');
});

test('two FKs between the same pair of tables give two join labels, in edge order', () => {
  const { roleGroups, joinLabels } = loadRoles();
  const data = roleGraph();
  data.edges.push({ level: 'fk', from: 'app.orders', to: 'app.customers', columns: ['delivery_customer_id'], refColumns: ['id'], linkedRows: 90_000 });
  const cari = roleGroups(data, 'app.orders').ref.find(x => x.id === 'app.customers');
  assert.deepEqual(Array.from(joinLabels(cari, 'app.orders')), ['customer_id → customers.id', 'delivery_customer_id → customers.id']);
});

test('depth 2: join labels point at the opened dependent, not the center', () => {
  const { roleGroups, joinLabels } = loadRoles();
  const g = roleGroups(roleGraph(), 'app.order_items');
  const teslim = g.dep.find(x => x.id === 'app.order_item_deliveries');
  assert.deepEqual(Array.from(joinLabels(teslim, 'app.order_items')), ['order_items_id → order_items.id']);
});

test('center columns: PK, FK, referenced, used and noted columns are tagged', () => {
  const { centerColumns } = loadRoles();
  const data = roleGraph();
  data.notes.push({ id: 1, kind: 'rule', status: 'active', schema: 'app', table: 'orders', column: 'alan_01', text: 'x' },
    { id: 2, kind: 'rule', status: 'archived', schema: 'app', table: 'orders', column: 'alan_02', text: 'y' });
  const rec = roleTables(data).find(x => x.table === 'orders');
  rec.usedColumns = { alan_03: { count: 2 } };
  const c = centerColumns(data, 'app.orders', rec);
  assert.deepEqual(Array.from(c.pk), ['id']);
  assert.equal(c.cols.length, rec.columns.length);
  assert.equal(c.notes.length, 1, 'active notes only');
  assert.deepEqual(Array.from(c.tagsOf('id')), ['PK']);
  assert.deepEqual(Array.from(c.tagsOf('customer_id')), ['FK']);
  assert.deepEqual(Array.from(c.tagsOf('parent_order_id')), ['FK'], 'self reference');
  assert.deepEqual(Array.from(c.tagsOf('alan_03')), ['U']);
  assert.deepEqual(Array.from(c.tagsOf('alan_01')), ['N']);
  assert.deepEqual(Array.from(c.tagsOf('alan_02')), []);
  assert.ok(c.keyCols.every(k => c.tagsOf(k.name).length));
  // Without a record the columns come from the relations alone, without types.
  const bare = centerColumns(data, 'app.orders', null);
  assert.deepEqual(Array.from(bare.pk), []);
  assert.ok(bare.cols.some(x => x.name === 'customer_id') && bare.cols.every(x => x.type === ''));
  assert.ok(bare.cols.some(x => x.name === 'id'), 'referenced by its dependents');
});
