import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { seedExampleMemory } from './fixtures/exampleMemory.js';

// The Summary view of the table page (table-page block of src/viewer.html):
// grouping and order of the chips, the unused collapse, the disabled trigger
// hook, the report mention match, escaping and the Rules tab links.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const blockOf = name => page.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`))?.[0];
const pageTr = vm.runInNewContext(`(${page.match(/const TR = (\{[\s\S]*?\n\});/)[1]})`);

let home, data, recs;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-table-summary-'));
  let clock = 0;
  seedExampleMemory(path.join(home, 'memory'), 'exampledb', { now: () => new Date(Date.UTC(2026, 9, 1) + (clock++) * 3600000).toISOString() });
  const dir = path.join(home, 'memory', 'exampledb');
  data = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
  recs = Object.fromEntries(data.nodes.filter(n => n.file).map(n => [n.id, JSON.parse(fs.readFileSync(path.join(dir, ...n.file.split('/')), 'utf8'))]));
});
after(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); });

const h = (tag, attrs = {}, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false) });
const textOf = n => (typeof n === 'string' || typeof n === 'number' ? String(n) : n ? n.kids.map(textOf).join('') : '');
const all = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); n.kids.forEach(k => all(k, pred, out)); } return out; };
const byClass = (n, cls) => all(n, x => String(x.attrs.class || '').split(/\s+/).includes(cls));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const html = n => (typeof n === 'string' || typeof n === 'number' ? esc(n) : `<${n.tag}${Object.entries(n.attrs).filter(([, v]) => typeof v !== 'function' && v !== null && v !== undefined && v !== false).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${n.kids.map(html).join('')}</${n.tag}>`);
const plain = v => JSON.parse(JSON.stringify(v));

function load(lang = 'en') {
  assert.ok(blockOf('table-page'), 'table-page block found');
  const context = vm.createContext({
    JSON, h, svg: h, locale: lang === 'tr' ? 'tr-TR' : 'en-GB', fmt: n => String(n), compact: n => `~${n}`,
    ruleDay: ts => (ts ? String(ts).slice(0, 10) : '?'), changeLabel: c => c.change,
  });
  vm.runInContext(`${page.match(/const foldText = .*;/)[0]}
${blockOf('table-page')}
const TR = Object.assign({}, ${JSON.stringify(pageTr)});
for (const [k, v] of Object.entries(tablePageTr)) if (!Object.hasOwn(TR, k)) TR[k] = v;
const t = (en, vars = {}) => String(${JSON.stringify(lang)} === 'tr' && TR[en] !== undefined ? TR[en] : en).replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] ?? '');
Object.assign(this, { tablePageModel, tablePageView, tpFetchSql, tpSqlKey, tpMentions, tpSqlOfDoc, tpSummaryModel, tpViewChoice, tablePageTr, TR });`, context);
  return context;
}
const calls = [];
const viewCtx = (extra = {}) => ({ view: 'summary', unusedOpen: false, reports: { items: [], pending: 0 }, onView: v => calls.push(['view', v]),
  onColumn: n => calls.push(['column', n]), onUnused: v => calls.push(['unused', v]), onReport: id => calls.push(['report', id]), onOpen: id => calls.push(['open', id]),
  onBack() {}, onClose() {}, onCrumb() {}, ...extra });
const model = (ctx, id) => ctx.tablePageModel(data, id, recs[id] ?? null);
const render = (ctx, id, extra, reports) => ctx.tablePageView(model(ctx, id), [id], viewCtx({ ...(reports ? { reports } : {}), ...extra }));
const groupOf = (view, title) => byClass(view, 'sum-group').find(n => n.attrs['aria-label'] === title);
const chipsOf = g => byClass(g, 'sum-chip');

