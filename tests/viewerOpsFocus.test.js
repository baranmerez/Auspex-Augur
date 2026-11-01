import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the ops-focus block of src/viewer.html (Operations sort headers and
// focus kept across redraws) with a small element builder.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ ops-focus:start[\s\S]*?\/\/ ops-focus:end/)?.[0];

const h = (tag, attrs = {}, ...kids) => {
  const n = { tag, attrs: {}, on: {}, kids: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false) };
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) n.on[k.slice(2)] = v;
    else n.attrs[k] = v === true ? '' : String(v);
  }
  return n;
};
function load() {
  assert.ok(block, 'ops-focus block found in viewer.html');
  const t = (en, vars = {}) => en.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  const context = vm.createContext({ h, t });
  vm.runInContext(`${block}\nObject.assign(this, { opsFocusOf, opsFocusTarget, opsFocusNotice, opsSortHead });`, context);
  return context;
}
const cols = [['ts', 'Time'], ['source', 'Source'], ['ms', 'Duration', 'num'], ['rowCount', 'Rows', 'num hide-sm']];
const text = n => n.kids.map(k => (typeof k === 'string' ? k : text(k))).join('');

test('every sortable header holds a native button named after its column; only the active one has a direction', () => {
  const { opsSortHead } = load();
  const head = opsSortHead(cols, { key: 'ms', dir: 'desc' }, () => {});
  assert.equal(head.kids.length, cols.length);
  for (const [i, th] of head.kids.entries()) {
    assert.equal(th.tag, 'th');
    assert.equal(th.attrs.scope, 'col');
    assert.equal(Object.keys(th.on).length, 0, 'the header itself has no click handler');
    const [btn] = th.kids;
    assert.equal(btn.tag, 'button');
    assert.equal(btn.attrs.type, 'button');
    assert.equal(btn.attrs['data-ops-focus'], `sort:${cols[i][0]}`);
    assert.match(btn.attrs['aria-label'], new RegExp(`^Sort by ${cols[i][1]}, (ascending|descending)$`));
    assert.ok(text(btn).startsWith(cols[i][1]));
  }
  assert.deepEqual(head.kids.map(th => th.attrs['aria-sort']), ['none', 'none', 'descending', 'none']);
  assert.equal(head.kids[2].kids[0].attrs['aria-label'], 'Sort by Duration, ascending', 'pressing the active descending column sorts ascending');
  assert.equal(head.kids[0].kids[0].attrs['aria-label'], 'Sort by Time, descending', 'a new column starts descending');
  const arrow = head.kids[2].kids[0].kids.find(k => typeof k !== 'string');
  assert.equal(arrow.attrs['aria-hidden'], 'true', 'the arrow is decoration; the header carries the state');
  assert.match(head.kids[2].attrs.class, /\bnum\b/);
  assert.equal(opsSortHead(cols, { key: 'ms', dir: 'asc' }, () => {}).kids[2].attrs['aria-sort'], 'ascending');
});

test('activating a header button (click, or Enter/Space on the native button) gives the same next sort', () => {
  const { opsSortHead } = load();
  const got = [];
  let sort = { key: 'ts', dir: 'desc' };
  const press = key => opsSortHead(cols, sort, s => { got.push(s); sort = s; }).kids.find(th => th.kids[0].attrs['data-ops-focus'] === `sort:${key}`).kids[0].on.click();
  press('ms');
  press('ms');
  press('ms');
  press('ts');
  assert.deepEqual(got.map(s => `${s.key}:${s.dir}`), ['ms:desc', 'ms:asc', 'ms:desc', 'ts:desc']);
});

// A minimal element for opsFocusOf.
const el = (attrs, inside = true) => ({ attrs, inside, getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; } });
const root = { contains: e => !!e?.inside };

test('the focused control is read by its stable key, the row id and position', () => {
  const { opsFocusOf } = load();
  assert.deepEqual({ ...opsFocusOf(el({ 'data-ops-focus': 'sort:ms' }), root) }, { key: 'sort:ms', row: null, index: -1 });
  assert.deepEqual({ ...opsFocusOf(el({ 'data-ops-focus': 'row:a|query|3', 'data-ops-row': 'a|query|3', 'data-ops-index': '4' }), root) }, { key: 'row:a|query|3', row: 'a|query|3', index: 4 });
  assert.deepEqual({ ...opsFocusOf(el({ 'data-ops-focus': 'act:a|query|3:sql', 'data-ops-row': 'a|query|3', 'data-ops-index': '0' }), root) }, { key: 'act:a|query|3:sql', row: 'a|query|3', index: 0 });
  assert.equal(opsFocusOf(el({ 'data-ops-focus': 'sort:ms' }, false), root), null, 'focus outside the grid is left alone');
  assert.equal(opsFocusOf(el({}), root), null, 'a control without a key');
  assert.equal(opsFocusOf(null, root), null);
  assert.equal(opsFocusOf(root, root), null);
});

