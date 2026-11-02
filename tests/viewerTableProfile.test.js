import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { SchemaMemory } from '../src/memory/store.js';
import { seedExampleMemory, ordersDescribe } from './fixtures/exampleMemory.js';

// The Profile view of the table page (table-profile block, with table-page)
// rendered with a recording h(), its memory-edit requests (memory-edit, with
// stage-change) and the profile request of "Ask agent" (ask-agent). The
// profile comes from the real store on synthetic example data.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const tableKeyLines = page.match(/^const tableKey = .*\r?\n^const splitTableKey = .*$/m)[0];
const blockOf = name => page.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`))?.[0];
const pageTr = vm.runInNewContext(`(${page.match(/const TR = (\{[\s\S]*?\n\});/)[1]})`);

let home, data, rec, prof, profFresh;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-viewer-profile-'));
  const memDir = path.join(home, 'memory');
  seedExampleMemory(memDir, 'exampledb');
  const m = new SchemaMemory(memDir, { reportSources: () => [] });
  m.recordDescribe({ profile: 'exampledb', schema: 'example', table: 'status_codes', kind: 'table', oid: 3001, estimated_rows: 12, comment: null,
    columns: [{ column: 'status_code', attnum: 1, type: 'text', not_null: true }], constraints: [], indexes: [], referencedBy: [], triggers: [] });
  m.recordDescribe(ordersDescribe('exampledb'));
  m.addNote('exampledb', { kind: 'inference', schema: 'example', table: 'orders', text: 'Maybe <img src=x onerror=alert(1)> a soft delete.' });
  m.addNote('exampledb', { kind: 'observation', schema: 'example', table: 'orders', column: 'amount', text: 'In the order currency.', evidenceCode: [{ root: 'app', path: 'src/Order.cs', line: 4 }] });
  m.saveTableProfile('exampledb', { schema: 'example', table: 'orders', sections: { purpose: 'One row per order.\n\nSecond <b>paragraph</b>.', caveats: 'Never delete rows.' },
    sources: { purpose: [{ type: 'note', ref: 1 }, { type: 'note', ref: 2 }, { type: 'report', ref: 'example-report' }, { type: 'trigger', ref: 'orders_log' }] } });
  m.markRequiredTable('exampledb', { schema: 'example', table: 'orders', target: { schema: 'test', table: 'invoices' }, required: true });
  profFresh = m.tableProfile('exampledb', 'example', 'orders');
  m.addNote('exampledb', { kind: 'rule', schema: 'example', table: 'orders', text: 'Orders are never deleted.' });
  m.confirmTableProfile('exampledb', { schema: 'example', table: 'orders', expectedVersion: 1 });
  m.saveTableProfile('exampledb', { schema: 'example', table: 'orders', sections: { purpose: 'Agent rewrite.' } });
  prof = m.tableProfile('exampledb', 'example', 'orders');
  const dir = path.join(memDir, 'exampledb');
  data = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
  const node = data.nodes.find(n => n.id === 'example.orders');
  rec = JSON.parse(fs.readFileSync(path.join(dir, ...node.file.split('/')), 'utf8'));
});
after(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); });

const h = (tag, attrs = {}, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false) });
const textOf = n => (typeof n === 'string' || typeof n === 'number' ? String(n) : n ? n.kids.map(textOf).join('') : '');
const all = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); n.kids.forEach(k => all(k, pred, out)); } return out; };
const byClass = (n, cls) => all(n, x => String(x.attrs.class || '').split(/\s+/).includes(cls));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const html = n => (typeof n === 'string' || typeof n === 'number' ? esc(n) : `<${n.tag}${Object.entries(n.attrs).filter(([, v]) => typeof v !== 'function' && v !== null && v !== undefined && v !== false).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${n.kids.map(html).join('')}</${n.tag}>`);

function load(lang = 'en') {
  for (const name of ['table-page', 'table-profile', 'stage-change', 'memory-edit']) assert.ok(blockOf(name), `${name} block found`);
  const context = vm.createContext({ JSON, h, svg: h, locale: 'en-GB', fmt: n => String(n), compact: n => `~${n}`, ruleDay: ts => (ts ? String(ts).slice(0, 10) : '?'), changeLabel: c => c.change });
  vm.runInContext(`${tableKeyLines}\n${page.match(/const foldText = .*;/)[0]}
${blockOf('table-page')}
${blockOf('table-profile')}
const TR = Object.assign({}, ${JSON.stringify(pageTr)});
for (const [k, v] of Object.entries({ ...tablePageTr, ...tableProfileTr })) if (!Object.hasOwn(TR, k)) TR[k] = v;
const t = (en, vars = {}) => String(${JSON.stringify(lang)} === 'tr' && TR[en] !== undefined ? TR[en] : en).replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] ?? '');
${blockOf('stage-change')}
${blockOf('memory-edit')}
Object.assign(this, { tablePageModel, tablePageView, tpProfileModel, tpProfileView, tppSourceLine, tppFreshText, tppDiff, tpViewChoice, tableProfileTr, TR,
  noteTextProblem, profileTextProblem, postMemoryEdit, invokeMemoryEdit });`, context);
  return context;
}
const calls = [];
const baseCtx = (extra = {}) => ({
  view: 'profile', onView: v => calls.push(['view', v]), onOpen: id => calls.push(['open', id]), onBack() {}, onClose() {}, onCrumb() {},
  onCard: (k, v) => calls.push(['card', k, v]), onCat: (k, v) => calls.push(['cat', k, v]), onMore: (k, v) => calls.push(['more', k, v]),
  onEditProfile: () => calls.push(['edit']), onConfirmProfile: () => calls.push(['confirm']), onReviewProposal: () => calls.push(['review']), onAskRewrite: () => calls.push(['ask']),
  onAddNote: k => calls.push(['add', k]), onEditNote: n => calls.push(['editNote', n.id]), onArchiveNote: n => calls.push(['archive', n.id]),
  onConfirmNote: (n, k) => calls.push(['confirmNote', n.id, k]), onRejectNote: n => calls.push(['reject', n.id]), onMark: () => calls.push(['mark']), onUnmark: r => calls.push(['unmark', r.id]),
  ...extra,
});
function render(ctx, profile = prof, extra = {}) {
  const model = ctx.tablePageModel(data, 'example.orders', rec);
  const pm = ctx.tpProfileModel(model, data, profile, { items: [], pending: 0, failed: 0 });
  return ctx.tablePageView(model, ['example.orders'], baseCtx({ profileModel: pm, ...extra }));
}

test('the Profile view is the first choice and the first button of the switch', () => {
  const ctx = load();
  assert.equal(ctx.tpViewChoice(undefined, undefined), 'profile');
  const view = render(ctx);
  assert.deepEqual(byClass(view, 'tp-switch')[0].kids.map(textOf), ['Profile', 'Detailed', 'Summary']);
  assert.equal(byClass(view, 'tpp').length, 1);
});

test('the book: sections as paragraphs with their sources line, status, stale banner and the pending proposal', () => {
  const ctx = load();
  const view = render(ctx);
  const book = byClass(view, 'tpp-book')[0];
  const secs = byClass(book, 'tpp-sec');
  assert.deepEqual(secs.map(s => textOf(s.kids[0])), ['What it is for', 'Watch out'], 'empty sections are left out');
  assert.deepEqual(all(secs[0], x => x.tag === 'p' && !x.attrs.class).map(textOf), ['One row per order.', 'Second <b>paragraph</b>.']);
  assert.equal(textOf(byClass(secs[0], 'tpp-src')[0]), 'Sources 1 rule, 1 observation, 1 report, trigger orders_log');
  assert.match(textOf(book), /Agent text, confirmed by you/);
  assert.match(textOf(byClass(book, 'warn')[0]), /May be out of date1 new rule/);
  assert.match(textOf(byClass(book, 'info')[0]), /proposed a rewrite \(version 2\)/);
  const out = html(view);
  assert.ok(!out.includes('<b>paragraph'), 'profile text stays text');
  assert.ok(!out.includes('<img'), 'note text stays text');
  calls.length = 0;
  all(book, x => x.tag === 'button' && textOf(x) === 'Review the proposal')[0].attrs.onclick();
  all(book, x => x.tag === 'button' && textOf(x) === 'Ask agent to rewrite')[0].attrs.onclick();
  assert.deepEqual(calls, [['review'], ['ask']]);
  // A confirmed profile offers no Confirm; a fresh agent draft does.
  assert.equal(all(book, x => x.tag === 'button' && textOf(x) === 'Confirm').length, 0);
  const draft = byClass(render(ctx, profFresh), 'tpp-book')[0];
  assert.match(textOf(draft), /Agent draft/);
  assert.equal(all(draft, x => x.tag === 'button' && textOf(x) === 'Confirm').length, 1);
  assert.equal(byClass(draft, 'warn').length, 0, 'fresh: no banner');
});

test('no profile, loading and failed reads say so and offer the next step', () => {
  const ctx = load();
  const empty = byClass(render(ctx, { ...prof, profile: null, proposal: null, history: [] }), 'tpp-book')[0];
  assert.match(textOf(empty), /No profile yet/);
  assert.deepEqual(all(empty, x => x.tag === 'button').map(textOf).slice(-2), ['Ask agent to write it', 'Write it yourself']);
  assert.match(textOf(byClass(render(ctx, null, { profileState: { loading: true } }), 'tpp-book')[0]), /Loading the profile/);
  const failed = byClass(render(ctx, null, { profileState: { error: 'disk', onRetry: () => calls.push(['retry']) } }), 'tpp-book')[0];
  assert.equal(byClass(failed, 'error-box')[0].attrs.role, 'alert');
});

test('categories: rules, observations, inferences to review and code meanings, each with its actions', () => {
  const ctx = load();
  const view = render(ctx);
  const cat = k => byClass(view, `tpp-cat-${k}`)[0];
  assert.equal(cat('rule').tag, 'details');
  assert.equal(textOf(byClass(cat('rule'), 'tpp-count')[0]), '2');
  assert.match(textOf(cat('meaning')), /In the order currency\./, 'a note with code evidence is a column meaning');
  assert.doesNotMatch(textOf(cat('observation')), /order currency/);
  calls.length = 0;
  const inf = byClass(cat('inference'), 'tpp-note')[0];
  for (const b of all(inf, x => x.tag === 'button')) b.attrs.onclick();
  const id = Number(textOf(inf).match(/#(\d+)/)[1]);
  assert.deepEqual(calls, [['confirmNote', id, 'rule'], ['confirmNote', id, 'observation'], ['reject', id]]);
  calls.length = 0;
  all(cat('rule'), x => x.tag === 'button' && textOf(x) === 'Add a rule')[0].attrs.onclick();
  const rule = byClass(cat('rule'), 'tpp-note')[0];
  for (const b of all(rule, x => x.tag === 'button')) b.attrs.onclick();
  assert.equal(calls[0][0], 'add');
  assert.deepEqual(calls.slice(1).map(c => c[0]), ['editNote', 'archive']);
  assert.ok(all(rule, x => x.tag === 'button').every(b => /#\d+$/.test(b.attrs['aria-label'])), 'each action names its note for screen readers');
  // Open state is remembered; a toggle is reported without redrawing.
  const closed = render(ctx, prof, { catOpen: { rule: false } });
  assert.equal(byClass(closed, 'tpp-cat-rule')[0].attrs.open, false);
  byClass(closed, 'tpp-cat-rule')[0].attrs.ontoggle({ currentTarget: { open: true } });
  assert.deepEqual(calls.at(-1), ['cat', 'rule', true]);
});

test('cards: "Cannot live without" first with evidence labels, the first two open, top 5 with more, required and optional apart', () => {
  const ctx = load();
  const view = render(ctx);
  const cards = byClass(view, 'tpp-card');
  assert.deepEqual(cards.map(c => byClass(c, 'tpp-card-t')[0]).map(textOf),
    ['Cannot live without', 'Referenced tables', 'Referencing tables', 'Used by views', 'Triggers and functions', 'Reports']);
  assert.deepEqual(cards.map(c => c.attrs.open), [true, true, false, false, false, false]);
  const req = cards[0];
  const items = byClass(req, 'tpp-item').map(textOf);
  assert.deepEqual(items, ['example.customerscatalog', 'test.invoicesyours×', 'example.status_codesinferred']);
  assert.match(textOf(all(req, x => x.tag === 'summary')[0]), /1 catalog · 1 inferred · 1 yours/);
  assert.match(all(req, x => String(x.attrs.class).includes('tpp-ev catalog'))[0].attrs.title, /every column is NOT NULL/);
  calls.length = 0;
  byClass(req, 'tpp-x')[0].attrs.onclick();
  assert.deepEqual(calls, [['unmark', 'test.invoices']]);
  assert.match(textOf(all(cards[1], x => x.tag === 'summary')[0]), /1 required · 0 optional/);
  const reopened = byClass(render(ctx, prof, { cardOpen: { required: false, deps: true } }), 'tpp-card');
  assert.deepEqual(reopened.map(c => c.attrs.open), [false, true, true, false, false, false]);
  // More than five: the rest behind "+N more".
  const many = { ...prof, requiredTables: Array.from({ length: 7 }, (_, i) => ({ id: `example.t${i}`, schema: 'example', table: `t${i}`, evidence: [{ type: 'user', at: 'x' }] })) };
  const big = byClass(render(ctx, many), 'tpp-card')[0];
  assert.equal(byClass(big, 'tpp-item').length, 5);
  assert.equal(textOf(byClass(big, 'tpp-more')[0]), '+2 more');
});

test('Turkish texts exist for the Profile view and its freshness reasons', () => {
  const ctx = load('tr');
  for (const k of Object.keys(ctx.tableProfileTr)) assert.ok(ctx.TR[k], k);
  assert.equal(ctx.tppFreshText([{ code: 'notes-added', kind: 'rule', count: 2 }, { code: 'structure-changed' }]), '2 yeni kural; yapı değişti');
  assert.match(textOf(byClass(render(ctx), 'tpp-card')[0]), /Olmazsa olmaz/);
});

test('the proposal diff marks changed sections only', () => {
  const ctx = load();
  const d = ctx.tppDiff({ sections: { purpose: 'A', caveats: 'B' } }, { sections: { purpose: 'A ', caveats: 'C' } });
  assert.deepEqual(JSON.parse(JSON.stringify(d.filter(x => x.changed).map(x => x.key))), ['caveats']);
});

test('memory edit requests: checks, the browser POST with token and the desktop command', async () => {
  const ctx = load();
  assert.equal(ctx.noteTextProblem('  '), 'Write the note.');
  assert.equal(ctx.noteTextProblem('x'.repeat(2001)), 'At most 2000 characters.');
  assert.equal(ctx.noteTextProblem('two\nlines'), null);
  assert.equal(ctx.profileTextProblem({ purpose: ' ', caveats: '' }), 'Write at least one section.');
  assert.equal(ctx.profileTextProblem({ purpose: 'x'.repeat(4001) }), 'A section has at most 4000 characters.');
  const req = { op: 'note-add', profile: 'exampledb', schema: 'example', table: 'orders', kind: 'rule', text: 'x' };
  let sent;
  const ok = await ctx.postMemoryEdit(async (url, o) => { sent = { url, o }; return { ok: true, status: 200, json: async () => ({ note: { id: 9 } }) }; }, 'tok', req);
  assert.equal(ok.note.id, 9);
  assert.equal(sent.url, '/api/memory/edit');
  assert.equal(sent.o.headers['X-Auspex-Token'], 'tok');
  assert.deepEqual(JSON.parse(sent.o.body), req);
  await assert.rejects(ctx.postMemoryEdit(async () => ({ ok: false, status: 403, json: async () => ({ error: 'x', code: 'TOKEN_INVALID' }) }), 't', req), e => e.viewerRestarted === true);
  await assert.rejects(ctx.postMemoryEdit(async () => ({ ok: false, status: 409, json: async () => ({ error: 'changed', code: 'STALE_VERSION' }) }), 't', req), e => e.code === 'STALE_VERSION');
  let invoked;
  await ctx.invokeMemoryEdit(async (cmd, args) => { invoked = { cmd, args }; return {}; }, req);
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), { cmd: 'edit_memory', args: { request: req } });
});

test('"Ask agent" can ask for the table profile and says what is stale', () => {
  const block = blockOf('ask-agent');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nObject.assign(this, { buildObjectAskPrompt });`, context);
  const text = context.buildObjectAskPrompt({ kind: 'table', profile: 'exampledb', schema: 'example', name: 'orders',
    tableProfile: { version: 3, owner: 'user', freshness: 'stale', reason: '2 new rules', proposal: 4 } }, 'en', { task: 'profile' });
  assert.match(text, /- table profile: version 3, owner "user", "stale" \("2 new rules"\)/);
  assert.match(text, /- a proposal \(version 4\) is waiting for my review/);
  assert.match(text, /Task: Write its table profile with table_profile action=save, from the stored schema memory only/);
  const none = context.buildObjectAskPrompt({ kind: 'table', profile: 'exampledb', schema: 'example', name: 'orders', tableProfile: { version: null } }, 'tr', { task: 'profile' });
  assert.match(none, /- tablo profili: henüz yok/);
});