test('groups appear in a fixed order with names only', () => {
  const view = render(load(), 'example.orders');
  assert.deepEqual(byClass(view, 'sum-group').map(n => n.attrs['aria-label']),
    ['Primary key', 'Foreign keys', 'Columns by score', 'Triggers', 'Trigger functions', 'Reports', 'Referenced tables', 'Referencing tables']);
  assert.deepEqual(chipsOf(groupOf(view, 'Primary key')).map(textOf), ['order_id']);
  assert.deepEqual(chipsOf(groupOf(view, 'Foreign keys')).map(textOf), ['customer_id → example.customers']);
  assert.deepEqual(chipsOf(groupOf(view, 'Triggers')).map(textOf), ['orders_check_status', 'orders_log']);
  assert.deepEqual(chipsOf(groupOf(view, 'Trigger functions')).map(textOf), ['example.check_order()', 'example.log_order()']);
  assert.deepEqual(chipsOf(groupOf(view, 'Referenced tables')).map(textOf), ['example.customers']);
  assert.deepEqual(chipsOf(groupOf(view, 'Referencing tables')).map(textOf).sort(), ['example.order_items', 'example.shipments']);
  assert.match(textOf(groupOf(view, 'Reports')), /Mentioned in SQL/);
  assert.match(textOf(groupOf(view, 'Reports')), /No report mentions this table\./);
  assert.equal(byClass(view, 'tp-body').length, 0, 'the detailed layout is not drawn');
});

test('columns follow the effective score, are coloured by it, and unscored ones come last', () => {
  const view = render(load(), 'example.orders');
  const g = groupOf(view, 'Columns by score');
  const chips = chipsOf(g).filter(c => !/unused/.test(c.attrs.class));
  assert.deepEqual(chips.map(textOf), ['created_at', 'order_id', 'status_code', 'customer_id', 'amount', '<script>x</script>', 'teslim_durum_kodu']);
  assert.deepEqual(chips.map(c => c.attrs.class.split(' ')[1]), ['c-s5', 'c-s5', 'c-s5', 'c-s4', 'c-s3', 'c-s0', 'c-s0']);
  assert.ok(chips.every(c => c.tag === 'button'), 'every column chip is a button');
});

test('score 1 columns collapse into a "+N unused" chip that expands', () => {
  const ctx = load();
  const closed = groupOf(render(ctx, 'example.orders'), 'Columns by score');
  assert.ok(!chipsOf(closed).some(c => textOf(c) === 'delivered_at'));
  const toggle = chipsOf(closed).find(c => /c-unused/.test(c.attrs.class));
  assert.equal(textOf(toggle), '+1 unused');
  assert.equal(toggle.tag, 'button');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  calls.length = 0;
  toggle.attrs.onclick();
  assert.deepEqual(calls.at(-1), ['unused', true]);
  const open = groupOf(render(ctx, 'example.orders', { unusedOpen: true }), 'Columns by score');
  assert.deepEqual(chipsOf(open).map(textOf).slice(-2), ['hide 1 unused', 'delivered_at']);
  assert.equal(chipsOf(open).find(c => /c-unused/.test(c.attrs.class)).attrs['aria-expanded'], 'true');
  assert.match(chipsOf(open).at(-1).attrs.class, /c-s1/);
  // A table without unused columns shows no such chip.
  assert.ok(!chipsOf(groupOf(render(ctx, 'example.customers'), 'Columns by score')).some(c => /c-unused/.test(c.attrs.class)));
});

test('a disabled trigger carries the muted hook; the others do not', () => {
  const g = groupOf(render(load(), 'example.orders'), 'Triggers');
  const [on, off] = chipsOf(g);
  assert.doesNotMatch(on.attrs.class, /\boff\b/);
  assert.equal(on.attrs['data-state'], null);
  assert.match(off.attrs.class, /\boff\b/);
  assert.equal(off.attrs['data-state'], 'disabled');
  assert.equal(off.attrs.title, 'disabled');
  // The stylesheet strikes it through with the palette's muted colour.
  assert.match(page, /\.sum-chip\.off \{[^}]*--sum-off[^}]*text-decoration: line-through/);
});

