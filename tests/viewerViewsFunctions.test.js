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
Object.assign(this, { tablePageModel, tablePageView, functionPageModel, functionPageView, schemaObjectCounts, schemaObjectGroups, schemaObjectList, functionSections, fnImportantTables, functionList, fnTableColumns, fnRoleOf, tpImportance,
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
  edges: [{ from: 'example.v_order_list', to: 'example.orders', level: 'view', columns: ['order_id', 'status_code'], refColumns: [] }],
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
  const view = ctx.tablePageView(m, ['example.v_order_list'], ctxOf({ onCopy: s => copied.push(s), reports, sqlShown: true }));
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
  assert.equal(all(view, n => n.tag === 'pre').length, 0, 'the SQL stays collapsed');
  assert.ok(byClass(view, 'tp-sql-btn').length === 1, 'a Show SQL button');
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
  assert.deepEqual(plain(t.triggers), [{ table: 'example.orders', trigger: 'orders_check_status', timing: null, events: [], level: null, signature: 'check_order()' }]);
  assert.equal(t.isTrigger, true, 'returns trigger');
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

test('tabs: Views and Functions follow Tables, restore after reload and have counts, own toolbar and shortcuts', () => {
  assert.match(page, /<button data-tab="tables">[\s\S]*?<\/button>\s*<button data-tab="views"><span data-i18n="Views">Views<\/span><span class="count" id="cViews"><\/span><\/button>\s*<button data-tab="functions"><span data-i18n="Functions">Functions<\/span><span class="count" id="cFunctions"><\/span><\/button>/);
  assert.match(page, /<section id="v-views" class="view" hidden><\/section>\s*<section id="v-functions" class="view" hidden><\/section>/);
  assert.match(page, /const tabNames = \['overview', 'ops', 'tables', 'views', 'functions', 'reports', 'schema', 'rules', 'profiles'\];/);
  assert.match(page, /const ownToolbarTabs = \[[^\]]*'views', 'functions'\]/);
  assert.match(page, /'1', '2', '3', '4', '5', '6', '7', '8', '9'\]\.includes\(ev\.key\)/);
  assert.match(page, /renderObjectTab\('views'\);\s*renderObjectTab\('functions'\);\s*renderRules\(\);/, 'render() draws both tabs');
  // The counts: views and matviews from the graph nodes, functions from functions[].
  assert.deepEqual(plain(load().schemaObjectCounts(graph())), { tables: 2, views: 3, functions: 3 });
  // A database must be chosen: the same chooser as Schema and Rules.
  assert.match(page, /if \(!state\.db\) return plain\(memChooser\(profiles\)\);\s*if \(!sum\) \{\s*return plain\(h\('div', \{ class: 'panel' \}, h\('div', \{ class: 'rep-empty' \}, h\('b', \{\}, t\('No schema memory for \{db\} yet'/);
});

test('the Schema tab has no type switch any more; a stale memType is ignored', () => {
  assert.doesNotMatch(page, /memType|memTypeSwitch|renderObjectList|memListHost/);
  assert.match(page, /\/api\/memory\/function\?profile=\$\{encodeURIComponent\(tp\.db\)\}&file=\$\{encodeURIComponent\(entry\?\.file \?\? ''\)\}/);
  assert.match(page, /row\(t\('Functions'\), fns, id => openFunctionPage\(state\.db, id\)/, 'the Schema search still lists functions');
  assert.match(page, /\.g-edge\.view \{/);
});

// The page-tabs block with a recording page: which tab a page opens in and how
// its trail grows, goes back and closes.
function loadTabs(stateInit = {}) {
  const src = page.match(/\/\/ page-tabs:start[\s\S]*?\/\/ page-tabs:end/)?.[0];
  assert.ok(src, 'page-tabs block found');
  const log = [];
  const state = { db: 'exampledb', tab: 'views', memView: { profile: 'exampledb', data: graph() }, ...stateInit };
  const ctx = vm.createContext({ state, log, setDb: db => { state.db = db; }, switchTab: tab => { log.push(['switch', tab]); state.tab = tab; },
    renderSchema: () => log.push(['render', 'schema']), renderObjectTab: tab => log.push(['render', tab]), scrollTo() {}, setMemSel: id => log.push(['sel', id]) });
  const tp = page.match(/^const tpIsView = .*$/m)[0];
  const fn = page.match(/^const fnTrailPrefix = [\s\S]*?^const fnFromTrail = .*$/m)[0];
  vm.runInContext(`${tp}\n${fn}\n${src}\nObject.assign(this, { openTablePage, openFunctionPage, openPage, pageBack, closePage, pageTabOf, pageOf, fnTrailId, slashTarget });`, ctx);
  return ctx;
}

test('page routing: tables in Schema, views in Views, functions in Functions; cross links switch tabs and start a new trail', () => {
  const ctx = loadTabs({ tab: 'views' });
  assert.equal(ctx.pageTabOf('exampledb', 'example.orders'), 'schema');
  assert.equal(ctx.pageTabOf('exampledb', 'example.mv_daily_totals'), 'views');
  assert.equal(ctx.pageTabOf('exampledb', ctx.fnTrailId('example.order_total')), 'functions');
  // In the Views tab: a view opens there and the trail grows within the tab.
  ctx.openTablePage('exampledb', 'example.v_order_list');
  ctx.openTablePage('exampledb', 'example.mv_daily_totals');
  assert.deepEqual(plain(ctx.state.viewPage.trail), ['example.v_order_list', 'example.mv_daily_totals']);
  assert.deepEqual(plain(ctx.log.splice(0)), [['render', 'views'], ['render', 'views']]);
  // A view's source table goes to the Schema tab with a fresh trail.
  ctx.state.tablePage = { db: 'exampledb', trail: ['example.customers', 'example.old'] };
  ctx.openTablePage('exampledb', 'example.orders');
  assert.deepEqual(plain(ctx.state.tablePage.trail), ['example.orders']);
  assert.deepEqual(plain(ctx.log.splice(0)), [['switch', 'schema']]);
  // A table's "Used by views" goes back to the Views tab (fresh trail there).
  ctx.openTablePage('exampledb', 'example.v_order_list');
  assert.equal(ctx.state.tab, 'views');
  assert.deepEqual(plain(ctx.state.viewPage.trail), ['example.v_order_list']);
  // A view's called function goes to the Functions tab; its calling view back to Views.
  ctx.openFunctionPage('exampledb', 'example.order_total');
  assert.equal(ctx.state.tab, 'functions');
  assert.deepEqual(plain(ctx.state.fnPage.trail), [ctx.fnTrailId('example.order_total')]);
  ctx.openFunctionPage('exampledb', 'example.order_report');
  assert.equal(ctx.state.fnPage.trail.length, 2, 'function to function stays in the tab');
  ctx.log.splice(0);
  ctx.openTablePage('exampledb', 'example.v_order_list');
  assert.deepEqual(plain(ctx.log.splice(0)), [['switch', 'views']]);
});

test('page routing: Back walks the tab trail, then returns to that tab\'s list; Schema keeps its selection', () => {
  const ctx = loadTabs({ tab: 'functions' });
  ctx.openFunctionPage('exampledb', 'example.order_total');
  ctx.openFunctionPage('exampledb', 'example.order_report');
  ctx.log.splice(0);
  ctx.pageBack('functions');
  assert.deepEqual(plain(ctx.state.fnPage.trail), [ctx.fnTrailId('example.order_total')]);
  ctx.pageBack('functions');
  assert.equal(ctx.state.fnPage, null, 'back on the first page shows the list');
  assert.deepEqual(plain(ctx.log.splice(0)), [['render', 'functions'], ['render', 'functions']]);
  const s = loadTabs({ tab: 'schema' });
  s.openTablePage('exampledb', 'example.orders');
  s.log.splice(0);
  s.closePage('schema');
  assert.deepEqual(plain(s.log), [['sel', 'example.orders'], ['render', 'schema']]);
});

test('page cross links: view sources and touched tables open table pages, functions and views their own pages', () => {
  // The pages only call onOpen (tables and views, routed by kind) and
  // onOpenFunction; the glue maps them to openTablePage / openFunctionPage.
  assert.match(page, /onOpen: next => openTablePage\(tp\.db, next\), onOpenFunction: next => openFunctionPage\(tp\.db, next\),/);
  assert.match(page, /\.\.\.tpCodeCtx\(tab, tp, id, set\), onOpenFunction: fn => openFunctionPage\(tp\.db, fn\),/);
  assert.match(page, /onOpen: x => \(tab === 'views' \? openPage\('views', state\.db, x\.id\) : openFunctionPage\(state\.db, x\.id\)\),/);
  const ctx = load();
  const m = ctx.functionPageModel(graph(), 'example.order_total', fnRec());
  const view = ctx.functionPageView(m, ['x'], ctxOf({ reports: { items: [] } }));
  all(byClass(view, 'tp-deps')[0], n => n.tag === 'button' && textOf(n).includes('example.v_order_list'))[0].attrs.onclick();
  assert.deepEqual(calls.at(-1), ['open', 'example.v_order_list'], 'a calling view goes through onOpen (routed to Views by kind)');
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
  const lone = graph(); lone.nodes.find(n => n.id === 'example.mv_daily_totals').viewSources = []; // no view reads v_order_list
  const v = ctx.tablePageView(ctx.tablePageModel(lone, 'example.v_order_list', rec), ['x'], ctxOf(sum));
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
  const src = page.match(/^function changeLabel\(c\) \{[\s\S]*?\r?\n\}\r?\n/m)[0];
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

test('a view edge gives no FK tags and reads as "reads: columns" in the inspector', () => {
  const block = blockOf('roles');
  assert.ok(block, 'roles block found');
  const ctx = vm.createContext({ Map, Set, Math, Number });
  vm.runInContext(`${tableKeyLines}
const t = (en, vars = {}) => String(en).replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] ?? '');
${block}
this.centerColumns = centerColumns; this.relColsText = relColsText;`, ctx);
  const g = graph();
  const edge = g.edges[0];
  const view = ctx.centerColumns(g, 'example.v_order_list', viewRec());
  assert.deepEqual(plain(view.keyCols), [], 'the view center gets no FK tags from its source columns');
  const src = ctx.centerColumns(g, 'example.orders', { columns: [{ name: 'order_id', type: 'bigint' }, { name: 'status_code', type: 'text' }], constraints: [] });
  assert.deepEqual(plain(src.tagsOf('order_id')), [], 'the source gets no ← tags from a view');
  assert.equal(ctx.relColsText(edge, true), 'reads: order_id, status_code');
  assert.equal(ctx.relColsText(edge, false), 'read by view: order_id, status_code');
  assert.equal(ctx.relColsText({ ...edge, columns: [] }, true), 'reads');
  assert.equal(ctx.relColsText({ level: 'fk', columns: ['customer_id'], refColumns: ['customer_id'] }, true), 'customer_id → customer_id');
  const tr = ['view source', 'reads: {c}', 'read by view: {c}', 'reads', 'read by view'].filter(k => pageTr[k] === undefined);
  assert.deepEqual(tr, []);
});

test('trigger tables: the raw schema.relname resolves to the graph node key (quoted names too), else stays raw', () => {
  const ctx = load();
  const g = graph();
  g.nodes.push({ id: 'example."order.archive"', schema: 'example', table: 'order.archive', state: 'explored', kind: 'table' });
  const rec = { schema: 'example', name: 'check_order', describedAt: 'x', overloads: [ov({ arguments: '', returns: 'trigger', config: ['search_path=example'],
    usedByTriggers: [{ table: 'example.order.archive', trigger: 'archive_check' }, { table: 'example.orders', trigger: 'orders_check_status' }, { table: 'test.invoices', trigger: 'invoices_check' }] })] };
  const m = ctx.functionPageModel(g, 'example.check_order', rec);
  assert.deepEqual(plain(m.triggers.map(x => x.table)), ['example."order.archive"', 'example.orders', 'test.invoices']);
  const view = ctx.functionPageView(m, ['x'], ctxOf({ reports: { items: [] } }));
  const panel = byClass(view, 'fn-trg')[0];
  const row = all(panel, n => n.tag === 'li' && textOf(n).includes('archive_check'))[0];
  all(row, n => n.tag === 'button')[0].attrs.onclick();
  assert.deepEqual(calls.at(-1), ['open', 'example."order.archive"']);
});

test('XSS: the view and function page code builds text nodes only; hostile names and SQL stay text', () => {
  const tablePage = blockOf('table-page');
  for (const fn of ['tpCode', 'tpViewDefinition', 'tpRelPanel', 'tpViewFunctions', 'tpReportsPanel', 'tpViewHeader']) {
    const src = tablePage.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\r?\\n\\}\\r?\\n`))?.[0];
    assert.ok(src, `${fn} found`);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc/, fn);
  }
  assert.doesNotMatch(blockOf('fn-page'), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc/);
  const ctx = load();
  const evil = '<img src=x onerror=alert(1)>';
  const g = graph();
  g.nodes.push({ id: `example.${evil}`, schema: 'example', table: evil, state: 'explored', kind: 'table' });
  const rec = { ...viewRec(), comment: evil, viewDefinition: `select '${evil}'`,
    viewSources: [{ schema: 'example', table: evil, kind: 'table', columns: [evil] }], viewFunctions: [{ schema: 'example', name: evil, arguments: evil, volatility: 'volatile' }] };
  const view = ctx.tablePageView(ctx.tablePageModel(g, 'example.v_order_list', rec), ['example.v_order_list'], ctxOf({ reports: { items: [] } }));
  // No element was created from the strings: every tag is one the code chose,
  // and the hostile text only appears inside string children.
  const tags = new Set(all(view, () => true).map(n => n.tag));
  assert.ok(!tags.has('img'));
  const strings = []; const walk = n => n.kids.forEach(k => (typeof k === 'string' ? strings.push(k) : k && typeof k === 'object' ? walk(k) : null)); walk(view);
  assert.ok(strings.some(s => s.includes(evil)));
  assert.ok(all(view, () => true).every(n => Object.entries(n.attrs).every(([k, v]) => typeof v === 'function' || !String(k).startsWith('onerror'))));
  const out = html(view);
  assert.doesNotMatch(out, /<img/);
});

test('used by views: a stale [] in the record is joined with the graph (view edges and viewSources), deduplicated and sorted', () => {
  const ctx = load();
  const g = graph();
  // A view described after this one: only the graph knows it reads v_order_list.
  g.nodes.push({ id: 'example.v_late', schema: 'example', table: 'v_late', state: 'explored', kind: 'view' });
  g.edges.push({ from: 'example.v_late', to: 'example.v_order_list', level: 'view', columns: ['order_id'], refColumns: [] },
    { from: 'example.mv_daily_totals', to: 'example.v_order_list', level: 'view', columns: ['order_id'], refColumns: [] });
  const m = ctx.tablePageModel(g, 'example.v_order_list', { ...viewRec(), usedByViews: [] });
  assert.deepEqual(plain(m.usedByViews.map(v => [v.id, v.kind])), [['example.mv_daily_totals', 'matview'], ['example.v_late', 'view']]);
  // The record's own entries stay, the graph's are added once.
  const both = ctx.tablePageModel(g, 'example.v_order_list', viewRec());
  assert.deepEqual(plain(both.usedByViews.map(v => v.id)), ['example.mv_daily_totals', 'example.v_late']);
  // A table: an edge into it is enough, also with an empty record list.
  const t = ctx.tablePageModel(g, 'example.orders', { describedAt: 'x', kind: 'table', columns: [], constraints: [], history: [], usedByViews: [] });
  assert.deepEqual(plain(t.usedByViews.map(v => v.id)), ['example.v_order_list']);
  const view = ctx.tablePageView(t, ['example.orders'], ctxOf());
  assert.match(textOf(all(view, n => n.attrs['aria-label'] === 'Used by views')[0]), /example\.v_order_list/);
});

// ----- Functions tab sections, important tables, signatures; view page layout -----
const fnGraph = () => {
  const g = graph();
  g.nodes.push({ id: 'example.order_items', schema: 'example', table: 'order_items', state: 'seen', kind: 'table' });
  g.notes = [{ id: 1, status: 'active', kind: 'rule', schema: 'example', table: 'orders', column: null, text: 'Orders are never deleted.' },
    { id: 2, status: 'active', kind: 'observation', schema: 'example', table: 'orders', column: 'status_code', text: 'Mostly open.' }];
  g.functions.push(
    { id: 'example.orders_audit', schema: 'example', name: 'orders_audit', state: 'explored', role: 'trigger', timings: ['after'], triggerTables: ['example.orders'], kinds: ['function'], language: 'plpgsql', flags: {} },
    { id: 'example.orders_check', schema: 'example', name: 'orders_check', state: 'seen', role: 'trigger', timings: ['before', 'after'], triggerTables: ['example.orders', 'example.customers'], kinds: ['function'], language: 'plpgsql', flags: {} },
    { id: 'example.v_guard', schema: 'example', name: 'v_guard', state: 'seen', role: 'trigger', timings: ['instead'], triggerTables: ['example.v_order_list'], kinds: ['function'], language: 'plpgsql', flags: {} },
    { id: 'example.old_trigger', schema: 'example', name: 'old_trigger', state: 'seen', returns: 'trigger', kinds: ['function'], language: 'plpgsql', flags: {} },
    { id: 'example.order_sum', schema: 'example', name: 'order_sum', state: 'seen', kinds: ['aggregate'], language: 'internal', flags: {} });
  return g;
};

test('function roles: role field first, then trigger fallbacks (trigger count, returns trigger), then kinds', () => {
  const ctx = load();
  assert.equal(ctx.fnRoleOf({ role: 'procedure', usedByTriggers: 3 }), 'procedure');
  assert.equal(ctx.fnRoleOf({ usedByTriggers: 1, kinds: ['function'] }), 'trigger');
  assert.equal(ctx.fnRoleOf({ returns: 'trigger' }), 'trigger');
  assert.equal(ctx.fnRoleOf({ returnsTrigger: true }), 'trigger');
  assert.equal(ctx.fnRoleOf({ kinds: ['procedure'] }), 'procedure');
  assert.equal(ctx.fnRoleOf({ kinds: ['function', 'procedure'] }), 'function', 'mixed overloads stay functions');
  assert.equal(ctx.fnRoleOf({}), 'function');
});

test('function sections: trigger functions by timing (a function with two timings in both), then functions, procedures, aggregates', () => {
  const ctx = load();
  const res = ctx.functionSections(fnGraph());
  assert.deepEqual(plain(res.sections.map(s => [s.key, s.count])), [['trigger', 5], ['function', 1], ['procedure', 1], ['aggregate', 1]]);
  const trg = res.sections[0];
  assert.deepEqual(plain(trg.groups.map(g => [g.key, g.items.map(x => x.name)])), [
    ['before', ['orders_check']], ['after', ['orders_audit', 'orders_check']], ['instead', ['v_guard']], ['unknown', ['check_order', 'old_trigger']]]);
  assert.equal(res.listedOnly, true);
  const q = ctx.functionSections(fnGraph(), { query: 'check' });
  assert.deepEqual(plain(q.sections.map(s => s.key)), ['trigger']);
  assert.equal(q.shown, 2);
});

test('important tables: ranked by notes, top columns, reports and explored state; a chip filters to related functions', () => {
  const ctx = load();
  const g = fnGraph();
  const reports = [{ id: 'r1', title: 'R', sql: 'select * from example.customers' }, { id: 'r2', title: 'R2', sql: 'select * from example.customers c' }];
  assert.equal(ctx.tpImportance(g, 'example.orders', []), 2 * 2 + 1, 'two active notes on the table or its columns (2 each), explored (1)');
  assert.equal(ctx.tpImportance(g, 'example.customers', reports), 3 * 2 + 1);
  const imp = ctx.fnImportantTables(g, reports);
  assert.deepEqual(plain(imp.slice(0, 2).map(x => x.id)), ['example.customers', 'example.orders']);
  const orders = imp.find(x => x.id === 'example.orders');
  assert.ok(orders.count >= 3, 'trigger functions and the view caller relate to orders');
  const res = ctx.functionSections(g, { table: 'example.orders' });
  const names = res.sections.flatMap(s => s.groups.flatMap(x => x.items.map(i => i.name)));
  assert.ok(names.includes('orders_audit') && names.includes('orders_check'), 'trigger functions on it');
  assert.ok(names.includes('order_total'), 'called by a view on it');
  assert.ok(!names.includes('v_guard'));
  const both = ctx.functionSections(g, { table: 'example.orders', query: 'audit' });
  assert.equal(both.shown, 1, 'search and chip filter apply together');
  const picked = [];
  const list = ctx.functionList(res, imp, { onOpen() {}, onTable: id => picked.push(id), onSection() {} });
  const chip = byClass(list, 'fn-imp-c').find(c => textOf(c).startsWith('example.orders'));
  assert.equal(chip.attrs['aria-pressed'], 'true');
  chip.attrs.onclick();
  assert.deepEqual(picked, [''], 'clicking the active chip clears the filter');
  assert.ok(all(list, n => n.tag === 'button' && textOf(n).includes('Clear filter')).length === 1);
});

test('function list: compact rows, timing chips and tables for triggers, a quiet dot for listed only, collapsible remembered sections', () => {
  const ctx = load();
  const toggles = [];
  const list = ctx.functionList(ctx.functionSections(fnGraph()), [], { onOpen() {}, onTable() {}, onSection: (k, v) => toggles.push([k, v]), secOpen: { procedure: false } });
  const rows = byClass(list, 'fn-row');
  const checks = rows.filter(r => textOf(r).includes('orders_check'));
  assert.deepEqual(checks.map(r => byClass(r, 'fn-tm').map(textOf)), [['AFTER'], ['BEFORE']], 'in each timing group only the other timing is repeated');
  const check = checks[0];
  assert.match(textOf(check), /on example\.orders, example\.customers/);
  assert.match(check.attrs.class, /listed/);
  assert.equal(byClass(list, 'badge').filter(b => textOf(b) === 'listed only').length, 0, 'no listed-only badge on rows');
  assert.equal(byClass(list, 'fn-legend').length, 1, 'one legend line');
  const proc = byClass(list, 'fn-sec').find(s => s.attrs['aria-label'] === 'Procedures');
  assert.match(proc.attrs.class, /closed/);
  const btn = byClass(proc, 'fn-sec-b')[0];
  assert.equal(btn.attrs['aria-expanded'], 'false');
  btn.attrs.onclick();
  assert.deepEqual(toggles, [['procedure', true]]);
  assert.match(page, /fnSecOpen: state\.fnSecOpen/, 'section state is persisted');
});

test('signature: a long RETURNS TABLE is clamped with a toggle; open, its columns are a list', () => {
  const ctx = load();
  const cols = Array.from({ length: 30 }, (_, i) => `col_${i} numeric(12,2)`);
  assert.deepEqual(plain(ctx.fnTableColumns('TABLE(a integer, b numeric(12,2), c text)')), ['a integer', 'b numeric(12,2)', 'c text']);
  assert.equal(ctx.fnTableColumns('numeric'), null);
  const rec = { schema: 'example', name: 'order_report', describedAt: 'x', overloads: [ov({ arguments: 'p_from date, p_to date', returns: `TABLE(${cols.join(', ')})` })] };
  const m = ctx.functionPageModel(graph(), 'example.order_report', rec);
  const sigs = [];
  const closed = ctx.functionPageView(m, ['x'], ctxOf({ reports: { items: [] }, onSigOpen: (k, v) => sigs.push([k, v]) }));
  const sig = byClass(closed, 'fn-sig')[0];
  assert.match(sig.attrs.class, /clamp/);
  assert.match(textOf(sig), /TABLE \(30 columns\)/);
  assert.equal(byClass(closed, 'fn-cols').length, 0);
  byClass(closed, 'fn-sig-more')[0].attrs.onclick();
  assert.deepEqual(sigs, [['example.order_report#0', true]]);
  const open = ctx.functionPageView(m, ['x'], ctxOf({ reports: { items: [] }, sigOpen: { 'example.order_report#0': true } }));
  assert.doesNotMatch(byClass(open, 'fn-sig')[0].attrs.class, /clamp/);
  assert.equal(all(byClass(open, 'fn-cols')[0], n => n.tag === 'li').length, 30);
  // Short signatures have no toggle; flags sit in one row with the kind badge.
  const short = ctx.functionPageView(ctx.functionPageModel(graph(), 'example.order_total', fnRec()), ['x'], ctxOf({ reports: { items: [] } }));
  assert.equal(byClass(short, 'fn-sig-more').length, 0);
  const row = byClass(byClass(short, 'fn-ov')[0], 'fn-flags')[0];
  assert.ok(byClass(row, 'kind-fn').length === 1 && byClass(row, 'fn-chips').length === 1);
});

test('a trigger function shows its triggers first: table, timing, events, level', () => {
  const ctx = load();
  const rec = { schema: 'example', name: 'check_order', describedAt: 'x', overloads: [ov({ arguments: '', returns: 'trigger', config: ['search_path=example'],
    usedByTriggers: [{ table: 'example.orders', schema: 'example', tableName: 'orders', trigger: 'orders_check_status', timing: 'BEFORE', events: ['INSERT', 'UPDATE'], level: 'row' }] })] };
  const m = ctx.functionPageModel(graph(), 'example.check_order', rec);
  const view = ctx.functionPageView(m, ['x'], ctxOf({ reports: { items: [] } }));
  const main = byClass(view, 'tp-main')[0];
  assert.match(main.kids[0].attrs.class, /fn-trg/, 'the trigger panel comes first');
  const text = textOf(main.kids[0]);
  assert.match(text, /example\.orders/);
  assert.match(text, /BEFORE/);
  assert.match(text, /INSERT OR UPDATE/);
  assert.match(text, /for each row/);
});

test('view page: the description comes first, the SQL stays collapsed behind Show SQL', () => {
  const ctx = load();
  const g = graph();
  g.notes = [{ id: 7, status: 'active', kind: 'rule', schema: 'example', table: 'v_order_list', column: null, text: 'Open orders for the sales screen.' },
    { id: 8, status: 'active', kind: 'observation', schema: 'example', table: 'v_order_list', column: 'total', text: 'Column note, not shown here.' }];
  const rec = { ...viewRec(), comment: 'Open orders with totals' };
  const shown = [];
  for (const mode of ['detail', 'summary']) {
    const view = ctx.tablePageView(ctx.tablePageModel(g, 'example.v_order_list', rec), ['x'], ctxOf({ view: mode, reports: { items: [] }, onSqlShown: v => shown.push(v), onView() {}, onColumn() {}, onUnused() {} }));
    const about = byClass(view, 'tp-about')[0];
    const def = byClass(view, 'tp-def-panel')[0];
    const order = all(view, n => n === about || n === def);
    assert.deepEqual(order.map(n => n.attrs.class.split(' ')[1]), ['tp-about', 'tp-def-panel'], `${mode}: description before SQL`);
    assert.match(textOf(about), /Open orders with totals/);
    assert.match(textOf(about), /Open orders for the sales screen/);
    assert.doesNotMatch(textOf(about), /Column note/);
    assert.equal(all(def, n => n.tag === 'pre').length, 0, `${mode}: SQL collapsed`);
    const btn = byClass(def, 'tp-sql-btn')[0];
    assert.equal(btn.attrs['aria-expanded'], 'false');
    assert.match(textOf(btn), /Show SQL \(3 lines\)/);
    btn.attrs.onclick();
  }
  assert.deepEqual(shown, [true, true]);
  const none = ctx.tablePageView(ctx.tablePageModel(graph(), 'example.v_order_list', viewRec()), ['x'], ctxOf({ reports: { items: [] } }));
  assert.match(textOf(byClass(none, 'tp-about')[0]), /No description yet/);
});

test('view columns: summary shows 4–5 only (scored) or the first 24 (unscored) with a show-all toggle; detail limits an unscored view too', () => {
  const ctx = load();
  const many = Array.from({ length: 300 }, (_, i) => ({ name: `c${String(i).padStart(3, '0')}`, type: 'text' }));
  const rec = { ...viewRec(), columns: many };
  const sumCtx = extra => ctxOf({ view: 'summary', reports: { items: [] }, onView() {}, onColumn() {}, onUnused() {}, ...extra });
  const colGroup = v => byClass(v, 'sum-group').find(x => /^Columns/.test(x.attrs['aria-label']));
  const unscored = ctx.tablePageView(ctx.tablePageModel(graph(), 'example.v_order_list', rec), ['x'], sumCtx());
  assert.equal(byClass(colGroup(unscored), 'c-s0').length, 24);
  const toggles = [];
  const more = byClass(colGroup(unscored), 'c-more').find(c => /Show all 300 columns/.test(textOf(c)));
  assert.ok(more);
  const all300 = ctx.tablePageView(ctx.tablePageModel(graph(), 'example.v_order_list', rec), ['x'], sumCtx({ showAll: true, onShowAll: v => toggles.push(v) }));
  assert.equal(byClass(colGroup(all300), 'c-s0').length, 300);
  const g = graph();
  g.nodes.find(n => n.id === 'example.v_order_list').columnScores = { c010: { agent: { score: 5, roles: [], reason: 'r', sources: 2, at: 'a', history: [] } },
    c020: { agent: { score: 4, roles: [], reason: 'r', sources: 1, at: 'a', history: [] } }, c030: { agent: { score: 2, roles: [], reason: 'r', sources: 1, at: 'a', history: [] } } };
  const scored = ctx.tablePageView(ctx.tablePageModel(g, 'example.v_order_list', rec), ['x'], sumCtx());
  assert.deepEqual(byClass(colGroup(scored), 'sum-chip').filter(c => !/c-more/.test(c.attrs.class)).map(textOf), ['c010', 'c020']);
  const detail = ctx.tablePageView(ctx.tablePageModel(graph(), 'example.v_order_list', rec), ['x'], ctxOf({ reports: { items: [] } }));
  assert.equal(byClass(detail, 'tp-cname').length, 24);
  assert.ok(all(detail, n => n.tag === 'button' && textOf(n) === 'Show all 300 columns').length === 1);
  // Tables keep their old behaviour: an unscored table lists every column.
  const table = ctx.tablePageModel(graph(), 'example.orders', { describedAt: 'x', kind: 'table', columns: many, constraints: [], history: [] });
  assert.equal(byClass(ctx.tablePageView(table, ['x'], ctxOf()), 'tp-cname').length, 300);
});

test('view sources: the most important first; more than 12 sit behind a toggle', () => {
  const ctx = load();
  const g = graph();
  const srcs = Array.from({ length: 20 }, (_, i) => ({ schema: 'example', table: `s${String(i).padStart(2, '0')}`, kind: 'table', columns: [] }));
  g.nodes.push(...srcs.map(s => ({ id: `example.${s.table}`, schema: 'example', table: s.table, state: 'seen', kind: 'table' })));
  g.notes = [{ id: 1, status: 'active', kind: 'rule', schema: 'example', table: 's19', column: null, text: 'Key table.' }];
  const m = ctx.tablePageModel(g, 'example.v_order_list', { ...viewRec(), viewSources: srcs });
  assert.equal(m.view.sources[0].id, 'example.s19');
  const opened = [];
  const view = ctx.tablePageView(m, ['x'], ctxOf({ reports: { items: [] }, moreOpen: {}, onMore: (k, v) => opened.push([k, v]) }));
  const left = byClass(view, 'tp-refs')[0];
  assert.equal(byClass(left, 'tp-nb').length, 12);
  byClass(left, 'tp-rel-more')[0].attrs.onclick();
  assert.deepEqual(opened, [['panel-refs', true]]);
});

test('a table page and a view page alive at once have their own search ids; "/" picks the active tab\'s box', () => {
  const ctx = load();
  const table = ctx.tablePageView(ctx.tablePageModel(graph(), 'example.orders', { describedAt: 'x', kind: 'table', columns: [{ name: 'order_id', type: 'bigint' }], constraints: [], history: [] }), ['x'], ctxOf());
  const view = ctx.tablePageView(ctx.tablePageModel(graph(), 'example.v_order_list', viewRec()), ['x'], ctxOf({ searchId: 'tpSearch-views', reports: { items: [] } }));
  const ids = [...all(table, n => n.tag === 'input'), ...all(view, n => n.tag === 'input')].map(n => n.attrs.id);
  assert.deepEqual(ids, ['tpSearch', 'tpSearch-views']);
  const tabs = loadTabs();
  const present = new Set(['tpSearch', 'tpSearch-views']);
  const byId = id => (present.has(id) ? id : null);
  assert.equal(tabs.slashTarget('schema', byId), 'tpSearch');
  assert.equal(tabs.slashTarget('views', byId), 'tpSearch-views');
  present.delete('tpSearch-views'); present.add('viewsSearch'); present.add('functionsSearch');
  assert.equal(tabs.slashTarget('views', byId), 'viewsSearch', 'the list search when no view page is open');
  assert.equal(tabs.slashTarget('functions', byId), 'functionsSearch');
  assert.equal(tabs.slashTarget('reports', byId), null);
  assert.match(page, /searchId: searchIdOf\(tab\),\s*\}\)\), tpQPending, searchIdOf\(tab\)\);/, 'the redraw keeps focus in the same tab\'s box');
  assert.match(page, /\(slashTarget\(state\.tab, \$\) \|\| F\.text\)\.focus\(\)/);
});

test('a clipped code box builds only its visible lines; opened, the whole text', () => {
  const ctx = load();
  const sql = Array.from({ length: 5000 }, (_, i) => `select ${i}`).join('\n');
  const seen = [];
  const highlight = text => { seen.push(text.split('\n').length); return text.split('\n').map(l => h('div', { class: 'sq-line' }, l)); };
  const clipped = ctx.tpCode(sql, { id: 'x', label: 'L', open: false, onToggle() {} }, { highlight });
  assert.equal(byClass(clipped, 'sq-line').length, 24);
  assert.match(textOf(byClass(clipped, 'code-more')[0]), /Show all 5000 lines/);
  const open = ctx.tpCode(sql, { id: 'x', label: 'L', open: true, onToggle() {} }, { highlight });
  assert.equal(byClass(open, 'sq-line').length, 5000);
  assert.deepEqual(seen, [24, 5000]);
});

test('important tables: only the 30 tables with the most related functions are scored; results stay ranked by score', () => {
  const ctx = load();
  const g = { profile: 'exampledb', notes: [], edges: [], nodes: [], functions: [] };
  for (let i = 0; i < 40; i++) {
    const id = `example.t${String(i).padStart(2, '0')}`;
    g.nodes.push({ id, schema: 'example', table: `t${String(i).padStart(2, '0')}`, state: 'seen', kind: 'table' });
    for (let k = 0; k <= i % 5; k++) g.functions.push({ id: `example.f${i}_${k}`, schema: 'example', name: `f${i}_${k}`, touches: { reads: [id], writes: [] } });
  }
  // A table with few functions but many notes falls outside the candidates.
  g.notes = Array.from({ length: 5 }, (_, i) => ({ id: i, status: 'active', kind: 'rule', schema: 'example', table: 't00', column: null, text: 'x' }));
  const reports = [{ id: 'r', key: 'k1', sql: 'select * from example.t04 -- example.t09' }];
  const imp = ctx.fnImportantTables(g, reports);
  assert.equal(imp.length, 10);
  assert.ok(!imp.some(x => x.id === 'example.t00'), 't00 has one function: not a candidate');
  assert.equal(imp[0].id, 'example.t04', 'the report mention (3) ranks first; the commented one does not count');
  assert.ok(imp.every(x => x.count >= 4));
});

test('a table filter always offers Clear filter, even without chips; a database switch resets the list filters', () => {
  const ctx = load();
  const res = ctx.functionSections(graph(), { table: 'example.orders' });
  const cleared = [];
  const list = ctx.functionList(res, [], { onOpen() {}, onTable: id => cleared.push(id), onSection() {} });
  const btn = all(list, n => n.tag === 'button' && textOf(n).includes('Clear filter'))[0];
  assert.ok(btn, 'Clear filter without important-table chips');
  btn.attrs.onclick();
  assert.deepEqual(cleared, ['']);
  assert.match(page, /function setDb\(db, \{ render: doRender = true \} = \{\}\) \{\s*\/\/[^\n]*\s*if \(state\.db !== db\) state\.objFilter = \{\};/);
});

test('#140: a view described again with another source leaves the old table\'s Used by views; undescribed views keep their entry', () => {
  const ctx = load();
  const g = { profile: 'exampledb', notes: [], functions: [],
    nodes: [
      { id: 'example.orders', schema: 'example', table: 'orders', state: 'explored', kind: 'table' },
      { id: 'example.orders_archive', schema: 'example', table: 'orders_archive', state: 'explored', kind: 'table' },
      // Described again after the orders file: it now reads orders_archive only.
      { id: 'example.order_view', schema: 'example', table: 'order_view', state: 'explored', kind: 'view', viewSources: ['example.orders_archive'], describedAt: '2026-10-03T00:00:00Z' },
      // Known only from the snapshot (old memory, no view facts): kept.
      { id: 'example.v_old', schema: 'example', table: 'v_old', state: 'seen', kind: 'view' },
    ],
    edges: [{ from: 'example.order_view', to: 'example.orders_archive', level: 'view', columns: ['id'], refColumns: [] }] };
  const rec = { describedAt: '2026-10-01T00:00:00Z', kind: 'table', columns: [], constraints: [], history: [],
    usedByViews: [{ schema: 'example', table: 'order_view', kind: 'view' }, { schema: 'example', table: 'v_old', kind: 'view' }] };
  const m = ctx.tablePageModel(g, 'example.orders', rec);
  assert.deepEqual(plain(m.usedByViews.map(v => v.id)), ['example.v_old']);
  assert.deepEqual(plain(ctx.tablePageModel(g, 'example.orders_archive', { ...rec, usedByViews: [] }).usedByViews.map(v => v.id)), ['example.order_view']);
  // A view node described after this file, without view facts, also supersedes.
  g.nodes[3].describedAt = '2026-10-05T00:00:00Z';
  assert.deepEqual(plain(ctx.tablePageModel(g, 'example.orders', rec).usedByViews.map(v => v.id)), []);
  // Still listing the table: kept.
  g.nodes[2].viewSources = ['example.orders', 'example.orders_archive'];
  assert.deepEqual(plain(ctx.tablePageModel(g, 'example.orders', { ...rec, usedByViews: [rec.usedByViews[0]] }).usedByViews.map(v => v.id)), ['example.order_view']);
});

test('#140: a view recorded before the table keeps the table\'s newer snapshot entry; viewSources alone never drop it', () => {
  const ctx = load();
  // The view was described reading A, then redefined to read B; only B was
  // described again, so B's snapshot is newer than the view's old record.
  const g = { profile: 'exampledb', notes: [], functions: [], edges: [],
    nodes: [
      { id: 'example.orders', schema: 'example', table: 'orders', state: 'explored', kind: 'table' },
      { id: 'example.orders_archive', schema: 'example', table: 'orders_archive', state: 'explored', kind: 'table' },
      { id: 'example.order_view', schema: 'example', table: 'order_view', state: 'explored', kind: 'view', viewSources: ['example.orders'], describedAt: '2026-10-01T00:00:00Z' },
    ] };
  const rec = { describedAt: '2026-10-05T00:00:00Z', kind: 'table', columns: [], constraints: [], history: [], usedByViews: [{ schema: 'example', table: 'order_view', kind: 'view' }] };
  assert.deepEqual(plain(ctx.tablePageModel(g, 'example.orders_archive', rec).usedByViews.map(v => v.id)), ['example.order_view'], 'view recorded before the table');
  delete g.nodes[2].describedAt;
  assert.deepEqual(plain(ctx.tablePageModel(g, 'example.orders_archive', rec).usedByViews.map(v => v.id)), ['example.order_view'], 'no view timestamp: kept');
  g.nodes[2].describedAt = '2026-10-09T00:00:00Z';
  assert.deepEqual(plain(ctx.tablePageModel(g, 'example.orders_archive', { ...rec, describedAt: undefined }).usedByViews.map(v => v.id)), ['example.order_view'], 'no table timestamp: kept');
  assert.deepEqual(plain(ctx.tablePageModel(g, 'example.orders_archive', rec).usedByViews.map(v => v.id)), [], 'view described later without it: dropped');
});

test('#141: quoted RETURNS TABLE names keep their commas, parentheses and "" escapes; count and list agree', () => {
  const ctx = load();
  const returns = 'TABLE("gross,total" numeric, quantity integer, subtotal numeric, tax numeric, discount numeric)';
  assert.deepEqual(plain(ctx.fnTableColumns(returns)), ['"gross,total" numeric', 'quantity integer', 'subtotal numeric', 'tax numeric', 'discount numeric']);
  assert.deepEqual(plain(ctx.fnTableColumns('TABLE("a (x, y)" numeric(12,2), "say ""hi, there""" text, b integer)')),
    ['"a (x, y)" numeric(12,2)', '"say ""hi, there""" text', 'b integer']);
  const rec = { schema: 'example', name: 'orderSummary', describedAt: 'x', overloads: [ov({ arguments: '', returns: returns.replace('TABLE(', 'TABLE(') + '' })] };
  rec.overloads[0].returns = `TABLE(${Array.from({ length: 5 }, (_, i) => (i ? `c${i} numeric` : '"gross,total" numeric')).join(', ')})`;
  const m = ctx.functionPageModel(graph(), 'example."orderSummary"', rec);
  const closed = ctx.functionPageView(m, ['x'], ctxOf({ reports: { items: [] } }));
  assert.match(textOf(byClass(closed, 'fn-sig')[0]), /TABLE \(5 columns\)/);
  const open = ctx.functionPageView(m, ['x'], ctxOf({ reports: { items: [] }, sigOpen: { 'example."orderSummary"#0': true } }));
  const items = all(byClass(open, 'fn-cols')[0], n => n.tag === 'li').map(textOf);
  assert.equal(items.length, 5);
  assert.equal(items[0], '"gross,total" numeric');
});

test('#142: trigger functions in two timing groups count once; nothing below the limit disappears, a cut group says so', () => {
  const ctx = load();
  const fns = Array.from({ length: 200 }, (_, i) => ({ id: `example.trg_${String(i).padStart(3, '0')}`, schema: 'example', name: `trg_${String(i).padStart(3, '0')}`,
    state: 'seen', role: 'trigger', timings: ['after', 'before'], triggerTables: ['example.orders'], kinds: ['function'], language: 'plpgsql', flags: {} }));
  fns.push({ id: 'example."orderTotal"', schema: 'example', name: 'orderTotal', state: 'seen', kinds: ['function'], language: 'sql', flags: {} });
  const g = { profile: 'exampledb', nodes: [{ id: 'example.orders', schema: 'example', table: 'orders', state: 'explored', kind: 'table' }], edges: [], notes: [], functions: fns };
  const res = ctx.functionSections(g);
  assert.equal(res.shown, 201);
  const list = ctx.functionList(res, [], { onOpen() {}, onTable() {}, onSection() {} });
  assert.equal(byClass(list, 'fn-row').length, 401, '200 functions in two groups and orderTotal');
  assert.ok(byClass(list, 'fn-row').some(r => textOf(r).includes('orderTotal()')), 'the ordinary function is not hidden');
  assert.equal(byClass(list, 'fn-cut').length, 0);
  // Over the limit: the cut group names what it leaves out, and the overall notice shows.
  const many = { ...g, functions: [...fns, ...Array.from({ length: 300 }, (_, i) => ({ id: `example.calc_${i}`, schema: 'example', name: `calc_${String(i).padStart(3, '0')}`, state: 'seen', kinds: ['function'], language: 'sql', flags: {} }))] };
  const res2 = ctx.functionSections(many);
  const list2 = ctx.functionList(res2, [], { onOpen() {}, onTable() {}, onSection() {} });
  const rowIds = new Set(byClass(list2, 'fn-row').map(r => textOf(byClass(r, 'obj-nm')[0])));
  const cut = byClass(list2, 'fn-cut').map(textOf);
  assert.equal(rowIds.size, 400, 'the budget counts unique functions');
  assert.deepEqual(cut, ['101 more not shown; search to narrow the list.']);
  assert.match(textOf(list2), /First 400 shown/);
});

test('layout: the returned-columns list scrolls down only, never sideways', () => {
  const rule = page.match(/\.fn-cols \{[^}]*\}/)?.[0];
  assert.ok(rule, '.fn-cols rule found');
  assert.match(rule, /overflow-x: hidden/);
  assert.match(rule, /overflow-y: auto/);
  assert.match(rule, /display: grid/);
  assert.doesNotMatch(rule, /[\s;{]columns:/, 'no CSS columns with a height limit');
});
