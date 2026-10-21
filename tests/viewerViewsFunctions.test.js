import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Views and functions in the viewer (table-page and fn-page blocks of
// src/viewer.html, run in isolation with a recording h()): the view facts of
// the table page model, the Views / Functions lists, the function page model
// with its risk marks, report matching and the rendered pages.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const tableKeyLines = page.match(/^const tableKey = .*\r?\n^const splitTableKey = .*$/m)[0];
const blockOf = name => page.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`))?.[0];
const pageTr = vm.runInNewContext(`(${page.match(/const TR = (\{[\s\S]*?\n\});/)[1]})`);

const h = (tag, attrs = {}, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false) });
const textOf = n => (typeof n === 'string' || typeof n === 'number' ? String(n) : n ? n.kids.map(textOf).join('') : '');
const all = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); n.kids.forEach(k => all(k, pred, out)); } return out; };
const byClass = (n, cls) => all(n, x => String(x.attrs.class || '').split(/\s+/).includes(cls));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const html = n => (typeof n === 'string' || typeof n === 'number' ? esc(n) : `<${n.tag}${Object.entries(n.attrs).filter(([, v]) => typeof v !== 'function' && v !== null && v !== undefined && v !== false).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${n.kids.map(html).join('')}</${n.tag}>`);
const plain = v => JSON.parse(JSON.stringify(v));

function load(lang = 'en') {
  for (const name of ['table-page', 'fn-page']) assert.ok(blockOf(name), `${name} block found`);
  const context = vm.createContext({
    JSON, h, svg: h, locale: lang === 'tr' ? 'tr-TR' : 'en-GB', fmt: n => String(n), compact: n => `~${n}`,
    ruleDay: ts => (ts ? String(ts).slice(0, 10) : '?'), changeLabel: c => c.change,
  });
  vm.runInContext(`${tableKeyLines}\n${page.match(/const foldText = .*;/)[0]}
${blockOf('table-page')}
${blockOf('fn-page')}
const TR = Object.assign({}, ${JSON.stringify(pageTr)});
for (const [k, v] of Object.entries({ ...tablePageTr, ...fnPageTr })) if (!Object.hasOwn(TR, k)) TR[k] = v;
const t = (en, vars = {}) => String(${JSON.stringify(lang)} === 'tr' && TR[en] !== undefined ? TR[en] : en).replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] ?? '');
Object.assign(this, { tablePageModel, tablePageView, functionPageModel, functionPageView, schemaObjectCounts, schemaObjectGroups, schemaObjectList,
  fnTrailId, fnFromTrail, tpCrumbLabel, tpMentions, tpReportsPanel, tpCode, fnFlagTexts, fnRiskTexts, fnRiskLabels, tpVolatileText, TR, t });`, context);
  return context;
}

// Graph and files with the example alias set, in the shapes of the contract.
const graph = () => ({
  profile: 'exampledb', generatedAt: 'g1', notes: [],
  nodes: [
    { id: 'example.orders', schema: 'example', table: 'orders', state: 'explored', kind: 'table', columnCount: 6 },
    { id: 'example.customers', schema: 'example', table: 'customers', state: 'explored', kind: 'table', columnCount: 2 },
    { id: 'example.v_order_list', schema: 'example', table: 'v_order_list', state: 'explored', kind: 'view', columnCount: 4, notes: 1,
      viewSources: ['example.customers', 'example.orders'], viewFunctions: ['example.order_total'] },
    { id: 'example.mv_daily_totals', schema: 'example', table: 'mv_daily_totals', state: 'explored', kind: 'matview', columnCount: 2, viewSources: ['example.v_order_list'], viewFunctions: [] },
    { id: 'test.v_invoices', schema: 'test', table: 'v_invoices', state: 'seen', kind: 'view', columnCount: 0 },
  ],
  edges: [{ from: 'example.v_order_list', to: 'example.orders', level: 'view', columns: [], refColumns: [] }],
  functions: [
    { id: 'example.order_total', schema: 'example', name: 'order_total', file: 'functions/example/order_total.json', state: 'explored', overloads: 2, kinds: ['function'], language: 'plpgsql',
      flags: { volatile: true, securityDefiner: true, definerWithoutSearchPath: true }, usedByTriggers: 0,
      calledBy: { views: ['example.v_order_list'], functions: ['example.order_report'] }, touches: { reads: ['example.order_items'], writes: ['example.order_events'] }, changes: 1 },
    { id: 'example.check_order', schema: 'example', name: 'check_order', file: 'functions/example/check_order.json', state: 'explored', overloads: 1, kinds: ['function'], language: 'plpgsql',
      flags: { volatile: true, securityDefiner: false, definerWithoutSearchPath: false }, usedByTriggers: 1, calledBy: { views: [], functions: [] }, touches: { reads: [], writes: [] } },
    { id: 'example.order_report', schema: 'example', name: 'order_report', file: 'functions/example/order_report.json', state: 'seen', overloads: 1, kinds: ['procedure'], language: 'sql',
      flags: { volatile: false, securityDefiner: false, definerWithoutSearchPath: false }, usedByTriggers: 0, calledBy: { views: [], functions: [] }, touches: { reads: [], writes: [] } },
  ],
});
const viewRec = () => ({
  schema: 'example', table: 'v_order_list', kind: 'view', describedAt: '2026-10-20T00:00:00Z', comment: null,
  columns: [{ name: 'order_id', type: 'bigint' }, { name: 'total', type: 'numeric' }], constraints: [], indexes: [], triggers: [], history: [],
  viewDefinition: ' SELECT o.order_id,\n    example.order_total(o.order_id) AS total\n   FROM example.orders o;', viewDefinitionLength: 80, viewDefinitionTruncated: false,
  viewOptions: { securityBarrier: true, checkOption: 'cascaded' },
  viewSources: [{ schema: 'example', table: 'customers', kind: 'table', columns: ['customer_id'] }, { schema: 'example', table: 'orders', kind: 'table', columns: ['order_id', 'status_code'] }],
  viewFunctions: [{ schema: 'example', name: 'order_total', arguments: 'p_order_id bigint', volatility: 'volatile' }],
  usedByViews: [{ schema: 'example', table: 'mv_daily_totals', kind: 'matview' }],
});
const ov = extra => ({ arguments: 'p_order_id bigint', returns: 'numeric', kind: 'function', language: 'plpgsql', volatility: 'volatile', securityDefiner: false, strict: false, parallel: 'unsafe',
  config: [], owner: 'report_reader', canExecute: true, comment: null, usedByTriggers: [], definition: 'BEGIN\n  RETURN 1;\nEND', definitionLength: 18, truncated: false,
  touches: { inferred: true, reads: ['example.order_items'], writes: ['example.order_events'] }, ...extra });
const fnRec = () => ({
  schema: 'example', name: 'order_total', describedAt: '2026-10-20T00:00:00Z',
  overloads: [ov(), ov({ arguments: 'p_order_id bigint, p_with_tax boolean', volatility: 'stable', securityDefiner: true, parallel: 'safe', strict: true,
    canExecute: false, comment: 'With tax <b>x</b>', touches: { inferred: true, reads: ['example.orders', 'example.order_items'], writes: [] } })],
  history: [{ at: '2026-10-01T00:00:00Z', changes: [{ change: 'overload-added', arguments: 'p_order_id bigint, p_with_tax boolean' }] },
    { at: '2026-10-20T00:00:00Z', changes: [{ change: 'definition-changed', arguments: 'p_order_id bigint' }] }],
});
const calls = [];
const ctxOf = (extra = {}) => ({ view: 'detail', open: null, showAll: false, canScore: false, onOpen: id => calls.push(['open', id]), onOpenFunction: id => calls.push(['fn', id]),
  onToggle() {}, onShowAll() {}, onScore() {}, onBack() {}, onClose() {}, onCrumb() {}, onReport: id => calls.push(['report', id]), ...extra });

test('view facts: definition, options, sources with columns, functions with volatility, used by views', () => {
  const ctx = load();
  const m = ctx.tablePageModel(graph(), 'example.v_order_list', viewRec());
  assert.equal(m.kind, 'view');
  assert.equal(m.view.securityBarrier, true);
  assert.equal(m.view.checkOption, 'cascaded');
  assert.equal(m.view.populated, null, 'populated is a matview fact only');
  assert.deepEqual(plain(m.view.sources), [
    { id: 'example.customers', kind: 'table', columns: ['customer_id'], explored: true },
    { id: 'example.orders', kind: 'table', columns: ['order_id', 'status_code'], explored: true }]);
  assert.deepEqual(plain(m.view.functions), [{ id: 'example.order_total', schema: 'example', name: 'order_total', arguments: 'p_order_id bigint', volatility: 'volatile', volatile: true, recorded: true }]);
  assert.equal(m.view.volatileCalls, 1);
  assert.deepEqual(plain(m.usedByViews.map(v => [v.id, v.kind])), [['example.mv_daily_totals', 'matview']]);
});

test('view facts fall back to the graph node; old records without view fields stay valid', () => {
  const ctx = load();
  const g = graph();
  const m = ctx.tablePageModel(g, 'example.v_order_list', null);
  assert.deepEqual(plain(m.view.sources.map(s => s.id)), ['example.customers', 'example.orders']);
  assert.deepEqual(plain(m.view.functions.map(f => [f.id, f.volatility, f.volatile])), [['example.order_total', 'volatile', true]], 'volatility from the graph flags');
  assert.equal(m.view.definition, null);
  assert.deepEqual(plain(m.usedByViews.map(v => v.id)), ['example.mv_daily_totals'], 'from viewSources of other nodes');
  // A table record of an old memory: no view facts, no usedByViews.
  const t = ctx.tablePageModel({ profile: 'exampledb', nodes: [{ id: 'example.orders', schema: 'example', table: 'orders', state: 'explored', kind: 'table' }], edges: [], notes: [] }, 'example.orders',
    { describedAt: 'x', kind: 'table', columns: [], constraints: [], history: [] });
  assert.equal(t.view, null);
  assert.deepEqual(plain(t.usedByViews), []);
  // A matview that was never refreshed.
  const mv = ctx.tablePageModel(g, 'example.mv_daily_totals', { describedAt: 'x', kind: 'matview', columns: [], constraints: [], history: [], populated: false });
  assert.equal(mv.view.populated, false);
});

test('a table lists the views that read it next to its referencing tables', () => {
  const ctx = load();
  const rec = { describedAt: 'x', kind: 'table', columns: [{ name: 'order_id', type: 'bigint' }], constraints: [], history: [], usedByViews: [{ schema: 'example', table: 'v_order_list', kind: 'view' }] };
  const m = ctx.tablePageModel(graph(), 'example.orders', rec);
  const view = ctx.tablePageView(m, ['example.orders'], ctxOf());
  const col = byClass(view, 'tp-deps-col')[0];
  assert.ok(col, 'the right column holds both panels');
  const panel = all(col, n => n.attrs['aria-label'] === 'Used by views')[0];
  assert.match(textOf(panel), /example\.v_order_list/);
  all(panel, n => n.tag === 'button')[0].attrs.onclick();
  assert.deepEqual(calls.at(-1), ['open', 'example.v_order_list']);
});

test('view page: badge, definition with options and copy, sources, volatile warning, reports', () => {
  const ctx = load();
  const m = ctx.tablePageModel(graph(), 'example.v_order_list', viewRec());
  const copied = [];
  const reports = { items: [{ id: 'r1', title: 'Open orders', sql: 'select * from example.v_order_list' }, { id: 'r2', title: 'Other', sql: 'select * from example.v_order_list_old' }], pending: 0, failed: 0, capped: 0 };
  const view = ctx.tablePageView(m, ['example.v_order_list'], ctxOf({ onCopy: s => copied.push(s), reports }));
  const text = textOf(view);
  assert.ok(byClass(view, 'kind-view').some(b => textOf(b) === 'View'));
  assert.match(text, /security_barrier/);
  assert.match(text, /check option: cascaded/);
  const pre = all(view, n => n.tag === 'pre')[0];
  assert.equal(pre.attrs.class, 'sql numbered wrap');
  assert.equal(byClass(pre, 'sq-line').length, 3, 'one line node per line without the page highlighter');
  all(view, n => n.tag === 'button' && textOf(n) === 'Copy SQL')[0].attrs.onclick();
  assert.equal(copied[0], viewRec().viewDefinition);
  const left = byClass(view, 'tp-refs')[0];
  assert.match(textOf(left), /example\.orders.*order_id, status_code/);
  const fns = all(view, n => n.attrs['aria-label'] === 'Functions called')[0];
  assert.ok(byClass(fns, 'risk-warn').length >= 1, 'volatile call is marked');
  assert.equal(byClass(fns, 'risk-warn')[0].attrs.title, ctx.tpVolatileText);
  all(fns, n => n.tag === 'button')[0].attrs.onclick();
  assert.deepEqual(calls.at(-1), ['fn', 'example.order_total']);
  const rep = all(view, n => n.attrs['aria-label'] === 'Reports')[0];
  assert.deepEqual(byClass(rep, 'sum-chip').map(textOf), ['Open orders'], 'a longer name does not match');
});

test('a long definition starts clipped with a show-all button; a cut one says so', () => {
  const ctx = load();
  const sql = Array.from({ length: 30 }, (_, i) => `select ${i}`).join('\n');
  const toggles = [];
  const box = ctx.tpCode(sql, { id: 'x', label: 'L', open: false, onToggle: v => toggles.push(v), truncated: true, length: 9000 }, {});
  assert.match(box.attrs.class, /clipped/);
  const more = byClass(box, 'code-more')[0];
  assert.equal(more.attrs['aria-expanded'], 'false');
  assert.equal(more.attrs['aria-controls'], 'x');
  more.attrs.onclick();
  assert.deepEqual(toggles, [true]);
  assert.match(textOf(box), /Cut at \d+ of 9000 characters/);
  const open = ctx.tpCode(sql, { id: 'x', label: 'L', open: true, onToggle: v => toggles.push(v) }, { wrap: false });
  assert.doesNotMatch(open.attrs.class, /clipped/);
  assert.equal(all(open, n => n.tag === 'pre')[0].attrs.class, 'sql numbered');
});

test('view summary shows the definition, sources, called functions and used by views', () => {
  const ctx = load();
  const m = ctx.tablePageModel(graph(), 'example.v_order_list', viewRec());
  const view = ctx.tablePageView(m, ['example.v_order_list'], ctxOf({ view: 'summary', reports: { items: [], pending: 0 }, onView() {}, onColumn() {}, onUnused() {} }));
  const groups = byClass(view, 'sum-group').map(g => g.attrs['aria-label']);
  assert.ok(groups.includes('Source relations') && groups.includes('Functions called') && groups.includes('Used by views'));
  assert.ok(!groups.includes('Primary key') && !groups.includes('Foreign keys'));
  assert.equal(all(view, n => n.tag === 'pre').length, 1, 'definition box');
  assert.ok(byClass(view, 'c-fn-risk').length === 1, 'the volatile function chip is marked');
});

test('type counts and the Views / Functions lists: grouped by schema, searched by name, filtered by schema', () => {
  const ctx = load();
  const g = graph();
  assert.deepEqual(plain(ctx.schemaObjectCounts(g)), { tables: 2, views: 3, functions: 3 });
  assert.deepEqual(plain(ctx.schemaObjectCounts({ nodes: [] })), { tables: 0, views: 0, functions: 0 }, 'old graph without functions');
  const v = ctx.schemaObjectGroups(g, 'views', '', '');
  assert.deepEqual(plain(v.groups.map(x => [x.schema, x.items.map(i => i.name)])), [['example', ['mv_daily_totals', 'v_order_list']], ['test', ['v_invoices']]]);
  const vo = v.groups[0].items[1];
  assert.equal(vo.sources, 2); assert.equal(vo.functions, 1); assert.equal(vo.volatile, 1);
  const f = ctx.schemaObjectGroups(g, 'functions', 'EXAMPLE.ORDER_', '');
  assert.deepEqual(plain(f.groups[0].items.map(i => i.name)), ['order_report', 'order_total']);
  assert.equal(f.shown, 2); assert.equal(f.total, 3); assert.equal(f.searching, true);
  const ot = f.groups[0].items[1];
  assert.equal(ot.definerRisk, true); assert.equal(ot.calledByViews, 1); assert.equal(ot.writes, 1);
  assert.equal(ctx.schemaObjectGroups(g, 'views', '', 'test').total, 1);
  assert.equal(ctx.schemaObjectGroups(g, 'functions', 'order total', '').shown, 1, 'every word must match');
});

test('list rows are buttons that open the page; risks and states are badges; empty states explain the tools', () => {
  const ctx = load();
  const opened = [];
  const res = ctx.schemaObjectGroups(graph(), 'functions', '', '');
  const list = ctx.schemaObjectList(res, { onOpen: x => opened.push(x.id) });
  const rows = byClass(list, 'obj-row');
  assert.ok(rows.every(r => r.tag === 'button' && r.attrs.type === 'button'));
  assert.deepEqual(rows.map(r => textOf(byClass(r, 'obj-nm')[0])), ['check_order()', 'order_report()', 'order_total()']);
  rows[2].attrs.onclick();
  assert.deepEqual(opened, ['example.order_total']);
  assert.match(textOf(rows[1]), /listed only/);
  assert.match(textOf(rows[1]), /procedure/);
  assert.equal(byClass(rows[2], 'risk-crit').length, 1);
  assert.equal(byClass(rows[2], 'risk-warn').length, 1);
  const empty = ctx.schemaObjectList(ctx.schemaObjectGroups({ nodes: [] }, 'functions', '', ''), { onOpen() {} });
  assert.match(textOf(empty), /list_functions/);
  const none = ctx.schemaObjectList(ctx.schemaObjectGroups(graph(), 'views', 'zzz', ''), { onOpen() {}, onClearSearch() {} });
  assert.match(textOf(none), /Nothing matches the search/);
});

test('function page model: overloads, flags, risks, touches, callers, triggers, history newest first', () => {
  const ctx = load();
  const m = ctx.functionPageModel(graph(), 'example.order_total', fnRec());
  assert.equal(m.overloadCount, 2);
  assert.equal(m.described, true);
  const [a, b] = m.overloads;
  assert.equal(a.signature, 'order_total(p_order_id bigint)');
  assert.deepEqual(plain(a.risks), ['volatile-in-view'], 'volatile and a view calls the function');
  assert.deepEqual(plain(b.risks), ['definer-no-search-path'], 'security definer without search_path; stable is no view risk');
  assert.equal(b.canExecute, false);
  assert.deepEqual(plain(m.risks), ['volatile-in-view', 'definer-no-search-path']);
  assert.deepEqual(plain(m.touches.reads.map(r => r.id)), ['example.order_items', 'example.orders'], 'union, sorted');
  assert.deepEqual(plain(m.touches.writes.map(r => r.id)), ['example.order_events']);
  assert.deepEqual(plain(m.calledBy.views.map(v => v.id)), ['example.v_order_list']);
  assert.deepEqual(plain(m.calledBy.functions), [{ id: 'example.order_report', recorded: true }]);
  assert.deepEqual(plain(m.history.map(x => x.changes[0].change)), ['definition-changed', 'overload-added']);
  // A fixed search_path removes the definer risk.
  const fixed = ctx.functionPageModel(graph(), 'example.order_total', { ...fnRec(), overloads: [ov({ securityDefiner: true, volatility: 'stable', config: ['search_path=example, pg_temp'] })] });
  assert.deepEqual(plain(fixed.risks), []);
  assert.equal(fixed.overloads[0].searchPath, 'example, pg_temp');
});

test('function page model without a file uses the graph entry; an unknown function is not recorded', () => {
  const ctx = load();
  const m = ctx.functionPageModel(graph(), 'example.order_total', null);
  assert.equal(m.recorded, true);
  assert.equal(m.overloadCount, 2);
  assert.deepEqual(plain(m.risks), ['definer-no-search-path', 'volatile-in-view']);
  assert.deepEqual(plain(m.touches.writes.map(r => r.id)), ['example.order_events']);
  const u = ctx.functionPageModel(graph(), 'example.nope', null);
  assert.equal(u.recorded, false);
  assert.equal(u.state, 'unexplored');
  const view = ctx.functionPageView(u, [ctx.fnTrailId('example.nope')], ctxOf({ reports: { items: [] } }));
  assert.match(textOf(view), /describe_functions on example\.nope/);
  // A triggered function: links go to the table page.
  const t = ctx.functionPageModel(graph(), 'example.check_order', { schema: 'example', name: 'check_order', describedAt: 'x',
    overloads: [ov({ arguments: '', returns: 'trigger', config: ['search_path=example'], usedByTriggers: [{ table: 'example.orders', trigger: 'orders_check_status' }] })] });
  assert.deepEqual(plain(t.triggers), [{ table: 'example.orders', trigger: 'orders_check_status', signature: 'check_order()' }]);
  assert.deepEqual(plain(t.risks), [], 'not called from a view');
});

test('function page view: signature, flag chips with explanations, risk boxes, body, inferred touches, used by, reports', () => {
  const ctx = load();
  const m = ctx.functionPageModel(graph(), 'example.order_total', fnRec());
  const helps = [];
  const reports = { items: [{ id: 'r1', title: 'Totals', sql: 'select example.order_total(1)' }, { id: 'r2', title: 'Other', sql: 'select order_total_old(1)' }], pending: 1, failed: 0, capped: 0 };
  const view = ctx.functionPageView(m, ['example.orders', ctx.fnTrailId('example.order_total')], ctxOf({ reports, onFlagHelp: (k, v) => helps.push([k, v]), flagHelp: { 'example.order_total#1': true } }));
  const cards = byClass(view, 'fn-ov');
  assert.equal(cards.length, 2);
  assert.equal(textOf(byClass(cards[0], 'fn-sig')[0]), 'order_total(p_order_id bigint) → numeric');
  const chips = byClass(cards[0], 'fn-flag');
  const vol = chips.find(c => textOf(c) === 'volatile');
  assert.equal(vol.attrs.title, ctx.fnFlagTexts.volatile);
  assert.match(vol.attrs.class, /warn/);
  assert.ok(chips.some(c => textOf(c) === 'can execute'));
  const defChip = byClass(cards[1], 'fn-flag').find(c => textOf(c) === 'security definer');
  assert.match(defChip.attrs.class, /crit/);
  assert.equal(byClass(cards[0], 'risk-box')[0].attrs.class, 'risk-box warn');
  assert.equal(byClass(cards[1], 'risk-box')[0].attrs.class, 'risk-box crit');
  const btn = byClass(cards[0], 'fn-help-btn')[0];
  assert.equal(btn.attrs['aria-expanded'], 'false');
  btn.attrs.onclick();
  assert.deepEqual(helps, [['example.order_total#0', true]]);
  assert.equal(all(cards[1], n => n.tag === 'dl').length, 1, 'open explanations of the second overload');
  assert.equal(all(cards[0], n => n.tag === 'pre').length, 1);
  const touches = byClass(view, 'tp-refs')[0];
  assert.equal(touches.attrs['aria-label'], 'Touches (inferred)');
  assert.ok(byClass(touches, 'inference').length === 1, 'labelled as inferred');
  all(touches, n => n.tag === 'button' && textOf(n).includes('example.order_events'))[0].attrs.onclick();
  assert.deepEqual(calls.at(-1), ['open', 'example.order_events']);
  const used = byClass(view, 'tp-deps')[0];
  all(used, n => n.tag === 'button' && textOf(n).includes('order_report'))[0].attrs.onclick();
  assert.deepEqual(calls.at(-1), ['fn', 'example.order_report']);
  const rep = all(view, n => n.attrs['aria-label'] === 'Reports')[0];
  assert.deepEqual(byClass(rep, 'sum-chip').map(textOf), ['Totals']);
  assert.match(textOf(rep), /1 still loading/);
  assert.match(textOf(view), /body changed/);
  const crumb = byClass(view, 'cur')[0];
  assert.equal(textOf(crumb), 'example.order_total()');
});

test('trail ids of function pages never collide with table keys', () => {
  const ctx = load();
  const id = ctx.fnTrailId('example.order_total');
  assert.equal(ctx.fnFromTrail(id), 'example.order_total');
  assert.equal(ctx.fnFromTrail('example.order_total'), null);
  assert.equal(ctx.fnFromTrail('"fn:x".y'), null);
  assert.equal(ctx.tpCrumbLabel('example.orders'), 'example.orders');
  assert.equal(ctx.tpCrumbLabel(id), 'example.order_total()');
});

test('every text is a text node: names, comments and SQL are escaped', () => {
  assert.doesNotMatch(blockOf('fn-page'), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const ctx = load();
  const rec = fnRec();
  rec.overloads[0].definition = 'select \'<script>x</script>\'';
  const out = html(ctx.functionPageView(ctx.functionPageModel(graph(), 'example.order_total', rec), ['x'], ctxOf({ reports: { items: [] } })));
  assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(out.includes('With tax &lt;b&gt;x&lt;/b&gt;'));
  assert.doesNotMatch(out, /<script>|<b>x/);
});

test('TR and EN: every string of the fn-page block has a Turkish text', () => {
  const ctx = load('tr');
  const keys = [...blockOf('fn-page').matchAll(/\bt\('((?:[^'\\]|\\.)+)'/g)].map(m => m[1].replace(/\\'/g, "'"));
  const mapped = [...Object.values(ctx.fnFlagTexts), ...Object.values(ctx.fnRiskTexts), ...Object.values(ctx.fnRiskLabels), ctx.tpVolatileText,
    'Tables', 'Views', 'Functions', 'function', 'procedure', 'aggregate', 'window', 'volatile', 'stable', 'immutable', 'overload added', 'overload removed', 'body changed', 'flags changed'];
  const missing = [...new Set([...keys, ...mapped])].filter(k => ctx.TR[k] === undefined);
  assert.deepEqual(missing, []);
  const text = textOf(ctx.functionPageView(ctx.functionPageModel(graph(), 'example.order_total', fnRec()), ['x'], ctxOf({ reports: { items: [] } })));
  assert.match(text, /Dokunduğu tablolar/);
  assert.match(text, /search_path olmadan security definer/);
  const list = textOf(ctx.schemaObjectList(ctx.schemaObjectGroups(graph(), 'functions', '', ''), { onOpen() {} }));
  assert.match(list, /Fonksiyonlar/);
});

test('glue: the Schema tab remembers the type, lists views and functions and the search finds them', () => {
  assert.match(page, /memType: state\.memType/, 'persisted');
  assert.match(page, /if \(memTypeOf\(\) !== 'tables'\) \{ renderObjectList\(view, mv\.data\); return; \}/);
  assert.match(page, /\/api\/memory\/function\?profile=\$\{encodeURIComponent\(tp\.db\)\}&file=\$\{encodeURIComponent\(entry\.file\)\}/);
  assert.match(page, /row\(t\('Functions'\), fns, id => openFunctionPage\(state\.db, id\)/);
  assert.match(page, /\.g-edge\.view \{/);
});

test('listed-only overloads, flag change fields and pg_catalog names are shown apart', () => {
  const ctx = load();
  const rec = { schema: 'example', name: 'order_total', describedAt: null,
    overloads: [ov({ listedOnly: true, definition: null, touches: { inferred: true, reads: ['pg_catalog.pg_class', 'example.orders'], writes: [] } })],
    history: [{ at: '2026-10-20T00:00:00Z', changes: [{ change: 'flags-changed', arguments: 'p_order_id bigint', fields: ['volatility', 'owner'] }] }] };
  const m = ctx.functionPageModel(graph(), 'example.order_total', rec);
  assert.equal(m.overloads[0].listedOnly, true);
  assert.deepEqual(plain(m.touches.reads.map(r => r.id)), ['example.orders']);
  assert.deepEqual(plain(m.touches.system), ['pg_catalog.pg_class']);
  const text = textOf(ctx.functionPageView(m, ['x'], ctxOf({ reports: { items: [] } })));
  assert.match(text, /Listed only, not described yet/);
  assert.match(text, /flags changed: volatility, owner/);
  assert.match(text, /pg_catalog\.pg_class/);
});

test('summary: an empty chip group says "None known." (Used by views, Referenced and Referencing tables)', () => {
  const ctx = load();
  const sum = { view: 'summary', reports: { items: [], pending: 0 }, onView() {}, onColumn() {}, onUnused() {} };
  const groupText = (view, title) => textOf(byClass(view, 'sum-group').find(g => g.attrs['aria-label'] === title));
  const rec = { ...viewRec(), usedByViews: [] };
  const v = ctx.tablePageView(ctx.tablePageModel(graph(), 'example.v_order_list', rec), ['x'], ctxOf(sum));
  const used = byClass(v, 'sum-group').find(g => g.attrs['aria-label'] === 'Used by views');
  assert.equal(byClass(used, 'sum-chips').length, 0);
  assert.match(groupText(v, 'Used by views'), /None known\./);
  const t = ctx.tablePageView(ctx.tablePageModel(graph(), 'example.customers', { describedAt: 'x', kind: 'table', columns: [], constraints: [], history: [] }), ['x'], ctxOf(sum));
  assert.match(groupText(t, 'Referenced tables'), /None known\./);
  assert.match(groupText(t, 'Referencing tables'), /None known\./);
  // A non-empty group keeps its chips.
  const full = ctx.tablePageView(ctx.tablePageModel(graph(), 'example.v_order_list', viewRec()), ['x'], ctxOf(sum));
  assert.match(groupText(full, 'Used by views'), /example\.mv_daily_totals/);
  assert.doesNotMatch(groupText(full, 'Used by views'), /None known/);
});

test('change label: view-sources-changed lists added and removed sources (EN and TR)', () => {
  const src = page.match(/^function changeLabel\(c\) \{[\s\S]*?\n\}\n/m)[0];
  const run = lang => {
    const ctx = vm.createContext({});
    vm.runInContext(`const TR = ${JSON.stringify(pageTr)};
const t = (en, vars = {}) => String(${JSON.stringify(lang)} === 'tr' && TR[en] !== undefined ? TR[en] : en).replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] ?? '');
${src}\nthis.changeLabel = changeLabel;`, ctx);
    return ctx.changeLabel;
  };
  const en = run('en');
  assert.equal(en({ change: 'view-sources-changed', added: ['example.orders', 'example.customers'], removed: ['test.invoices'] }),
    'view sources changed: +example.orders, example.customers / −test.invoices');
  assert.equal(en({ change: 'view-sources-changed', added: [], removed: ['test.invoices'] }), 'view sources changed: −test.invoices');
  assert.equal(en({ change: 'view-sources-changed' }), 'view sources changed');
  assert.equal(run('tr')({ change: 'view-sources-changed', added: ['example.orders'] }), 'view kaynakları değişti: +example.orders');
});