test('chips do what the order says: column opens its row, tables and reports navigate', () => {
  const ctx = load();
  const reports = { items: [{ id: 'approved|exampledb|example|Orders|daily', title: 'Daily orders', sql: 'SELECT order_id FROM example.orders' }], pending: 0 };
  const view = render(ctx, 'example.orders', {}, reports);
  calls.length = 0;
  chipsOf(groupOf(view, 'Columns by score')).find(c => textOf(c) === 'amount').attrs.onclick();
  chipsOf(groupOf(view, 'Primary key'))[0].attrs.onclick();
  chipsOf(groupOf(view, 'Foreign keys'))[0].attrs.onclick();
  chipsOf(groupOf(view, 'Referenced tables'))[0].attrs.onclick();
  chipsOf(groupOf(view, 'Referencing tables'))[0].attrs.onclick();
  const rep = chipsOf(groupOf(view, 'Reports'));
  assert.deepEqual(rep.map(textOf), ['Daily orders']);
  rep[0].attrs.onclick();
  assert.deepEqual(plain(calls.map(c => c[0])), ['column', 'column', 'open', 'open', 'open', 'report']);
  assert.deepEqual([calls[0][1], calls[1][1], calls[2][1], calls[3][1], calls[5][1]], ['amount', 'order_id', 'example.customers', 'example.customers', 'approved|exampledb|example|Orders|daily']);
  // Triggers and trigger functions are names only.
  for (const title of ['Triggers', 'Trigger functions']) assert.ok(chipsOf(groupOf(view, title)).every(c => c.tag === 'span'));
});

test('report mention match: case, qualified and bare names, no longer table name', () => {
  const { tpMentions } = load();
  assert.equal(tpMentions('SELECT * FROM EXAMPLE.Orders o', 'example', 'orders'), true, 'case-insensitive, qualified');
  assert.equal(tpMentions('select order_id from orders where 1=1', 'example', 'orders'), true, 'bare');
  assert.equal(tpMentions('select 1 from "example"."orders"', 'example', 'orders'), true, 'quoted');
  assert.equal(tpMentions('select 1 from example . orders', 'example', 'orders'), true, 'spaces around the dot');
  assert.equal(tpMentions('select 1 from orders_archive', 'example', 'orders'), false, 'bare longer name');
  assert.equal(tpMentions('select 1 from example.orders_archive', 'example', 'orders'), false, 'qualified longer name');
  assert.equal(tpMentions('select 1 from old_orders join example.order_items', 'example', 'orders'), false, 'shared suffix');
  assert.equal(tpMentions('select 1 from test.orders', 'example', 'orders'), false, 'same name in another schema');
  assert.equal(tpMentions('select 1 -- from orders\n from test.invoices /* example.orders */', 'example', 'orders'), false, 'comments are ignored');
  assert.equal(tpMentions('select 1 from example.orders;', 'example', 'orders'), true, 'statement end');
  assert.equal(tpMentions('select 1 from test . orders', 'example', 'orders'), false, 'another schema, spaces around the dot');
  assert.equal(tpMentions('select 1 from test'+String.fromCharCode(10)+'.orders', 'example', 'orders'), false, 'another schema, line break');
  assert.equal(tpMentions(null, 'example', 'orders'), false);
  assert.equal(tpMentions('select 1', 'example', ''), false);
  // Names with regex characters never break the pattern.
  assert.equal(tpMentions('select 1 from example."a.b"', 'example', 'a.b'), true);
  assert.equal(tpMentions('select 1 from example.axb', 'example', 'a.b'), false);
});

test('only reports whose SQL mentions the table are listed, sorted by title; loading ones are counted', () => {
  const ctx = load();
  const reports = { pending: 2, items: [
    { id: 'r3', title: 'Zeta', sql: 'select 1 from example.orders' },
    { id: 'r1', title: 'alpha', sql: 'SELECT 1 FROM Orders' },
    { id: 'r2', title: 'Archive', sql: 'select 1 from example.orders_archive' },
    { id: 'r4', title: 'Loading', sql: null },
  ] };
  const sum = ctx.tpSummaryModel(model(ctx, 'example.orders'), reports);
  assert.deepEqual(plain(sum.reports.map(r => r.id)), ['r1', 'r3']);
  const view = render(ctx, 'example.orders', {}, reports);
  assert.match(textOf(groupOf(view, 'Reports')), /2 still loading/);
});

