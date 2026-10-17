import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The Rules tab blocks of src/viewer.html in isolation: the list filters
// (rules-list, with foldText from report-filter) and the archive request
// (note-archive, with stageError from stage-change).
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const blockOf = name => page.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`))?.[0];

function load() {
  for (const name of ['report-filter', 'rules-list', 'stage-change', 'note-archive']) assert.ok(blockOf(name), `${name} block found`);
  const context = vm.createContext({ JSON });
  vm.runInContext(`${blockOf('report-filter')}\n${blockOf('rules-list')}\n${blockOf('stage-change')}\n${blockOf('note-archive')}
this.filterRules = filterRules; this.groupRules = groupRules; this.ruleCounts = ruleCounts; this.ruleDay = ruleDay; this.archiveReasonProblem = archiveReasonProblem; this.archiveRequest = archiveRequest;
this.postArchiveNote = postArchiveNote; this.invokeArchiveNote = invokeArchiveNote; this.archiveReasonMax = archiveReasonMax;`, context);
  return context;
}

const notes = [
  { id: 1, kind: 'rule', schema: 'example', table: 'orders', column: 'status_code', text: 'İptal edilen siparişler status_code 9 ile işaretlenir.', status: 'active' },
  { id: 2, kind: 'observation', schema: 'example', table: 'order_items', column: null, text: 'Every order has at least one item.', status: 'active', evidence: { figures: { orders: 120, without_items: 0 } } },
  { id: 3, kind: 'inference', schema: null, table: null, column: null, text: 'Test Ltd rows look like test data.', status: 'active' },
  { id: 4, kind: 'rule', schema: 'example', table: 'orders', column: null, text: 'Old rule about created_at.', status: 'archived', archivedReason: 'Replaced by rule 1' },
  { id: 5, kind: 'rule', schema: null, table: null, column: null, text: 'Amounts are in EUR.', status: 'active' },
];
const ids = (f) => [...load().filterRules(notes, f)].map(n => n.id);

test('status filter: active by default, archived or all on request', () => {
  assert.deepEqual(ids({}), [5, 3, 2, 1], 'database-wide first, then by table, kind and id');
  assert.deepEqual(ids({ status: 'archived' }), [4]);
  assert.deepEqual(ids({ status: 'all' }), [5, 3, 2, 4, 1], 'table-level notes before column notes');
  assert.deepEqual(ids({ status: 'bogus' }), [5, 3, 2, 1], 'unknown status falls back to active');
});

test('kind and table filters', () => {
  assert.deepEqual(ids({ kind: 'rule' }), [5, 1]);
  assert.deepEqual(ids({ kind: 'observation' }), [2]);
  assert.deepEqual(ids({ table: 'orders' }), [1], 'part of schema.table');
  assert.deepEqual(ids({ table: 'example.order' }), [2, 1]);
  assert.deepEqual(ids({ table: 'example.order_items' }), [2]);
  assert.deepEqual(ids({ table: 'ORDER_ITEMS' }), [2]);
  assert.deepEqual(ids({ table: 'nope' }), []);
});

test('text search: every word, Turkish-aware, over text, column, table and archive reason', () => {
  assert.deepEqual(ids({ q: 'iptal' }), [1], 'İ matches i');
  assert.deepEqual(ids({ q: 'İPTAL SİPARİŞLER' }), [1]);
  assert.deepEqual(ids({ q: 'status_code' }), [1]);
  assert.deepEqual(ids({ q: 'order_items' }), [2]);
  assert.deepEqual(ids({ q: 'replaced', status: 'all' }), [4]);
  assert.deepEqual(ids({ q: '#3' }), [3]);
  assert.deepEqual(ids({ q: 'test nope' }), []);
  assert.deepEqual(ids({ q: '   ' }), [5, 3, 2, 1]);
});

test('groups follow the sorted list, database-wide notes under an empty key', () => {
  const { filterRules, groupRules } = load();
  const groups = groupRules(filterRules(notes, { status: 'all' }));
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(g => [g.key, g.notes.map(n => n.id)]))),
    [['', [5, 3]], ['example.order_items', [2]], ['example.orders', [4, 1]]]);
  assert.equal(filterRules(null, {}).length, 0);
});

test('the archive reason is required, one line and at most 200 characters', () => {
  const { archiveReasonProblem, archiveRequest, archiveReasonMax } = load();
  assert.equal(archiveReasonMax, 200);
  assert.equal(archiveReasonProblem('Outdated'), null);
  assert.equal(archiveReasonProblem('  Outdated  '), null, 'trimmed before checking');
  assert.equal(archiveReasonProblem(''), 'Give a reason.');
  assert.equal(archiveReasonProblem('   '), 'Give a reason.');
  assert.equal(archiveReasonProblem(undefined), 'Give a reason.');
  assert.equal(archiveReasonProblem('a'.repeat(200)), null);
  assert.equal(archiveReasonProblem('a'.repeat(201)), 'At most 200 characters.');
  assert.equal(archiveReasonProblem('a\nb'), 'One line without control characters.');
  assert.deepEqual({ ...archiveRequest('exampledb', notes[0], '  Outdated ') }, { profile: 'exampledb', id: 1, reason: 'Outdated' });
});

test('the page posts the archive request with its token and maps refusals', async () => {
  const { postArchiveNote } = load();
  const calls = [];
  const fetchOk = async (url, init) => { calls.push([url, init]); return { ok: true, status: 200, json: async () => ({ note: { id: 1, status: 'archived' } }) }; };
  const req = { profile: 'exampledb', id: 1, reason: 'Outdated' };
  assert.equal((await postArchiveNote(fetchOk, 'tok', req)).note.status, 'archived');
  const [url, init] = calls[0];
  assert.equal(url, '/api/memory/archive');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Auspex-Token'], 'tok');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), req);
  const refuse = (status, body) => async () => ({ ok: false, status, statusText: 'x', json: async () => body });
  await assert.rejects(postArchiveNote(refuse(403, { error: 'Missing or invalid token', code: 'TOKEN_INVALID' }), 'old', req), err => err.viewerRestarted === true);
  await assert.rejects(postArchiveNote(refuse(409, { error: 'Note #1 is already archived.', code: 'PRECONDITION_FAILED' }), 'tok', req),
    err => err.code === 'PRECONDITION_FAILED' && /already archived/.test(err.message));
});

test('the desktop page invokes archive_note with the same request and maps setup errors', async () => {
  const { invokeArchiveNote } = load();
  const calls = [];
  const req = { profile: 'exampledb', id: 1, reason: 'Outdated' };
  await invokeArchiveNote(async (cmd, args) => { calls.push([cmd, args]); return { ok: true }; }, req);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['archive_note', req]]);
  await assert.rejects(invokeArchiveNote(async () => { throw { code: 'NODE_NOT_FOUND', message: 'x' }; }, req), err => err.code === 'NODE_NOT_FOUND' && !!err.setupText);
  await assert.rejects(invokeArchiveNote(async () => { throw 'plain failure'; }, req), err => err.message === 'plain failure');
});

test('the Rules tab is wired: tab button, view, dialog and Turkish labels', () => {
  assert.match(page, /<button data-tab="rules">/);
  assert.match(page, /<section id="v-rules" class="view" hidden><\/section>/);
  assert.match(page, /<dialog class="dlg" id="archiveDlg"/);
  assert.match(page, /const tabNames = \[[^\]]*'rules'[^\]]*\]/);
  for (const key of ['Rules', 'Archive', 'Archive this note?', 'Give a reason.', 'At most 200 characters.', 'One line without control characters.', 'Note archived', 'Data dictionary']) {
    assert.ok(page.includes(`'${key}': '`), `Turkish text for ${key}`);
  }
});
