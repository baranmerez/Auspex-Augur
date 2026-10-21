import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Layout helpers of the Rules tab (src/viewer.html): column sub-groups, counts,
// dates without seconds and the row builder (archive button, plain-text note).
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const tableKeyLines = page.match(/^const tableKey = .*\r?\n^const splitTableKey = .*$/m)[0];
const blockOf = name => page.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`))?.[0];

function load() {
  for (const name of ['report-filter', 'rules-list']) assert.ok(blockOf(name), `${name} block found`);
  const context = vm.createContext({ JSON });
  vm.runInContext(`${tableKeyLines}\n${blockOf('report-filter')}\n${blockOf('rules-list')}
this.filterRules = filterRules; this.groupRules = groupRules; this.ruleCounts = ruleCounts; this.ruleDay = ruleDay; this.pickRulesSel = pickRulesSel; this.groupRuleTables = groupRuleTables;`, context);
  return context;
}

const notes = [
  { id: 1, kind: 'rule', schema: 'example', table: 'orders', column: 'status_code', text: 'First on the column.', status: 'active' },
  { id: 2, kind: 'observation', schema: 'example', table: 'orders', column: 'delivered_at', text: 'Filled after delivery.', status: 'active' },
  { id: 3, kind: 'rule', schema: 'example', table: 'orders', column: null, text: 'Table-level rule.', status: 'active' },
  { id: 4, kind: 'rule', schema: 'example', table: 'orders', column: 'status_code', text: 'Second on the column.', status: 'active' },
  { id: 5, kind: 'inference', schema: null, table: null, column: null, text: 'Database-wide guess.', status: 'active' },
  { id: 6, kind: 'rule', schema: 'example', table: 'orders', column: 'status_code', text: 'Old.', status: 'archived' },
];

test('groups split by column, table-level notes first', () => {
  const { filterRules, groupRules } = load();
  const groups = groupRules(filterRules(notes, { status: 'all' }));
  const orders = groups.find(g => g.key === 'example.orders');
  assert.deepEqual(JSON.parse(JSON.stringify(orders.columns.map(c => [c.column, c.notes.map(n => n.id)]))),
    [['', [3]], ['delivered_at', [2]], ['status_code', [1, 4, 6]]]);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0].columns.map(c => [c.column, c.notes.map(n => n.id)]))), [['', [5]]]);
});

test('counts: active by kind, archived apart', () => {
  assert.deepEqual({ ...load().ruleCounts(notes) }, { rule: 3, observation: 1, inference: 1, archived: 1 });
  assert.deepEqual({ ...load().ruleCounts(null) }, { rule: 0, observation: 0, inference: 0, archived: 0 });
});

test('dates show the day without seconds, in English and Turkish', () => {
  const { ruleDay } = load();
  const ts = '2026-10-13T12:34:56';
  assert.equal(ruleDay(ts, 'en-GB'), '13 Oct 2026');
  assert.equal(ruleDay(ts, 'tr-TR'), '13 Eki 2026');
  assert.doesNotMatch(ruleDay(ts, 'en-GB'), /:/);
  assert.equal(ruleDay(null, 'en-GB'), '?');
  assert.equal(ruleDay('nope', 'en-GB'), '?');
});

test('rows: archive button only on active notes, note text and reason stay plain text', () => {
  const src = page.match(/function ruleCard\(n\) \{[\s\S]*?\r?\n\}\r?\n/)?.[0];
  assert.ok(src, 'ruleCard found');
  assert.doesNotMatch(src, /innerHTML/);
  const h = (tag, attrs = {}, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false) });
  const ctx = vm.createContext({
    h, svg: h, state: {}, locale: 'en-GB', fmt: String, confirmArchiveNote() {},
    t: (k, v = {}) => k.replace(/\{(\w+)\}/g, (_, x) => v[x]), ruleDay: ts => (ts ? 'D' : '?'),
  });
  vm.runInContext(`${src}\nthis.ruleCard = ruleCard;`, ctx);
  const all = node => (typeof node === 'string' ? [node] : [node, ...node.kids.flatMap(all)]);
  const buttons = node => all(node).filter(x => x.tag === 'button');
  const active = ctx.ruleCard({ id: 1, kind: 'rule', text: '<b>x</b>', status: 'active', createdAt: 't' });
  assert.equal(buttons(active).length, 1);
  assert.equal(buttons(active)[0].attrs['aria-label'], 'Archive');
  assert.equal(buttons(active)[0].attrs.title, 'Archive');
  assert.ok(all(active).includes('<b>x</b>'), 'note text is a plain string child');
  const gone = ctx.ruleCard({ id: 2, kind: 'rule', text: 'old', status: 'archived', archivedReason: '<i>why</i>', createdAt: 't', archivedAt: 't' });
  assert.equal(buttons(gone).length, 0);
  assert.ok(all(gone).includes('Archived: <i>why</i>'));
  assert.match(gone.attrs.class, /archived/);
});

test('a note read from code shows a "from code" badge next to its kind and its references as plain text in the evidence', () => {
  const src = page.match(/function ruleCard\(n\) \{[\s\S]*?\r?\n\}\r?\n/)?.[0];
  const refFn = page.match(/function codeRefText\(r\) \{[\s\S]*?\r?\n\}\r?\n/)?.[0];
  assert.ok(src && refFn, 'ruleCard and codeRefText found');
  const h = (tag, attrs = {}, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false) });
  const ctx = vm.createContext({
    h, svg: h, state: {}, locale: 'en-GB', fmt: String, confirmArchiveNote() {},
    t: (k, v = {}) => k.replace(/\{(\w+)\}/g, (_, x) => v[x]), ruleDay: ts => (ts ? 'D' : '?'),
  });
  vm.runInContext(`${refFn}\n${src}\nthis.ruleCard = ruleCard;`, ctx);
  const all = node => (typeof node === 'string' ? [node] : [node, ...node.kids.flatMap(all)]);
  const cls = (node, c) => all(node).filter(x => typeof x !== 'string' && String(x.attrs.class || '').split(' ').includes(c));
  const row = ctx.ruleCard({ id: 7, kind: 'inference', text: 'Appears to be the total.', status: 'active', createdAt: 't',
    evidenceCode: [{ root: 'example_app', path: 'src/Orders/Order.cs', line: 42, symbol: '<b>Order.Amount</b>' }, { root: 'example_app', path: 'src/Orders/Order.cs' }] });
  const badges = cls(row, 'rl-badges')[0];
  assert.deepEqual(badges.kids.map(b => [b.attrs.class, b.kids[0]]), [['badge inference', 'inference'], ['badge code', 'from code']]);
  const refs = cls(row, 'code-refs')[0];
  assert.deepEqual(refs.kids.map(li => li.kids), [['example_app:src/Orders/Order.cs:42 · <b>Order.Amount</b>'], ['example_app:src/Orders/Order.cs']]);
  assert.ok(!all(row).some(x => typeof x !== 'string' && x.tag === 'a'), 'no links');
  const plain = ctx.ruleCard({ id: 8, kind: 'rule', text: 'x', status: 'active', createdAt: 't' });
  assert.equal(cls(plain, 'code').length, 0);
  assert.equal(cls(plain, 'rl-badges').length, 0);
  for (const key of ['from code', 'Code references']) assert.ok(page.includes(`'${key}': '`), `Turkish text for ${key}`);
});