test('the SQL of a report document: plain SQL, or the active version embedded in the HTML', () => {
  const { tpSqlOfDoc } = load();
  assert.equal(tpSqlOfDoc({ kind: 'sql', content: 'select 1' }), 'select 1');
  const wrap = report => `<html><script id="auspex-report" type="application/json">${JSON.stringify({ report })}</script><td>example.customers in a data cell</td></html>`;
  const v = [{ hash: 'sha256:a', sql: 'select 1 from example.orders' }, { hash: 'sha256:b', sql: 'select 2 from example.customers' }];
  assert.equal(tpSqlOfDoc({ kind: 'html', content: wrap({ sqlVersions: v, activeHash: 'sha256:a' }) }), 'select 1 from example.orders');
  assert.equal(tpSqlOfDoc({ kind: 'html', content: wrap({ sqlVersions: v, activeHash: 'sha256:zz' }) }), 'select 2 from example.customers', 'latest when no hash matches');
  assert.equal(tpSqlOfDoc({ kind: 'html', content: '<html>example.orders</html>' }), null, 'page text is never searched');
  assert.equal(tpSqlOfDoc({ kind: 'html', content: '<script id="auspex-report" type="application/json">{broken</script>' }), null);
  assert.equal(tpSqlOfDoc(null), null);
});

test('every name goes into text nodes, never into markup', () => {
  const ctx = load();
  const evil = '<img src=x onerror=alert(1)>';
  const m = model(ctx, 'example.orders');
  m.keys.outgoing[0].id = `example.${evil}`;
  m.triggers[0].name = evil; m.triggers[0].function = evil;
  m.neighbours.refs[0].id = evil;
  const reports = { items: [{ id: evil, title: evil, sql: 'select 1 from example.orders' }], pending: 0 };
  const view = ctx.tablePageView(m, ['example.orders'], viewCtx({ reports }));
  const out = html(view);
  assert.ok(!out.includes('<img'), 'no element built from a name');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!out.includes('<script>'), 'the <script>x</script> column stays text');
  assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.doesNotMatch(page.match(/\/\/ ----- Summary view[\s\S]*?const tpViewSwitch/)[0], /innerHTML|insertAdjacentHTML/);
});

test('the switch: two buttons with pressed state, Summary first on a first visit, the choice is kept', () => {
  const ctx = load();
  assert.equal(ctx.tpViewChoice(undefined, undefined), 'summary', 'first visit');
  assert.equal(ctx.tpViewChoice(undefined, 'detail'), 'detail', 'remembered');
  assert.equal(ctx.tpViewChoice('summary', 'detail'), 'summary', 'the page choice wins');
  assert.equal(ctx.tpViewChoice(undefined, '<b>'), 'summary', 'garbage in storage');
  const view = render(ctx, 'example.orders');
  const sw = byClass(view, 'tp-switch')[0];
  assert.deepEqual(sw.kids.map(textOf), ['Detailed', 'Summary']);
  assert.deepEqual(sw.kids.map(b => b.attrs['aria-pressed']), ['false', 'true']);
  assert.ok(sw.kids.every(b => b.tag === 'button' && b.attrs.type === 'button'));
  calls.length = 0;
  sw.kids[0].attrs.onclick();
  assert.deepEqual(calls.at(-1), ['view', 'detail']);
  const detail = render(ctx, 'example.orders', { view: 'detail' });
  assert.equal(byClass(detail, 'tp-switch')[0].kids.map(b => b.attrs['aria-pressed']).join(), 'true,false');
  assert.equal(byClass(detail, 'tp-body').length, 1, 'the detailed layout is back');
  // Without a switch handler (older callers) no switch is drawn.
  assert.equal(byClass(ctx.tablePageView(model(ctx, 'example.orders'), ['example.orders'], { onBack() {}, onClose() {}, onCrumb() {} }), 'tp-switch').length, 0);
  // The page remembers the choice in browser storage, tolerating no storage.
  assert.match(page, /perfOpen: state\.perfOpen, tpView: state\.tpView, tpGroup: state\.tpGroup \}\)\); \} catch \{\}/);
});

