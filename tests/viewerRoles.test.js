import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { roleGraph, roleTables } from './fixtures/roleGraph.js';

// Runs the roles block of src/viewer.html (Reference / Dependent ranking used
// by the Graph, ER diagram and Flow views) in isolation over the fixture graph.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ roles:start[\s\S]*?\/\/ roles:end/)?.[0];

function loadRoles() {
  assert.ok(block, 'roles block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nthis.roleGroups = roleGroups; this.roleColor = roleColor; this.flowWidth = flowWidth; this.roleTop = roleTop; this.roleShown = roleShown; this.roleLimitIn = roleLimitIn; this.roleToggled = roleToggled; this.tableOf = tableOf; this.joinLabel = joinLabel; this.joinLabels = joinLabels; this.centerColumns = centerColumns;`, context);
  return context;
}

test('a wide center splits into Reference and Dependent tables from FKs only', () => {
  const { roleGroups } = loadRoles();
  const g = roleGroups(roleGraph(), 'app.st_stok_har');
  assert.equal(g.ref.length, 12);
  assert.equal(g.dep.length, 21);
  assert.equal(g.ref.length + g.dep.length, 33);
  assert.ok(g.ref.every(x => x.role === 'ref') && g.dep.every(x => x.role === 'dep'));
  assert.deepEqual(Array.from(g.ref, x => x.rank), Array.from({ length: 12 }, (_, i) => i + 1));
});

test('ranking: linked rows first, then the table row estimate, then name', () => {
  const { roleGroups } = loadRoles();
  const g = roleGroups(roleGraph(), 'app.st_stok_har');
  // st_stok, st_hareket_tip and sube all link 9.4M rows: the bigger table wins, then the name.
  assert.deepEqual(Array.from(g.ref.slice(0, 3), x => x.id), ['app.st_stok', 'app.st_hareket_tip', 'app.sube']);
  const linked = g.ref.filter(x => x.linkedRows !== null);
  for (let i = 1; i < linked.length; i++) assert.ok(linked[i - 1].linkedRows >= linked[i].linkedRows);
  // Edges without linkedRows come after every edge with it, ordered by the table estimate.
  const tail = g.ref.slice(linked.length);
  assert.ok(tail.every(x => x.linkedRows === null && !x.fromLinks));
  assert.deepEqual(Array.from(tail, x => x.id), ['app.st_parti', 'app.muhasebe_hesap', 'app.st_lokasyon', 'app.kullanici']);
});

test('fallback: weight is linkedRows when known, else estRows or estimatedRows, else null', () => {
  const { roleGroups } = loadRoles();
  const g = roleGroups(roleGraph(), 'app.st_stok_har');
  const byId = new Map([...g.ref, ...g.dep].map(x => [x.id, x]));
  assert.equal(byId.get('app.st_stok').weight, 9_400_000);
  assert.equal(byId.get('app.st_stok').fromLinks, true);
  assert.equal(byId.get('app.st_parti').weight, 88_000, 'estimatedRows of an explored table');
  assert.equal(byId.get('app.st_parti').fromLinks, false);
  assert.equal(byId.get('app.kullanici').weight, null, 'unexplored, no figure at all');
  const estRowsOnly = g.dep.find(x => x.linkedRows === null && x.node.estRows !== undefined);
  assert.ok(estRowsOnly, 'fixture has a dependent known only by estRows');
  assert.equal(estRowsOnly.weight, estRowsOnly.node.estRows);
});

test('self references and non-FK relations take no role; several FKs to one table count once', () => {
  const { roleGroups } = loadRoles();
  const data = roleGraph();
  data.edges.push({ level: 'fk', from: 'app.siparis', to: 'app.cr_cari', columns: ['teslim_cari_id'], refColumns: ['id'], linkedRows: 90_000 });
  const g = roleGroups(data, 'app.siparis');
  assert.deepEqual(Array.from(g.ref, x => x.id), ['app.siparis_durum', 'app.cr_cari', 'app.doviz']);
  assert.deepEqual(Array.from(g.dep, x => x.id), ['app.siparis_satir', 'app.siparis_hizmetler', 'app.siparis_not']);
  const cari = g.ref.find(x => x.id === 'app.cr_cari');
  assert.equal(cari.links.length, 2);
  assert.equal(cari.linkedRows, 1_240_000, 'the larger figure, not a sum');
  assert.ok(!g.ref.some(x => x.id === 'app.proje'), 'suggested relation is not a role');
  assert.ok(!g.ref.some(x => x.id === 'app.siparis'), 'self reference is not a role');
});

test('depth 2: a dependent has dependents of its own', () => {
  const { roleGroups } = loadRoles();
  const g = roleGroups(roleGraph(), 'app.siparis_satir');
  assert.deepEqual(Array.from(g.dep, x => x.id), ['app.siparis_satir_teslim', 'app.siparis_satir_iskonto']);
  assert.deepEqual(Array.from(g.ref, x => x.id).sort(), ['app.siparis', 'app.st_stok']);
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

test('top 5 / top 10 toggles are independent per view and side', () => {
  const { roleLimitIn, roleToggled, roleTop, roleShown } = loadRoles();
  const sides = [['er', 'ref'], ['er', 'dep'], ['flow', 'ref'], ['flow', 'dep'], ['flow', 'dep2']];
  for (const [view, side] of sides) {
    const open = roleToggled(undefined, view, side);
    for (const [v, s] of sides) {
      const want = v === view && s === side ? roleTop : roleShown;
      assert.equal(roleLimitIn(open, v, s), want, `${view}.${side} toggled: ${v}.${s}`);
    }
    // Toggling the same side again closes it; every other side stays as it was.
    assert.equal(roleLimitIn(roleToggled(open, view, side), view, side), roleShown);
  }
  // Several sides open together keep their own state through further toggles.
  let s = roleToggled(roleToggled(undefined, 'er', 'ref'), 'er', 'dep');
  s = roleToggled(s, 'er', 'ref');
  assert.equal(roleLimitIn(s, 'er', 'ref'), roleShown);
  assert.equal(roleLimitIn(s, 'er', 'dep'), roleTop);
  assert.equal(roleLimitIn(s, 'flow', 'dep'), roleShown, 'the ER toggle does not open the Flow lane');
  // The input object is never mutated (state is replaced, not shared).
  const frozen = Object.freeze({ 'flow.dep': true });
  assert.equal(roleLimitIn(roleToggled(frozen, 'flow', 'ref'), 'flow', 'dep'), roleTop);
  // Old persisted shapes ({ ref: true }, true) open nothing.
  assert.equal(roleLimitIn({ ref: true, dep: true }, 'er', 'ref'), roleShown);
  assert.equal(roleLimitIn(true, 'er', 'ref'), roleShown);
  assert.equal(roleLimitIn(roleToggled(true, 'er', 'dep'), 'er', 'dep'), roleTop);
});

test('join labels name the referencing column, then the referenced table and column', () => {
  const { roleGroups, joinLabel, joinLabels, tableOf } = loadRoles();
  assert.equal(tableOf('app.siparis'), 'siparis');
  assert.equal(tableOf('siparis'), 'siparis');
  const g = roleGroups(roleGraph(), 'app.siparis');
  const satir = g.dep.find(x => x.id === 'app.siparis_satir');
  assert.deepEqual(Array.from(joinLabels(satir, 'app.siparis')), ['siparis_id → siparis.id']);
  const cari = g.ref.find(x => x.id === 'app.cr_cari');
  assert.deepEqual(Array.from(joinLabels(cari, 'app.siparis')), ['cari_id → cr_cari.id']);
  // The brief's examples and a composite key.
  assert.equal(joinLabel('dep', { centerCols: ['siparisid'], nbCols: ['siparisid'] }, 'app.siparis', 'app.siparis_detay'), 'siparisid → siparis.siparisid');
  assert.equal(joinLabel('ref', { centerCols: ['customer_code'], nbCols: ['account_code'] }, 'app.siparis', 'app.customer_accounts'), 'customer_code → customer_accounts.account_code');
  assert.equal(joinLabel('ref', { centerCols: ['a', 'b'], nbCols: ['x', 'y'] }, 'app.c', 'app.n'), '(a, b) → n.(x, y)');
  assert.equal(joinLabel('dep', { centerCols: [], nbCols: [] }, 'app.c', 'app.n'), '? → c.?');
});

test('depth 2: join labels point at the opened dependent, not the center', () => {
  const { roleGroups, joinLabels } = loadRoles();
  const g = roleGroups(roleGraph(), 'app.siparis_satir');
  const teslim = g.dep.find(x => x.id === 'app.siparis_satir_teslim');
  assert.deepEqual(Array.from(joinLabels(teslim, 'app.siparis_satir')), ['siparis_satir_id → siparis_satir.id']);
});

test('center columns: PK, FK, referenced, used and noted columns are tagged', () => {
  const { centerColumns } = loadRoles();
  const data = roleGraph();
  data.notes.push({ id: 1, kind: 'rule', status: 'active', schema: 'app', table: 'siparis', column: 'alan_01', text: 'x' },
    { id: 2, kind: 'rule', status: 'archived', schema: 'app', table: 'siparis', column: 'alan_02', text: 'y' });
  const rec = roleTables(data).find(x => x.table === 'siparis');
  rec.usedColumns = { alan_03: { count: 2 } };
  const c = centerColumns(data, 'app.siparis', rec);
  assert.deepEqual(Array.from(c.pk), ['id']);
  assert.equal(c.cols.length, rec.columns.length);
  assert.equal(c.notes.length, 1, 'active notes only');
  assert.deepEqual(Array.from(c.tagsOf('id')), ['PK']);
  assert.deepEqual(Array.from(c.tagsOf('cari_id')), ['FK']);
  assert.deepEqual(Array.from(c.tagsOf('ana_siparis_id')), ['FK'], 'self reference');
  assert.deepEqual(Array.from(c.tagsOf('alan_03')), ['U']);
  assert.deepEqual(Array.from(c.tagsOf('alan_01')), ['N']);
  assert.deepEqual(Array.from(c.tagsOf('alan_02')), []);
  assert.ok(c.keyCols.every(k => c.tagsOf(k.name).length));
  // Without a record the columns come from the relations alone, without types.
  const bare = centerColumns(data, 'app.siparis', null);
  assert.deepEqual(Array.from(bare.pk), []);
  assert.ok(bare.cols.some(x => x.name === 'cari_id') && bare.cols.every(x => x.type === ''));
  assert.ok(bare.cols.some(x => x.name === 'id'), 'referenced by its dependents');
});
