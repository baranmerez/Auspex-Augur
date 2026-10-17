import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the favorites block of src/viewer.html (pinned and recently opened
// reports, local UI state only) in isolation.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ favorites:start[\s\S]*?\/\/ favorites:end/)?.[0];

function load() {
  assert.ok(block, 'favorites block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nObject.assign(this, { favKey, favNormalize, favIsPinned, favToggle, favTouch, favResolve, favPrune, favSame, maxRecent });`, context);
  return context;
}
const plain = x => JSON.parse(JSON.stringify(x));
const rep = (name, stage = 'draft', extra = {}) => ({ db: 'exampledb', schema: 'example', category: 'Orders/Delivery', name, stage, title: name, ...extra });

test('a key is the report location without its stage; change scripts are their own kind', () => {
  const { favKey } = load();
  assert.equal(favKey(rep('late-orders', 'draft')), favKey(rep('late-orders', 'approved')));
  assert.notEqual(favKey(rep('late-orders', 'draft')), favKey(rep('late-orders', 'execute')));
  assert.equal(favKey(rep('late-orders')), 'r|exampledb|example|Orders/Delivery|late-orders');
});

test('stored state is normalized: arrays of unique non-empty strings, capped', () => {
  const { favNormalize, maxRecent } = load();
  assert.deepEqual(plain(favNormalize(null)), { pins: [], recent: [] });
  assert.deepEqual(plain(favNormalize({ pins: 'x', recent: [1, '', 'a', 'a', 'b'] })), { pins: [], recent: ['a', 'b'] });
  assert.equal(favNormalize({ recent: Array.from({ length: 20 }, (_, i) => `k${i}`) }).recent.length, maxRecent);
});

test('pin toggles on and off; recent keeps the last 8 opened, newest first, without duplicates', () => {
  const { favToggle, favTouch, favIsPinned } = load();
  let f = { pins: [], recent: [] };
  f = favToggle(f, 'a');
  assert.ok(favIsPinned(f, 'a'));
  f = favToggle(f, 'a');
  assert.ok(!favIsPinned(f, 'a'));
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '3']) f = favTouch(f, k);
  assert.deepEqual(plain(f.recent), ['3', '9', '8', '7', '6', '5', '4', '2']);
});

test('a key resolves to the draft before the approved copy; entries of removed or moved reports are dropped', () => {
  const { favKey, favResolve, favPrune, favSame } = load();
  const reports = [rep('a', 'approved'), rep('a', 'draft'), rep('b', 'approved')];
  assert.equal(favResolve(favKey(rep('a')), reports).stage, 'draft');
  assert.equal(favResolve(favKey(rep('b')), reports).stage, 'approved');
  assert.equal(favResolve(favKey(rep('gone')), reports), null);
  const favs = { pins: [favKey(rep('a')), favKey(rep('gone'))], recent: [favKey(rep('moved')), favKey(rep('b'))] };
  const pruned = favPrune(favs, reports);
  assert.deepEqual(plain(pruned), { pins: [favKey(rep('a'))], recent: [favKey(rep('b'))] });
  assert.ok(!favSame(pruned, favs));
  assert.ok(favSame(favPrune(pruned, reports), pruned));
});