test('Turkish strings exist for the summary, with the order\'s wording', () => {
  const ctx = load('tr');
  const view = render(ctx, 'example.orders');
  const text = textOf(view);
  for (const s of ['Ayrıntılı', 'Özet', 'SQL\'inde geçiyor', 'Bağlı olduğu', 'Ona bağlı olan', '+1 kullanılmayan', 'Birincil anahtar']) assert.ok(text.includes(s), s);
  assert.doesNotMatch(text, /Mentioned in SQL|Referenced tables|unused\b/);
});

test('layout: chips wrap, groups stack on narrow widths, no horizontal scroll', () => {
  assert.match(page, /\.sum-chips \{[^}]*flex-wrap: wrap/);
  assert.match(page, /\.sum-grid \{[^}]*repeat\(auto-fit, minmax\(min\(100%, 320px\), 1fr\)\)/);
  assert.match(page, /\.sum-chip \{[^}]*max-width: 100%[^}]*overflow-wrap: anywhere/);
  assert.match(page, /button\.sum-chip:focus-visible \{ outline/);
});

test('Rules tab: table and column headers open the table page (column opens the detailed row)', () => {
  const src = page.match(/function ruleGroup\(g\) \{[\s\S]*?\r?\n\}\r?\n/)?.[0];
  assert.ok(src, 'ruleGroup found');
  const opened = [];
  const ctx = vm.createContext({ h, state: { db: 'exampledb' }, t: k => k, ruleCard: n => h('div', { class: 'card' }, `#${n.id}`), ruleCountText: () => '', ruleCounts: () => ({}),
    openTablePage: (db, id, opts) => opened.push([db, id, opts]) });
  vm.runInContext(`${src}\nthis.ruleGroup = ruleGroup;`, ctx);
  const node = ctx.ruleGroup({ key: 'example.orders', notes: [], columns: [{ column: '', notes: [{ id: 1 }] }, { column: 'status_code', notes: [{ id: 2 }] }] });
  const links = all({ tag: 'x', attrs: {}, kids: [node].flat(Infinity) }, n => n.tag === 'button');
  assert.deepEqual(links.map(textOf), ['example.orders', 'status_code']);
  assert.ok(links.every(b => b.attrs.type === 'button' && /\btp-link\b/.test(b.attrs.class)), 'real buttons, keyboard reachable');
  links.forEach(b => b.attrs.onclick());
  assert.deepEqual(plain(opened), [['exampledb', 'example.orders', {}], ['exampledb', 'example.orders', { column: 'status_code' }]]);
  // Database-wide notes have no table to open; the table-level sub-header stays text.
  const wide = ctx.ruleGroup({ key: '', notes: [], columns: [{ column: '', notes: [{ id: 3 }] }] });
  assert.equal(all({ tag: 'x', attrs: {}, kids: [wide].flat(Infinity) }, n => n.tag === 'button').length, 0);
  assert.match(textOf({ tag: 'x', attrs: {}, kids: [wide].flat(Infinity) }), /Database-wide/);
  // The names stay text nodes.
  const evil = ctx.ruleGroup({ key: 'example.<b>x</b>', notes: [], columns: [{ column: '<i>c</i>', notes: [] }] });
  assert.ok(!html({ tag: 'x', attrs: {}, kids: [evil].flat(Infinity) }).includes('<b>'));
});

test('opening a table page with a column opens that row in the detailed view', () => {
  const src = page.match(/function openTablePage\(db, id, opts = \{\}\) \{[\s\S]*?\r?\n\}\r?\n/)?.[0];
  assert.ok(src, 'openTablePage found');
  const state = { db: 'exampledb', tab: 'schema', tablePage: null };
  const ctx = vm.createContext({ state, setDb() {}, switchTab() {}, renderSchema() {}, scrollTo() {} });
  vm.runInContext(`${src}\nthis.openTablePage = openTablePage;`, ctx);
  ctx.openTablePage('exampledb', 'example.orders', { column: 'status_code' });
  assert.deepEqual(plain(state.tablePage), { db: 'exampledb', trail: ['example.orders'], open: 'status_code', showAll: true, view: 'detail', reveal: 'status_code' });
  ctx.openTablePage('exampledb', 'example.customers');
  assert.deepEqual(plain(state.tablePage), { db: 'exampledb', trail: ['example.orders', 'example.customers'], open: null, showAll: false }, 'no forced view: the remembered one applies');
});