test('after a redraw focus returns to the same header, row or action', () => {
  const { opsFocusTarget } = load();
  const keys = ['tools:per-page', 'tools:csv', 'sort:ts', 'sort:ms', 'row:r1', 'row:r2', 'act:r2:sql', 'row:r3', 'pager:next'];
  const rows = keys.filter(k => k.startsWith('row:'));
  const same = key => ({ ...opsFocusTarget({ key, row: key.split(':')[1]?.startsWith('r') ? key.split(':')[1] : null, index: 1 }, keys, rows) });
  assert.deepEqual(same('sort:ms'), { key: 'sort:ms', moved: false }, 'sorting keeps focus on the pressed header, so the direction toggles without tabbing back');
  assert.deepEqual(same('row:r2'), { key: 'row:r2', moved: false }, 'expanding or collapsing keeps the row');
  assert.deepEqual(same('act:r2:sql'), { key: 'act:r2:sql', moved: false });
  assert.deepEqual(same('pager:next'), { key: 'pager:next', moved: false });
  assert.equal(opsFocusTarget(null, keys, rows), null, 'nothing was focused: nothing is focused');
});

test('fallbacks: a closed detail goes to its row, a removed row to its neighbour, a disabled pager button to the other one', () => {
  const { opsFocusTarget } = load();
  const plain = x => ({ ...x });
  const keys = ['sort:ts', 'sort:ms', 'row:r1', 'row:r3', 'row:r4', 'pager:prev'];
  const rows = ['row:r1', 'row:r3', 'row:r4'];
  assert.deepEqual(plain(opsFocusTarget({ key: 'act:r3:sql', row: 'r3', index: 1 }, keys, rows)), { key: 'row:r3', moved: false }, 'detail closed: its row');
  assert.deepEqual(plain(opsFocusTarget({ key: 'row:r2', row: 'r2', index: 1 }, keys, rows)), { key: 'row:r3', moved: true }, 'removed: the row now at its position');
  assert.deepEqual(plain(opsFocusTarget({ key: 'act:r9:json', row: 'r9', index: 7 }, keys, rows)), { key: 'row:r4', moved: true }, 'past the end: the last row');
  assert.deepEqual(plain(opsFocusTarget({ key: 'pager:next', row: null, index: -1 }, keys, rows)), { key: 'pager:prev', moved: true }, 'last page: Next is disabled');
  assert.deepEqual(plain(opsFocusTarget({ key: 'tools:csv', row: null, index: -1 }, keys, rows)), { key: 'sort:ts', moved: true });
  assert.equal(opsFocusTarget({ key: 'tools:csv', row: null, index: -1 }, [], []), null, 'empty grid: focus is not forced anywhere');
});

test('the last operation disappears: the empty state has no headers, so focus goes to the toolbar and is announced once', () => {
  const { opsFocusTarget, opsFocusNotice } = load();
  const plain = x => ({ ...x });
  // What renderOps draws for zero rows: the toolbar and the empty state, no table and no pager.
  const keys = ['tools:per-page', 'tools:csv', 'tools:json'];
  for (const saved of [{ key: 'row:r1', row: 'r1', index: 0 }, { key: 'act:r1:sql', row: 'r1', index: 0 }]) {
    const target = opsFocusTarget(saved, keys, []);
    assert.deepEqual(plain(target), { key: 'tools:per-page', moved: true }, saved.key + ': the first toolbar control');
    assert.equal(opsFocusNotice(saved, target), 'The focused operation is no longer listed; no operations are shown now.');
  }
  const header = { key: 'sort:ms', row: null, index: -1 };
  const toHeader = opsFocusTarget(header, keys, []);
  assert.deepEqual(plain(toHeader), { key: 'tools:per-page', moved: true }, 'a filter that empties the grid while a header is focused');
  assert.equal(opsFocusNotice(header, toHeader), null, 'no operation was focused: nothing to announce');
  const rows = ['row:r1', 'row:r3'];
  const near = { key: 'row:r2', row: 'r2', index: 1 };
  assert.equal(opsFocusNotice(near, opsFocusTarget(near, ['sort:ts', ...rows], rows)), 'The focused operation is no longer listed; focus moved to the nearest one.');
  assert.equal(opsFocusNotice({ key: 'row:r1', row: 'r1', index: 0 }, { key: 'row:r1', moved: false }), null, 'focus stayed: no announcement');
  assert.equal(opsFocusNotice(near, null), null);
});