test('Turkish texts exist for the new labels', () => {
  for (const key of ['(table)', 'Observations', '{n} rules', '{n} observations', '{n} archived']) {
    assert.ok(page.includes(`'${key}': '`), `Turkish text for ${key}`);
  }
});

test('evidence styles also apply to the dense rows, and long SQL stays inside its box', () => {
  assert.match(page, /\.note \.fig, \.rl-row \.fig \{/);
  const pre = page.match(/\.note pre, \.rl-row pre \{[^}]*\}/)?.[0];
  assert.ok(pre, 'pre rule covers .rl-row');
  assert.match(pre, /var\(--mono\)/);
  assert.match(pre, /pre-wrap/);
  assert.match(pre, /max-width: 100%/);
});

test('the pending archive button spins and the dialog confirm button is the only red one', () => {
  assert.match(page, /class: 'icon-btn sm' \+ \(pending \? ' spin' : ''\)/);
  assert.match(page, /'icon-btn secondary-danger', value: 'ok', disabled: true \}, t\('Archive'\)/);
});

test('rules navigator: table list left in schema and prefix groups, a divider, the chosen notes right', () => {
  assert.match(page, /\.rules-nav \{ display: grid; grid-template-columns: var\(--rn-w, 320px\) 14px minmax\(0, 1fr\);/);
  assert.match(page, /@media \(max-width: 900px\) \{\s*\.rules-nav, \.rules-nav\.collapsed \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(page, /\.rn-row \.rn-name \{[^}]*text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(page, /row\(dbWide, true\)/);
  assert.match(page, /groupRuleTables\(tables\)\.map/);
  assert.match(page, /gs\.length === 1 \? gs\[0\]\.tables\.map\(g => row\(g, false\)\) : gs\.map\(grp => prefixGroup\(schema, grp\)\)/);
  // Open groups, the folded list and the list width are remembered per viewer.
  assert.match(page, /rulesOpen: state\.rulesOpen, rulesListCollapsed: state\.rulesListCollapsed, rulesSideW: state\.rulesSideW,/);
  assert.match(page, /const open = filtering \|\| \(state\.rulesOpen\?\.\[k\] \?\? hasSel\);/);
  assert.match(page, /'Other tables': 'Diğer tablolar'/);
  // A table named just like its prefix keeps its name instead of an empty row.
  assert.match(page, /const shortName = \(table, prefix\) => \(prefix && table\.startsWith\(prefix \+ '_'\) \? table\.slice\(prefix\.length \+ 1\) : table\);/);
  // The divider is a keyboard-usable separator with clamped width.
  assert.match(page, /class: 'rn-split', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical'/);
  assert.match(page, /const rulesSideMin = 220, rulesSideMax = 560, rulesSideDefault = 320;/);
  // The folded list is a rail like the Reports tab's.
  assert.match(page, /class: 'rules-nav collapsed' \},\s*h\('div', \{ class: 'panel rep-rail' \}/);
  // The chosen row, open groups and the fold are part of the render key; without them a click would not redraw.
  assert.match(page, /const key = JSON\.stringify\(\[[^\]]*state\.rulesSel \?\? null, state\.rulesOpen \?\? null, !!state\.rulesListCollapsed\]\)/);
  assert.match(page, /'No notes': 'Not yok'/);
});

test('operations and tables tabs: name and SQL cells are plain table cells, cut inside, not the .sum grid', () => {
  assert.doesNotMatch(page, /h\('td', \{ class: 'sum'/);
  assert.match(page, /h\('td', \{ class: 'op-sql', title: summaryOf\(e\) \}, h\('span', \{ class: 'op-sql-text' \}/);
  assert.match(page, /td\.op-sql \.op-sql-text \{[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(page, /td\.op-sql \{[^}]*display:/);
});

test('navigator selection: the pick while it has notes, else database-wide with notes, else the first table', () => {
  const { pickRulesSel } = load();
  const tables = ['example.orders', 'example.customers'];
  assert.equal(pickRulesSel(null, 2, tables), '', 'first visit: database-wide when it has notes');
  assert.equal(pickRulesSel(null, 0, tables), 'example.orders', 'first visit without database-wide notes: the first table');
  assert.equal(pickRulesSel('example.customers', 2, tables), 'example.customers', 'a valid pick stays');
  assert.equal(pickRulesSel('example.gone', 2, tables), '', 'a vanished table falls back');
  assert.equal(pickRulesSel('', 0, tables), 'example.orders', 'an empty database-wide pick falls back to a table with notes');
  assert.equal(pickRulesSel('', 0, []), '', 'nothing at all: the database-wide box');
  assert.equal(pickRulesSel('example.orders', 0, []), '', 'no tables left: the database-wide box');
});

test('navigator redraw keeps the list scroll and a focused row; a database switch forgets the pick', () => {
  assert.ok(page.includes("'data-rn-key': g.key"));
  assert.ok(page.includes('tree.scrollTop = treeScroll;'));
  assert.ok(page.includes('.focus({ preventScroll: true })'));
  assert.match(page, /state\.db = db;[\s\S]{0,120}state\.rulesSel = null; state\.rulesJump = false;/);
  assert.ok(page.includes('if (state.rulesKey === key && view.firstChild) { state.rulesJump = false; return; }'));
});

test('navigator groups: per schema, then by a name prefix shared by two or more tables, the rest last', () => {
  const { groupRuleTables } = load();
  const box = key => { const [schema, table] = key.split('.'); return { key, schema, table, notes: [] }; };
  const keys = ['example.order_events', 'example.order_items', 'example.orders', 'example.customers', 'example.shipments',
    'example.shipment_items', 'example.shipment_events', 'example.status_codes', 'example.invoices', 'example.payments', 'test.invoices'];
  const out = JSON.parse(JSON.stringify(groupRuleTables(keys.map(box))));
  assert.deepEqual(out.map(s => [s.schema, s.count]), [['example', 10], ['test', 1]]);
  assert.deepEqual(out[0].groups.map(g => [g.prefix, g.tables.map(x => x.table)]), [
    ['order', ['order_events', 'order_items']],
    ['shipment', ['shipment_items', 'shipment_events']],
    [null, ['orders', 'customers', 'shipments', 'status_codes', 'invoices', 'payments']],
  ]);
  assert.deepEqual(out[1].groups.map(g => g.prefix), [null], 'a small schema stays one group');
  assert.equal(groupRuleTables(keys.slice(0, 9).map(box))[0].groups.length, 1, 'fewer than ten tables: no prefix groups');
});