const manyFks = (ctx, n) => {
  const m = model(ctx, 'example.orders');
  m.keys.outgoing = Array.from({ length: n }, (_, i) => ({ name: `fk${i}`, columns: [['teslim_durum_kodu', 'amount', 'status_code', 'order_id'][i % 4]], id: `example.t${String(i).padStart(2, '0')}`, refColumns: ['id'] }));
  m.neighbours.refs = Array.from({ length: n }, (_, i) => ({ id: `example.r${i}`, links: [], estRows: null, explored: true }));
  m.neighbours.deps = m.neighbours.refs.map(x => ({ ...x, id: x.id.replace('.r', '.d') }));
  return m;
};
const fkCols = chips => chips.map(c => textOf(c).split(' → ')[0]);

test('columns sit in sub-groups by effective score, each with a heading and a count', () => {
  const view = render(load(), 'example.orders');
  const subs = byClass(groupOf(view, 'Columns by score'), 'sum-sub');
  assert.deepEqual(subs.slice(0, 4).map(s => textOf(s.kids[0])), ['5 · core (3)', '4 · frequent (1)', '3 · topical (1)', 'not scored (2)']);
  assert.deepEqual(byClass(subs[0], 'sum-chip').map(textOf), ['created_at', 'order_id', 'status_code']);
  const tr = textOf(groupOf(render(load('tr'), 'example.orders'), 'Puana göre kolonlar'));
  assert.ok(tr.includes('5 · temel (3)') && tr.includes('4 · sık (1)'), tr);
});

test('foreign keys: best column score first, 12 shown, the rest behind "+N more"', () => {
  const ctx = load();
  const m = manyFks(ctx, 30);
  const draw = more => ctx.tablePageView(m, ['example.orders'], viewCtx({ moreOpen: more, onMore: (k, v) => calls.push(['more', k, v]) }));
  const chips = chipsOf(groupOf(draw({}), 'Foreign keys'));
  assert.equal(chips.length, 13);
  assert.equal(textOf(chips.at(-1)), '+18 more');
  assert.equal(chips.at(-1).attrs['aria-expanded'], 'false');
  // order_id and status_code score 5, amount 3, teslim_durum_kodu is unscored.
  assert.deepEqual(new Set(fkCols(chips.slice(0, 12))), new Set(['order_id', 'status_code']), 'highest scores first');
  calls.length = 0;
  chips.at(-1).attrs.onclick();
  assert.deepEqual(calls.at(-1), ['more', 'fk', true]);
  const open = chipsOf(groupOf(draw({ fk: true }), 'Foreign keys'));
  assert.equal(open.length, 31);
  assert.equal(textOf(open.at(-1)), 'show fewer');
  const rank = { order_id: 5, status_code: 5, amount: 3, teslim_durum_kodu: 0 };
  const seq = fkCols(open.slice(0, -1)).map(c => rank[c]);
  assert.deepEqual(seq, [...seq].sort((a, b) => b - a), 'never ascending');
  assert.deepEqual([seq[0], seq.at(-1)], [5, 0]);
  for (const [title, p] of [['Referenced tables', 'r'], ['Referencing tables', 'd']]) {
    const cs = chipsOf(groupOf(draw({}), title));
    assert.equal(cs.length, 13, title);
    assert.equal(textOf(cs.at(-1)), '+18 more');
    assert.equal(textOf(cs[0]), `example.${p}0`, 'the model order (estimated rows) is kept');
  }
  const tr = load('tr');
  assert.equal(textOf(chipsOf(groupOf(tr.tablePageView(manyFks(tr, 30), ['x'], viewCtx()), 'Yabancı anahtarlar')).at(-1)), '+18 daha');
});

