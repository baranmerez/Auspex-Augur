import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Layout helpers of the Rules tab (src/viewer.html): column sub-groups, counts,
// dates without seconds and the row builder (archive button, plain-text note).
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const blockOf = name => page.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`))?.[0];

function load() {
  for (const name of ['report-filter', 'rules-list']) assert.ok(blockOf(name), `${name} block found`);
  const context = vm.createContext({ JSON });
  vm.runInContext(`${blockOf('report-filter')}\n${blockOf('rules-list')}
this.filterRules = filterRules; this.groupRules = groupRules; this.ruleCounts = ruleCounts; this.ruleDay = ruleDay;`, context);
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
