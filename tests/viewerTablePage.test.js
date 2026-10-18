import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { seedExampleMemory } from './fixtures/exampleMemory.js';

// The table page blocks of src/viewer.html in isolation: the model built from
// graph.json and a table file (table-page) rendered with a recording h(), and
// the user score request (column-score, with stageError from stage-change).
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const blockOf = name => page.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`))?.[0];
const pageTr = (() => {
  const src = page.match(/const TR = (\{[\s\S]*?\n\});/)[1];
  return vm.runInNewContext(`(${src})`);
})();

let home, data, recs;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-table-page-'));
  let clock = 0;
  seedExampleMemory(path.join(home, 'memory'), 'exampledb', { now: () => new Date(Date.UTC(2026, 9, 1) + (clock++) * 3600000).toISOString() });
  const dir = path.join(home, 'memory', 'exampledb');
  data = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
  recs = Object.fromEntries(data.nodes.filter(n => n.file).map(n => [n.id, JSON.parse(fs.readFileSync(path.join(dir, ...n.file.split('/')), 'utf8'))]));
});
after(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); });

// A recording h(): { tag, attrs, kids }; text nodes stay plain strings.
const h = (tag, attrs = {}, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false) });
const textOf = n => (typeof n === 'string' || typeof n === 'number' ? String(n) : n ? n.kids.map(textOf).join('') : '');
const all = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); n.kids.forEach(k => all(k, pred, out)); } return out; };
const byClass = (n, cls) => all(n, x => String(x.attrs.class || '').split(/\s+/).includes(cls));
// What a browser would show for this tree: text escaped, attributes quoted.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const html = n => (typeof n === 'string' || typeof n === 'number' ? esc(n) : `<${n.tag}${Object.entries(n.attrs).filter(([k, v]) => typeof v !== 'function' && v !== null && v !== undefined && v !== false).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${n.kids.map(html).join('')}</${n.tag}>`);

function load(lang = 'en') {
  for (const name of ['table-page', 'stage-change', 'column-score']) assert.ok(blockOf(name), `${name} block found`);
  const context = vm.createContext({
    JSON, h, svg: h, locale: lang === 'tr' ? 'tr-TR' : 'en-GB', fmt: n => String(n), compact: n => `~${n}`,
    ruleDay: ts => (ts ? String(ts).slice(0, 10) : '?'), changeLabel: c => c.change,
  });
  vm.runInContext(`${page.match(/const foldText = .*;/)[0]}
${blockOf('table-page')}
const TR = Object.assign({}, ${JSON.stringify(pageTr)});
for (const [k, v] of Object.entries(tablePageTr)) if (!Object.hasOwn(TR, k)) TR[k] = v;
const t = (en, vars = {}) => String(${JSON.stringify(lang)} === 'tr' && TR[en] !== undefined ? TR[en] : en).replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] ?? '');
${blockOf('stage-change')}
${blockOf('column-score')}
Object.assign(this, { tablePageModel, tpVisibleColumns, tablePageView, tpLegend, tpLoadRec, tpLoadError, tablePageTr, scoreStepLabels, scoreStepTexts, tpRoleTexts, TR, t,
  userScoreRequest, userScoreProblem, postColumnScore, invokeColumnScore });`, context);
  return context;
}
const plain = obj => JSON.parse(JSON.stringify(obj));
const model = (ctx, id) => ctx.tablePageModel(data, id, recs[id] ?? null);
const calls = [];
const viewCtx = (extra = {}) => ({ open: null, showAll: false, canScore: true, onOpen: id => calls.push(['open', id]), onToggle: n => calls.push(['toggle', n]),
  onShowAll: v => calls.push(['all', v]), onScore: c => calls.push(['score', c.name]), onBack: () => calls.push(['back']), onClose: () => calls.push(['close']), onCrumb: i => calls.push(['crumb', i]), ...extra });
const render = (ctx, id, extra) => ctx.tablePageView(model(ctx, id), ['example.customers', id], viewCtx(extra));
const rowNames = view => byClass(view, 'tp-cname').map(textOf);

test('ties in score are ranked by sources (desc), then name', () => {
  const ctx = load();
  const agent = (score, sources) => ({ agent: { score, roles: ['join'], reason: 'r', sources, at: '2026-10-01T00:00:00Z', history: [] } });
  const g = { profile: 'exampledb', nodes: [{ id: 'example.orders', schema: 'example', table: 'orders', state: 'explored',
    columnScores: { amount: agent(5, 14), order_id: agent(5, 25), created_at: agent(5, 14), status_code: agent(3, 40) } }], edges: [], notes: [] };
  const rec = { describedAt: '2026-10-01T00:00:00Z', columns: ['amount', 'order_id', 'created_at', 'status_code'].map(name => ({ name, type: 'text' })), constraints: [], history: [] };
  assert.deepEqual(plain(ctx.tablePageModel(g, 'example.orders', rec).columns.map(c => c.name)), ['order_id', 'amount', 'created_at', 'status_code']);
});

test('a user score shows its own roles, never the agent roles, even when it has none', () => {
  const ctx = load();
  const g = { profile: 'exampledb', nodes: [{ id: 'example.orders', schema: 'example', table: 'orders', state: 'explored', columnScores: {
    amount: { agent: { score: 2, roles: ['aggregate', 'display'], reason: 'r', sources: 1, at: 'a', history: [] }, user: { score: 4, roles: [], at: 'b', history: [] } },
    order_id: { agent: { score: 2, roles: ['key'], reason: 'r', sources: 1, at: 'a', history: [] }, user: { score: 3, at: 'b', history: [] } } } }], edges: [], notes: [] };
  const rec = { describedAt: 'x', columns: [{ name: 'amount' }, { name: 'order_id' }], constraints: [], history: [] };
  const cols = ctx.tablePageModel(g, 'example.orders', rec).columns;
  assert.deepEqual(plain(cols.map(c => [c.name, c.scoreBy, c.roles])), [['amount', 'user', []], ['order_id', 'user', []]]);
});

test('a table file that fails to load is not cached and shows an error with Retry, not "not described"', async () => {
  const ctx = load();
  const cache = new Map();
  let calls = 0;
  await assert.rejects(ctx.tpLoadRec(async () => { calls++; throw new Error('File not found'); }, cache, 'k'), /File not found/);
  await assert.rejects(ctx.tpLoadRec(async () => { calls++; return null; }, cache, 'k'), /could not be read/);
  assert.equal(cache.size, 0, 'failures are never cached');
  const rec = await ctx.tpLoadRec(async () => { calls++; return recs['example.orders']; }, cache, 'k');
  assert.equal(rec.table, 'orders');
  assert.equal(await ctx.tpLoadRec(async () => { throw new Error('not called'); }, cache, 'k'), rec, 'a success is cached');
  assert.equal(calls, 3);
  const retry = [];
  const view = ctx.tpLoadError('example.orders', 'File not found', ['example.orders'], viewCtx({ onRetry: () => retry.push(1) }));
  assert.match(textOf(view), /The table file of example\.orders could not be loaded: File not found/);
  assert.doesNotMatch(textOf(view), /Not described yet/);
  assert.equal(all(view, n => n.attrs.role === 'alert').length, 1);
  all(view, n => n.tag === 'button' && textOf(n) === 'Retry')[0].attrs.onclick();
  assert.equal(retry.length, 1);
  assert.match(blockOf('table-page'), /never\s+cached|never cached/);
});

test('columns are sorted by effective score, then sources, then name; unscored last', () => {
  const m = model(load(), 'example.orders');
  assert.deepEqual(plain(m.columns.map(c => [c.name, c.score])), [
    ['created_at', 5], ['order_id', 5], ['status_code', 5], ['customer_id', 4], ['amount', 3], ['delivered_at', 1], ['<script>x</script>', null], ['teslim_durum_kodu', null],
  ]);
  const status = m.columns.find(c => c.name === 'status_code');
  assert.deepEqual([status.scoreBy, status.user.score, status.agent.score], ['user', 5, 2], 'the user score wins');
  assert.deepEqual([...status.roles], ['filter', 'display'], 'roles of the effective layer');
  assert.deepEqual([m.scored, m.sourcesMax, m.noteCount, m.columnCount, m.estimatedRows], [true, 7, 2, 8, 120000]);
});

test('default filter shows scores 4-5 with a counter; one click shows all', () => {
  const ctx = load();
  calls.length = 0;
  const view = render(ctx, 'example.orders');
  assert.deepEqual(rowNames(view), ['created_at', 'order_id', 'status_code', 'customer_id']);
  assert.match(textOf(view), /4 of 8 columns scored 4–5/);
  const toggle = all(view, n => n.tag === 'button' && textOf(n) === 'Show all columns')[0];
  assert.equal(toggle.attrs['aria-pressed'], 'false');
  toggle.attrs.onclick();
  assert.deepEqual(calls.at(-1), ['all', true]);
  const full = render(ctx, 'example.orders', { showAll: true });
  assert.equal(rowNames(full).length, 8);
  assert.match(textOf(full), /8 columns/);
});

test('rows: single-hue score chip, monospace name, type, roles with tooltips, reason, report count, user · agent', () => {
  const ctx = load();
  calls.length = 0;
  const view = render(ctx, 'example.orders', { showAll: true });
  const chips = byClass(view, 'tp-cols')[0].kids.map(col => byClass(col, 'score-chip')[0]);
  assert.deepEqual(chips.map(c => c.attrs.class), ['score-chip s5', 'score-chip s5', 'score-chip s5', 'score-chip s4', 'score-chip s3', 'score-chip s1', 'score-chip s0', 'score-chip s0']);
  assert.deepEqual(chips.map(textOf), ['5', '5', '5', '4', '3', '1', '–', '–'], 'the number inside');
  assert.equal(chips[0].tag, 'button');
  chips[2].attrs.onclick({ stopPropagation() {} });
  assert.deepEqual(calls.at(-1), ['score', 'status_code']);
  const statusRow = byClass(view, 'tp-col')[2];
  assert.match(textOf(statusRow), /user 5 · agent 2/);
  assert.match(textOf(statusRow), /Filtered in one report <i>only<\/i>/);
  assert.match(textOf(statusRow), /1 report$/);
  const roles = byClass(statusRow, 'tp-role');
  assert.deepEqual(roles.map(r => r.attrs.title), ['filter: WHERE or HAVING', 'display: SELECT list']);
  assert.ok(roles.every(r => r.attrs.role === 'img' && r.attrs['aria-label']));
  const created = byClass(view, 'tp-col')[0];
  assert.match(textOf(created), /timestamp with time zone NOT NULL/);
  assert.match(textOf(created), /7 reports/);
  // CSS: the five steps mix only the accent into the surface; no traffic-light tokens.
  const chipCss = page.match(/\.score-chip\.s[1-5] \{[^}]*\}/g);
  assert.equal(chipCss.length, 5);
  assert.ok(chipCss.every(r => /var\(--accent\)/.test(r) && !/--good|--critical|--warn/.test(r)));
  // Not scorable: a plain chip, no button.
  const ro = render(ctx, 'example.orders', { canScore: false });
  assert.ok(byClass(ro, 'score-chip').every(c => c.tag === 'span'));
});

test('the legend explains each step with the rubric', () => {
  const ctx = load();
  const legend = ctx.tpLegend();
  const steps = byClass(legend, 'tp-step');
  assert.deepEqual(steps.map(s => textOf(s.kids[0])), ['5', '4', '3', '2', '1']);
  assert.deepEqual(steps.map(s => textOf(s.kids[1])), ['core', 'frequent', 'topical', 'rare', 'unused']);
  assert.match(textOf(steps[0]), /main join key, period filter, primary display field/);
  assert.match(textOf(steps[4]), /appears in no SQL/);
});

test('an expanded row shows both layer histories, notes, the FK target, default and comment', () => {
  const ctx = load();
  calls.length = 0;
  let view = render(ctx, 'example.orders', { open: 'status_code' });
  const detail = byClass(view, 'tp-detail')[0];
  assert.ok(detail, 'expanded');
  const [user, agent] = byClass(detail, 'tp-hist');
  assert.deepEqual(user.kids.map(li => textOf(li.kids[2])), ['5']);
  assert.match(textOf(agent), /Filtered in one report/);
  assert.match(textOf(detail), /Mostly in WHERE, sometimes in SELECT <u>lists<\/u>\./);
  assert.match(textOf(detail), /Default 'new'::text/);
  const btn = byClass(view, 'tp-cname').find(b => textOf(b) === 'status_code');
  assert.equal(btn.attrs['aria-expanded'], 'true');
  btn.attrs.onclick({ stopPropagation() {} });
  assert.deepEqual(calls.at(-1), ['toggle', null]);
  view = render(ctx, 'example.orders', { open: 'customer_id' });
  const fk = all(byClass(view, 'tp-detail')[0], n => n.tag === 'button' && textOf(n) === 'example.customers.customer_id')[0];
  fk.attrs.onclick();
  assert.deepEqual(calls.at(-1), ['open', 'example.customers']);
  view = ctx.tablePageView(model(ctx, 'example.orders'), ['example.orders'], viewCtx({ showAll: true, open: 'amount' }));
  assert.match(textOf(byClass(view, 'tp-detail')[0]), /Comment Total in the order currency/);
});

test('keys and structure: primary, unique, check, outgoing and incoming FKs, indexes', () => {
  const ctx = load();
  const text = textOf(render(ctx, 'example.orders'));
  for (const s of ['PRIMARY KEY (order_id)', 'UNIQUE (order_id, status_code)', 'CHECK (amount >= 0)', 'customer_id → example.customers.customer_id',
    'example.order_items.order_id → order_id', 'example.shipments.order_id → order_id', 'CREATE INDEX orders_created_at_idx ON example.orders USING btree (created_at)']) {
    assert.ok(text.includes(s), s);
  }
});

test('triggers: timing and events, level, enabled, function, WHEN, summary; a stale summary is marked', () => {
  const ctx = load();
  const view = render(ctx, 'example.orders');
  const items = byClass(view, 'tp-trg')[0].kids;
  assert.equal(items.length, 2);
  const [check, log] = items.map(textOf);
  assert.match(check, /orders_check_status.*BEFORE INSERT OR UPDATE.*for each ROW.*enabled/);
  assert.match(check, /Rejects rows whose status_code is not in example\.status_codes.*may be out of date/);
  assert.match(log, /AFTER DELETE.*disabled/);
  assert.match(log, /Function example\.log_order\(\)/);
  assert.match(log, /WHEN \(old\.amount > 0\)/);
  assert.doesNotMatch(log, /may be out of date/);
});

test('neighbours: references left, referenced-by right, unexplored ones muted; a card opens its page', () => {
  const ctx = load();
  calls.length = 0;
  const m = model(ctx, 'example.orders');
  assert.deepEqual(plain(m.neighbours.refs.map(n => [n.id, n.explored, n.estRows])), [['example.customers', true, 5400]]);
  assert.deepEqual(plain(m.neighbours.deps.map(n => [n.id, n.explored])), [['example.order_items', false], ['example.shipments', false]]);
  const view = render(ctx, 'example.orders');
  const left = byClass(view, 'tp-refs')[0], right = byClass(view, 'tp-deps')[0];
  assert.match(textOf(left), /example\.customers.*customer_id → customer_id.*~5400/);
  const cards = byClass(right, 'tp-nb');
  assert.ok(cards.every(c => c.attrs.class.includes('muted-card')));
  assert.match(textOf(cards[0]), /not explored yet/);
  cards[1].attrs.onclick();
  assert.deepEqual(calls.at(-1), ['open', 'example.shipments']);
  // The breadcrumb: Back, Schema and each visited table; the last is the current page.
  const crumbs = byClass(view, 'tp-crumbs')[0];
  assert.match(textOf(crumbs), /Back.*Schema.*example\.customers.*example\.orders/);
  all(crumbs, n => n.tag === 'button' && textOf(n) === 'example.customers')[0].attrs.onclick();
  assert.deepEqual(calls.at(-1), ['crumb', 0]);
  assert.equal(all(crumbs, n => n.attrs['aria-current'] === 'page').map(textOf)[0], 'example.orders');
});

test('header: name, rows, columns, notes, comment, last scored, sources and the change badge', () => {
  const ctx = load();
  const head = byClass(render(ctx, 'example.orders'), 'tp-head')[0];
  const text = textOf(head);
  assert.match(text, /^example\.orders/);
  assert.match(text, /Orders of <b>Example Co<\/b>/);
  assert.match(text, /~120000 Est\. rows.*8 Columns.*2 Notes.*2026-10-01 Last scored.*7 Sources/);
  assert.match(text, /1 change at the last describe/);
  assert.equal(byClass(head, 'chg-badge')[0].attrs.title, 'trigger-changed');
});

test('empty states: an undescribed table needs describe_table; an unscored table points to auspex-columns', () => {
  const ctx = load();
  const seen = render(ctx, 'example.order_items');
  assert.match(textOf(seen), /Not described yet.*describe_table on example\.order_items/);
  assert.equal(byClass(seen, 'tp-cols').length, 0);
  const unknown = ctx.tablePageView(ctx.tablePageModel(data, 'example.status_codes', null), ['example.status_codes'], viewCtx());
  assert.match(textOf(unknown), /Not described yet/);
  const customers = render(ctx, 'example.customers');
  assert.match(textOf(customers), /No column scores yet.*auspex-columns skill/);
  assert.deepEqual(rowNames(customers), ['customer_id', 'created_at'].sort(), 'all columns when nothing is scored');
  assert.match(textOf(customers), /tell Claude in chat; it is saved as a rule on the column/);
});

test('every name and text is a text node: the rendered page escapes markup', () => {
  const block = blockOf('table-page');
  assert.doesNotMatch(block, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(blockOf('column-score'), /innerHTML/);
  const ctx = load();
  const out = html(render(ctx, 'example.orders', { showAll: true, open: 'status_code' }));
  assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(out.includes('Orders of &lt;b&gt;Example Co&lt;/b&gt;'));
  assert.ok(out.includes('&lt;i&gt;only&lt;/i&gt;'));
  assert.ok(out.includes('&lt;u&gt;lists&lt;/u&gt;'));
  assert.doesNotMatch(out, /<script>|<b>Example|<i>only|<u>lists/);
});

test('TR and EN: every page string has a Turkish text and the page renders in Turkish', () => {
  const ctx = load('tr');
  const keys = [...blockOf('table-page').matchAll(/\bt\('((?:[^'\\]|\\.)+)'/g)].map(m => m[1].replace(/\\'/g, "'"));
  const mapped = [...Object.values(ctx.scoreStepLabels), ...Object.values(ctx.scoreStepTexts), ...Object.values(ctx.tpRoleTexts)];
  const missing = [...new Set([...keys, ...mapped])].filter(k => ctx.TR[k] === undefined);
  assert.deepEqual(missing, []);
  const text = textOf(render(ctx, 'example.orders'));
  assert.match(text, /8 kolondan 4 tanesi 4–5 puanlı/);
  assert.match(text, /kullanıcı 5 · ajan 2/);
  assert.match(text, /güncel olmayabilir/);
  assert.match(text, /temel/);
  const en = textOf(render(load('en'), 'example.orders'));
  assert.match(en, /may be out of date/);
  assert.doesNotMatch(en, /güncel olmayabilir/);
});

test('the user score request: exact keys, roles in order, clear without roles', () => {
  const ctx = load();
  assert.deepEqual(plain(ctx.userScoreRequest('exampledb', 'example', 'orders', 'amount', { score: 4, roles: ['display', 'join'] })),
    { profile: 'exampledb', schema: 'example', table: 'orders', column: 'amount', score: 4, roles: ['join', 'display'] });
  assert.deepEqual(plain(ctx.userScoreRequest('exampledb', 'example', 'orders', 'amount', { score: 2, roles: [] })),
    { profile: 'exampledb', schema: 'example', table: 'orders', column: 'amount', score: 2, roles: [] }, 'unticking every role is sent as []');
  assert.deepEqual(plain(ctx.userScoreRequest('exampledb', 'example', 'orders', 'amount', { score: 2 })).roles, []);
  assert.deepEqual(plain(ctx.userScoreRequest('exampledb', 'example', 'orders', 'amount', { clear: true, roles: ['join'] })),
    { profile: 'exampledb', schema: 'example', table: 'orders', column: 'amount', clear: true });
  assert.equal(ctx.userScoreProblem({ score: 3 }), null);
  assert.equal(ctx.userScoreProblem({ clear: true }), null);
  assert.equal(ctx.userScoreProblem({ score: null }), 'Choose a score from 1 to 5.');
  assert.equal(ctx.userScoreProblem({ score: 6 }), 'Choose a score from 1 to 5.');
});

test('the page posts the score with its token and maps refusals; the desktop calls score_column', async () => {
  const ctx = load();
  const req = ctx.userScoreRequest('exampledb', 'example', 'orders', 'amount', { score: 4 });
  const seen = [];
  const reply = (status, body) => async (url, init) => { seen.push([url, init]); return { status, ok: status < 300, statusText: '', json: async () => body }; };
  const okRes = await ctx.postColumnScore(reply(200, { score: 4 }), 'tok', req);
  assert.equal(okRes.score, 4);
  assert.equal(seen[0][0], '/api/memory/column-score');
  assert.deepEqual([seen[0][1].method, seen[0][1].headers['X-Auspex-Token'], seen[0][1].headers['Content-Type']], ['POST', 'tok', 'application/json']);
  assert.deepEqual(JSON.parse(seen[0][1].body), JSON.parse(JSON.stringify(req)));
  await assert.rejects(ctx.postColumnScore(reply(403, { error: 'Missing or invalid token', code: 'TOKEN_INVALID' }), 'old', req), err => err.viewerRestarted === true);
  await assert.rejects(ctx.postColumnScore(reply(409, { error: 'No user score to clear', code: 'PRECONDITION_FAILED' }), 'tok', req), err => err.code === 'PRECONDITION_FAILED');
  const invoked = [];
  await ctx.invokeColumnScore(async (cmd, args) => { invoked.push([cmd, args]); return { ok: true }; }, req);
  assert.equal(invoked[0][0], 'score_column');
  await assert.rejects(ctx.invokeColumnScore(async () => { throw { code: 'NODE_NOT_FOUND', message: 'no node' }; }, req), err => err.code === 'NODE_NOT_FOUND' && !!err.setupText);
});

test('a note read from code shows a "from code" badge and its references as escaped text', () => {
  const ctx = load();
  const codeNote = {
    id: 90, kind: 'inference', schema: 'example', table: 'orders', column: 'amount', text: 'Appears to be the <b>total</b>.', status: 'active',
    evidenceCode: [{ root: 'example_app', path: 'src/Orders/<Order>.cs', line: 42, symbol: 'Order.Amount<script>' }, { root: 'example_app', path: 'web/orders.html' }],
  };
  const withCode = { ...data, notes: [...data.notes, codeNote] };
  const view = ctx.tablePageView(ctx.tablePageModel(withCode, 'example.orders', recs['example.orders']), ['example.orders'], viewCtx({ showAll: true, open: 'amount' }));
  const detail = byClass(view, 'tp-detail')[0];
  const badge = byClass(detail, 'code')[0];
  assert.equal(textOf(badge), 'from code');
  const refs = byClass(detail, 'code-refs')[0];
  assert.deepEqual(refs.kids.map(textOf), ['example_app:src/Orders/<Order>.cs:42 · Order.Amount<script>', 'example_app:web/orders.html']);
  const out = html(detail);
  assert.ok(out.includes('src/Orders/&lt;Order&gt;.cs:42 · Order.Amount&lt;script&gt;'));
  assert.ok(!out.includes('<script>') && !out.includes('<b>total'), 'no markup from the note');
  assert.ok(!all(detail, n => n.tag === 'a').length, 'no links to files');
  // A column without code evidence has no badge.
  const plainView = render(ctx, 'example.orders', { open: 'status_code' });
  assert.equal(byClass(byClass(plainView, 'tp-detail')[0], 'code').length, 0);
  // Turkish label.
  const tr = load('tr');
  const trView = tr.tablePageView(tr.tablePageModel(withCode, 'example.orders', recs['example.orders']), ['example.orders'], viewCtx({ showAll: true, open: 'amount' }));
  assert.equal(textOf(byClass(byClass(trView, 'tp-detail')[0], 'code')[0]), 'koddan');
});
