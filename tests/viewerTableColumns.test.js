import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { seedExampleMemory } from './fixtures/exampleMemory.js';

// The column tools of the table page (table-page block of src/viewer.html):
// the inline meaning, the column search, the Type grouping and its storage.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const tableKeyLines = page.match(/^const tableKey = .*\r?\n^const splitTableKey = .*$/m)[0];
const blockOf = name => page.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`))?.[0];
const pageTr = vm.runInNewContext(`(${page.match(/const TR = (\{[\s\S]*?\n\});/)[1]})`);

let home, data, recs;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-table-columns-'));
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

function load(lang = 'en') {
  const context = vm.createContext({
    JSON, h, svg: h, locale: lang === 'tr' ? 'tr-TR' : 'en-GB', fmt: n => String(n), compact: n => `~${n}`,
    ruleDay: ts => (ts ? String(ts).slice(0, 10) : '?'), changeLabel: c => c.change,
  });
  vm.runInContext(`${tableKeyLines}\n${page.match(/const foldText = .*;/)[0]}
${blockOf('table-page')}
const TR = Object.assign({}, ${JSON.stringify(pageTr)});
for (const [k, v] of Object.entries(tablePageTr)) if (!Object.hasOwn(TR, k)) TR[k] = v;
const t = (en, vars = {}) => String(${JSON.stringify(lang)} === 'tr' && TR[en] !== undefined ? TR[en] : en).replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] ?? '');
Object.assign(this, { tablePageModel, tablePageView, tpMeaning, tpColumnMatches, tpQueryWords, tpShownColumns, tpTypeGroup, tpGroupColumns, tpGroupChoice, TR });`, context);
  return context;
}
const calls = [];
const viewCtx = (extra = {}) => ({ view: 'detail', showAll: false, reports: { items: [], pending: 0 }, onView() {}, onToggle() {}, onShowAll: v => calls.push(['showAll', v]),
  onQuery: q => calls.push(['query', q]), onGroup: g => calls.push(['group', g]), onColumn() {}, onUnused() {}, onReport() {}, onOpen() {}, onBack() {}, onClose() {}, onCrumb() {}, ...extra });
const note = (id, kind, column, text, extra = {}) => ({ id, kind, schema: 'example', table: 'orders', column, text, status: 'active', ...extra });
const code = [{ root: 'example_app', path: 'src/Orders/Order.cs' }];
const withNotes = notes => ({ ...data, notes: [...data.notes, ...notes] });
const build = (ctx, d = data, rec = recs['example.orders']) => ctx.tablePageModel(d, 'example.orders', rec);
const render = (ctx, extra, d = data, rec) => ctx.tablePageView(build(ctx, d, rec), ['example.orders'], viewCtx(extra));
const plain = v => JSON.parse(JSON.stringify(v));
const rowNames = view => byClass(view, 'tp-cname').map(textOf);
const chipNames = view => byClass(view, 'sum-group').find(g => g.attrs['aria-label'].startsWith('Columns by')).kids.flatMap(function walk(k) { return k && typeof k === 'object' ? [k, ...k.kids.flatMap(walk)] : []; }).filter(n => String(n.attrs.class || '').split(/\s+/).includes('sum-chip')).map(textOf);

test('inline meaning: confirmed code evidence beats a newer confirmed rule; an unconfirmed inference is never shown', () => {
  const ctx = load();
  const col = name => build(ctx, withNotes([
    note(90, 'rule', 'customer_id', 'Newer rule', { confirmedAt: '2026-10-05T00:00:00Z' }),
    note(91, 'observation', 'customer_id', 'Buyer of the order', { confirmedAt: '2026-10-01T00:00:00Z', evidenceCode: code }),
    note(92, 'inference', 'customer_id', 'Looks like a buyer', { evidenceCode: code }),
    note(93, 'inference', 'amount', 'Seems to be the total'),
    note(94, 'rule', 'created_at', 'Older rule', { confirmedAt: '2026-10-01T00:00:00Z' }),
    note(95, 'rule', 'created_at', 'Newest rule', { confirmedAt: '2026-10-03T00:00:00Z' }),
  ])).columns.find(c => c.name === name);
  assert.equal(ctx.tpMeaning(col('customer_id')), 'Buyer of the order');
  assert.equal(ctx.tpMeaning(col('amount')), null, 'inference only: nothing inline');
  assert.equal(ctx.tpMeaning(col('created_at')), 'Newest rule');
  assert.equal(ctx.tpMeaning(col('order_id')), null);
  const view = render(ctx, { showAll: true }, withNotes([note(91, 'observation', 'customer_id', 'Buyer of the order', { evidenceCode: code }), note(93, 'inference', 'amount', 'Seems to be the total')]));
  const lines = byClass(view, 'tp-meaning');
  assert.ok(lines.some(l => textOf(l) === 'Buyer of the order' && l.attrs.title === 'Buyer of the order'), 'full text in the tooltip');
  assert.ok(!lines.some(l => /total/.test(textOf(l))), 'the inference stays in the expanded row only');
  assert.match(page, /\.tp-meaning \{[^}]*-webkit-line-clamp: 2/, 'two lines with an ellipsis');
  assert.match(page.match(/\.tp-meaning \{[^}]*\}/)[0], /overflow: hidden/);
});

test('inline meaning and search text go through text nodes', () => {
  const ctx = load();
  const evil = '<img src=x onerror=alert(1)> "q"';
  const view = render(ctx, { query: 'img', showAll: false }, withNotes([note(90, 'rule', 'amount', evil)]));
  const out = html(view);
  assert.ok(!out.includes('<img'), 'no markup from a note');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.deepEqual(rowNames(view), ['amount']);
  const q = html(render(ctx, { query: '<script>x</script>' }));
  assert.ok(!q.includes('<script>x'), 'the typed query is an attribute value, escaped');
  const block = blockOf('table-page');
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML/);
});

test('search: Turkish casing, name, meaning, reason and note text, all words, counter', () => {
  const ctx = load();
  const d = withNotes([
    note(90, 'rule', 'teslim_durum_kodu', 'İŞLEM durumu ŞEKİL', { confirmedAt: '2026-10-01T00:00:00Z' }),
    note(91, 'inference', 'amount', 'Toplam TUTAR (unconfirmed)'),
  ]);
  const names = (q, extra) => rowNames(render(ctx, { query: q, ...extra }, d));
  assert.deepEqual(names('ORDER_ID'), ['order_id'], 'case-insensitive name match');
  assert.deepEqual(names('islem sekil'), ['teslim_durum_kodu'], 'diacritic-insensitive: islem matches işlem');
  assert.deepEqual(names('işlem şekil'), ['teslim_durum_kodu'], 'meaning with İ/ı and Ş/ş');
  assert.deepEqual(names('İŞLEM ŞEKİL'), ['teslim_durum_kodu']);
  assert.deepEqual(names('ışlem'), ['teslim_durum_kodu'], 'dotless ı matches i, as on the Rules tab');
  assert.deepEqual(names('tutar'), ['amount'], 'any note text, even an unconfirmed one');
  assert.deepEqual(names('revenue reports'), ['amount'], 'the agent reason');
  assert.deepEqual(names('mostly where'), ['status_code'], 'a rule note text');
  assert.deepEqual(names('zzz'), []);
  assert.ok(ctx.tpColumnMatches({ name: 'x', notes: [] }, []), 'an empty query matches everything');
  const view = render(ctx, { query: 'created' }, d);
  assert.equal(textOf(byClass(view, 'tp-q-count')[0]), '1 / 8');
  const clear = byClass(view, 'tp-q-clear')[0];
  assert.equal(clear.attrs['aria-label'], 'Clear search');
  calls.length = 0; clear.attrs.onclick();
  assert.deepEqual(calls.at(-1), ['query', '']);
  assert.equal(byClass(render(ctx, { query: '' }), 'tp-q-clear').length, 0, 'no clear button without a query');
  assert.equal(textOf(byClass(render(ctx, { query: '' }), 'tp-q-count')[0]), '');
  const none = render(ctx, { query: 'zzz' }, d);
  assert.equal(textOf(byClass(none, 'tp-q-count')[0]), '0 / 8');
  assert.match(textOf(none), /No column matches the search/);
});

test('search ignores the 4-5 filter and says so; without a query the filter applies again', () => {
  const ctx = load();
  const filtered = render(ctx, { showAll: false });
  assert.ok(rowNames(filtered).length < 8, 'default filter hides low scores');
  const searching = render(ctx, { showAll: false, query: 'delivered' });
  assert.deepEqual(rowNames(searching), ['delivered_at'], 'delivered_at is score 1 and still found');
  assert.match(textOf(searching), /Searching all columns; the 4–5 filter is ignored\./);
  assert.equal(byClass(searching, 'icon-btn').filter(b => /Only 4–5|Show all columns/.test(textOf(b))).length, 0, 'filter button hidden while searching');
  const model = build(ctx);
  assert.equal(ctx.tpShownColumns(model, false, '').searching, false);
  assert.equal(ctx.tpShownColumns(model, false, ' ').searching, false, 'blank query is no query');
  assert.equal(ctx.tpShownColumns(model, false, 'a').list.length > 0, true);
  // The search input is labelled, with a status counter.
  const input = all(render(ctx, {}), n => n.attrs.id === 'tpSearch')[0];
  assert.equal(input.attrs['aria-label'], 'Search columns');
  assert.equal(input.attrs['aria-keyshortcuts'], '/');
});

test('search box key handling: Escape clears a query, typing calls onQuery', () => {
  const ctx = load();
  const input = all(render(ctx, { query: 'abc' }), n => n.attrs.id === 'tpSearch')[0];
  calls.length = 0;
  let stopped = false, prevented = false;
  input.attrs.onkeydown({ key: 'Escape', target: { value: 'abc' }, stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
  assert.deepEqual(calls.at(-1), ['query', '']);
  assert.ok(stopped && prevented);
  calls.length = 0;
  input.attrs.onkeydown({ key: 'Escape', target: { value: '' }, stopPropagation() { stopped = 'again'; }, preventDefault() {} });
  assert.deepEqual(calls, [], 'an empty box lets Escape through to the page');
  input.attrs.oninput({ target: { value: 'xyz' } });
  assert.deepEqual(calls.at(-1), ['query', 'xyz']);
  assert.match(page, /ev\.key === '\/' && !typing\) \{ ev\.preventDefault\(\); \(slashTarget\(state\.tab, \$\) \|\| F\.text\)\.focus\(\)/, '/ focuses the column search of the open page (per tab), else the list search');
});

test('Type groups: PK, FK and unique go to keys even when numeric; the other types by catalog type', () => {
  const ctx = load();
  const g = (type, extra = {}) => ctx.tpTypeGroup({ type, ...extra });
  assert.equal(g('bigint', { pk: true }), 'keys');
  assert.equal(g('integer', { fk: { id: 'example.customers' } }), 'keys');
  assert.equal(g('numeric(12,2)', { unique: true }), 'keys');
  assert.equal(g('text', { unique: true }), 'keys');
  for (const ty of ['date', 'time without time zone', 'timestamp with time zone', 'timestamp(3) without time zone', 'timestamptz', 'interval']) assert.equal(g(ty), 'dates', ty);
  for (const ty of ['integer', 'bigint', 'smallint', 'numeric(12,2)', 'decimal', 'real', 'double precision', 'money', 'int4', 'serial']) assert.equal(g(ty), 'numbers', ty);
  for (const ty of ['text', 'character varying(20)', 'character(3)', 'varchar', 'citext']) assert.equal(g(ty), 'text', ty);
  assert.equal(g('boolean'), 'flags');
  for (const ty of ['jsonb', 'json', 'uuid', 'bytea', 'integer[]', 'text[]', '_int4', null, '']) assert.equal(g(ty), 'other', String(ty));

  const rec = JSON.parse(JSON.stringify(recs['example.orders']));
  rec.columns.push({ name: 'is_open', type: 'boolean' }, { name: 'payload', type: 'jsonb' }, { name: 'ref_no', type: 'integer' }, { name: 'note_text', type: 'character varying(40)' });
  rec.constraints.push({ name: 'orders_ref_no_key', type: 'unique', definition: 'UNIQUE (ref_no)', columns: ['ref_no'] });
  const model = build(ctx, data, rec);
  const groups = ctx.tpGroupColumns(model.columns);
  assert.deepEqual(plain(groups.map(x => x.key)), ['keys', 'dates', 'numbers', 'text', 'flags', 'other']);
  const of = key => plain(groups.find(x => x.key === key).columns.map(c => c.name));
  assert.deepEqual(of('keys'), ['order_id', 'customer_id', 'ref_no'], 'score 5 PK (6 sources), FK 4, unscored single-column unique; a composite unique member is not a key');
  assert.deepEqual(of('dates'), ['created_at', 'delivered_at'], 'score 5 before score 1');
  assert.deepEqual(of('numbers'), ['amount']);
  assert.deepEqual(of('text').sort(), ['<script>x</script>', 'note_text', 'status_code', 'teslim_durum_kodu'], 'unscored text columns, ordered by name');
  assert.deepEqual(of('flags'), ['is_open']);
  assert.deepEqual(of('other'), ['payload']);
  // sources break a score tie, then the name
  const tie = ctx.tpGroupColumns([{ name: 'b', score: 3, sources: 1, type: 'text' }, { name: 'a', score: 3, sources: 1, type: 'text' }, { name: 'c', score: 3, sources: 4, type: 'text' }, { name: 'd', score: 5, sources: 0, type: 'text' }]);
  assert.deepEqual(plain(tie[0].columns.map(c => c.name)), ['d', 'c', 'a', 'b']);
});

test('Type grouping renders headers with counts in Detailed and in Summary; Score stays the default', () => {
  const ctx = load();
  const detail = render(ctx, { group: 'type', showAll: true });
  const heads = byClass(detail, 'tp-group-h').map(textOf);
  assert.deepEqual(heads, ['Keys and links (2)', 'Date and time (2)', 'Amounts and numbers (1)', 'Text (3)']);
  assert.equal(rowNames(detail).length, 8);
  const ids = all(detail, n => typeof n.attrs.id === 'string' && n.attrs.id.startsWith('tp-col-')).map(n => n.attrs.id);
  assert.equal(new Set(ids).size, ids.length || 0);
  const score = render(ctx, { showAll: true });
  assert.equal(byClass(score, 'tp-group-h').length, 0, 'Score grouping: the flat list as before');
  const sum = render(ctx, { view: 'summary', group: 'type' });
  assert.deepEqual(byClass(sum, 'tp-group-h').map(textOf), heads);
  assert.equal(byClass(sum, 'sum-group').find(n => n.attrs['aria-label'] === 'Columns by type') !== undefined, true);
  assert.equal(chipNames(sum).length, 8, 'unused columns are listed too');
  const sumScore = render(ctx, { view: 'summary' });
  assert.ok(byClass(sumScore, 'sum-group').some(n => n.attrs['aria-label'] === 'Columns by score'));
  assert.ok(!chipNames(sumScore).includes('delivered_at'), 'Score grouping keeps the unused collapse');
  // search in the Summary lists matches of every score, no "4-5" note there
  const found = render(ctx, { view: 'summary', query: 'delivered' });
  assert.deepEqual(chipNames(found), ['delivered_at']);
  assert.equal(byClass(found, 'tp-q-note').length, 0);
  assert.equal(textOf(byClass(found, 'tp-q-count')[0]), '1 / 8');
});

test('group switch: segmented buttons with aria-pressed, Turkish labels', () => {
  const ctx = load();
  for (const view of ['detail', 'summary']) {
    const sw = byClass(render(ctx, { view, group: 'type' }), 'tp-group')[0];
    assert.equal(sw.attrs.role, 'group');
    assert.equal(sw.attrs['aria-label'], 'Group columns by');
    assert.deepEqual(sw.kids.map(textOf), ['Score', 'Type']);
    assert.deepEqual(sw.kids.map(b => b.attrs['aria-pressed']), ['false', 'true']);
    calls.length = 0; sw.kids[0].attrs.onclick();
    assert.deepEqual(calls.at(-1), ['group', 'score']);
  }
  const tr = load('tr');
  const sw = byClass(render(tr, {}), 'tp-group')[0];
  assert.deepEqual(sw.kids.map(textOf), ['Puan', 'Tür']);
  assert.equal(sw.attrs['aria-label'], 'Kolonları grupla');
  assert.equal(byClass(render(tr, { query: 'created' }), 'tp-q')[0].attrs.placeholder, 'Kolonlarda ara');
  assert.deepEqual(byClass(render(tr, { group: 'type', showAll: true }), 'tp-group-h').map(textOf), ['Anahtarlar ve bağlantılar (2)', 'Tarih ve saat (2)', 'Tutarlar ve sayılar (1)', 'Metin (3)']);
});

test('the group choice is remembered like the view: page choice, then storage, garbage means Score', () => {
  const ctx = load();
  assert.equal(ctx.tpGroupChoice(undefined, undefined), 'score');
  assert.equal(ctx.tpGroupChoice(undefined, 'type'), 'type');
  assert.equal(ctx.tpGroupChoice('score', 'type'), 'score');
  assert.equal(ctx.tpGroupChoice(undefined, '<b>'), 'score');
  assert.match(page, /perfOpen: state\.perfOpen, tpView: state\.tpView, tpGroup: state\.tpGroup(, [^}]*)? \}\)\); \} catch \{\}/, 'saved by persist() inside try/catch');
  assert.match(page, /onGroup: v => \{ state\.tpGroup = v; persist\(\);/);
  assert.match(page, /const tpGroupOf = tp => tpGroupChoice\(tp\.group, state\.tpGroup\);/);
});

test('diacritic-insensitive search: a column without diacritics is found by a word with them', () => {
  const ctx = load();
  const rec = JSON.parse(JSON.stringify(recs['example.orders']));
  rec.columns.push({ name: 'odeme_tutari', type: 'numeric' });
  const names = q => rowNames(render(ctx, { query: q }, data, rec));
  assert.deepEqual(names('ödeme'), ['odeme_tutari']);
  assert.deepEqual(names('ÖDEME'), ['odeme_tutari']);
  assert.deepEqual(names('islem'), []);
  assert.deepEqual(names('IRSALIYE'), []);
});

test('the search box keeps focus, selection and a pending value over a redraw it did not start', () => {
  const ctx = load();
  const input = { id: 'tpSearch', value: 'abcdef', selectionStart: 2, selectionEnd: 4, selectionDirection: 'backward' };
  const doc = { activeElement: input, getElementById: id => (id === 'tpSearch' ? doc.next : null), next: null };
  const mk = () => { const el = { id: 'tpSearch', value: 'abcdef', focused: false, sel: null, focus() { this.focused = true; doc.activeElement = this; }, setSelectionRange(a, b, d) { this.sel = [a, b, d]; } }; return el; };
  let el = mk();
  ctx.tpKeepSearchFocus(doc, () => { doc.next = el; }, null);
  assert.equal(el.focused, true);
  assert.deepEqual(plain(el.sel), [2, 4, 'backward'], 'caret and selection are restored, not moved to the end');
  // a pending (debounced) value is put back and the selection is clamped
  doc.activeElement = { ...input, selectionStart: 6, selectionEnd: 6 };
  el = mk();
  ctx.tpKeepSearchFocus(doc, () => { doc.next = el; }, 'abcdefg');
  assert.equal(el.value, 'abcdefg');
  assert.deepEqual(plain(el.sel).slice(0, 2), [6, 6]);
  // focus elsewhere: nothing is stolen
  doc.activeElement = { id: 'other' };
  el = mk();
  ctx.tpKeepSearchFocus(doc, () => { doc.next = el; }, null);
  assert.equal(el.focused, false);
  assert.match(page, /tpKeepSearchFocus\(document, \(\) => put\(view, tablePageView\(/, 'the page redraw goes through it');
});

test('IME and debounce: composition is not applied until it ends; typing is applied after a pause', () => {
  const ctx = load();
  const input = all(render(ctx, {}), n => n.attrs.id === 'tpSearch')[0];
  calls.length = 0;
  input.attrs.oninput({ isComposing: true, target: { value: 'ş' } });
  assert.deepEqual(calls, []);
  input.attrs.oncompositionend({ target: { value: 'şe' } });
  assert.deepEqual(calls.at(-1), ['query', 'şe']);
  input.attrs.oninput({ isComposing: false, target: { value: 'x' } });
  assert.deepEqual(calls.at(-1), ['query', 'x']);
  assert.match(page, /setTimeout\(\(\) => \{ tpQPending = null; set\(\{ q \}\); \}, 100\)/);
});