test('layout: foreign keys and columns take full-width rows, the other groups share a grid', () => {
  const view = render(load(), 'example.orders');
  const grid = byClass(view, 'sum-grid')[0];
  const wide = byClass(view, 'sum-group').filter(g => /\bwide\b/.test(g.attrs.class)).map(g => g.attrs['aria-label']);
  assert.deepEqual(wide, ['Primary key', 'Foreign keys', 'Columns by score']);
  assert.deepEqual(byClass(grid, 'sum-group').map(g => g.attrs['aria-label']), ['Triggers', 'Trigger functions', 'Reports', 'Referenced tables', 'Referencing tables']);
  assert.match(page, /\.sum-group\.wide \{ width: 100%/);
});

test('report notes: failed reads with Retry, and the cap', () => {
  const ctx = load();
  const retried = [];
  const view = render(ctx, 'example.orders', { onRetryReports: () => retried.push(1) }, { items: [], pending: 0, failed: 3, capped: 400 });
  const text = textOf(groupOf(view, 'Reports'));
  assert.match(text, /3 could not be read/);
  assert.match(text, /first 400 reports checked/);
  all(groupOf(view, 'Reports'), n => n.tag === 'button' && textOf(n) === 'Retry')[0].attrs.onclick();
  assert.equal(retried.length, 1);
  assert.match(page, /const tpReportCap = 400/);
  assert.match(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /first 400 reports/);
});

test('report SQL loading: a failed read is not cached and is read again; the key changes with updatedAt', async () => {
  const ctx = load();
  const rep = { stage: 'draft', db: 'exampledb', schema: 'example', category: 'Example Reports', name: 'daily', activeHash: 'sha256:a', updatedAt: '2026-10-01T00:00:00Z' };
  const cache = new Map(), failed = new Map();
  let reads = 0, fail = true;
  const fetchDoc = async () => { reads++; if (fail) throw new Error('boom'); return { kind: 'sql', content: 'select 1 from example.orders' }; };
  await ctx.tpFetchSql([rep], fetchDoc, cache, failed);
  assert.deepEqual([cache.size, failed.size, reads], [0, 1, 1], 'failure kept apart, never cached');
  await ctx.tpFetchSql([rep], fetchDoc, cache, failed);
  assert.equal(reads, 1, 'a failed read waits for an explicit retry');
  failed.clear(); fail = false;
  await ctx.tpFetchSql([rep], fetchDoc, cache, failed);
  assert.deepEqual([cache.size, failed.size, reads], [1, 0, 2]);
  assert.equal([...cache.values()][0], 'select 1 from example.orders');
  await ctx.tpFetchSql([rep], fetchDoc, cache, failed);
  assert.equal(reads, 2, 'cached');
  const changed = { ...rep, updatedAt: '2026-10-02T00:00:00Z' };
  assert.notEqual(ctx.tpSqlKey(changed), ctx.tpSqlKey(rep));
  await ctx.tpFetchSql([changed], fetchDoc, cache, failed);
  assert.equal(reads, 3, 'a changed report is read again');
  const none = { ...rep, name: 'other' };
  await ctx.tpFetchSql([none], async () => ({ kind: 'html', content: '<html></html>' }), cache, failed);
  assert.equal(cache.get(ctx.tpSqlKey(none)), '', 'a document without SQL is cached as empty, not as a failure');
  assert.equal(failed.size, 0);
});

test('a column chip tooltip carries the meaning of a confirmed note read from code, never an unconfirmed one', () => {
  const ctx = load();
  const note = (id, kind, column, text) => ({ id, kind, schema: 'example', table: 'orders', column, text, status: 'active', evidenceCode: [{ root: 'example_app', path: 'src/Orders/Order.cs' }] });
  const withCode = { ...data, notes: [...data.notes, note(90, 'observation', 'customer_id', 'Buyer of the order <i>x</i>'), note(91, 'inference', 'amount', 'Appears to be the total')] };
  const view = ctx.tablePageView(ctx.tablePageModel(withCode, 'example.orders', recs['example.orders']), ['example.orders'], viewCtx());
  const chips = chipsOf(groupOf(view, 'Columns by score'));
  assert.match(chips.find(c => textOf(c) === 'customer_id').attrs.title, / · Buyer of the order <i>x<\/i>$/);
  assert.doesNotMatch(chips.find(c => textOf(c) === 'amount').attrs.title, /total/);
  assert.ok(html(chips.find(c => textOf(c) === 'customer_id')).includes('&lt;i&gt;x&lt;/i&gt;'));
});
