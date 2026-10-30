import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// A failed graph read is kept as { profile, error } so the tabs do not read it
// in a loop; Retry reads only that profile's graph again, and the Refresh
// button also clears it (the 5 s live refresh does not).
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ mem-state:start[\s\S]*?\/\/ mem-state:end/)?.[0];

function load() {
  assert.ok(block, 'mem-state block found');
  const ctx = vm.createContext({ h: () => ({}), t: s => s });
  vm.runInContext(`${block}\nObject.assign(this, { memGraphWanted, memDropError });`, ctx);
  return ctx;
}

test('a graph is read when missing, of another profile or older than the summary; a failed read is not repeated on its own', () => {
  const { memGraphWanted } = load();
  const sum = { generatedAt: 'g2' };
  assert.equal(memGraphWanted(null, 'exampledb', sum), true);
  assert.equal(memGraphWanted({ profile: 'other', data: { generatedAt: 'g2' } }, 'exampledb', sum), true);
  assert.equal(memGraphWanted({ profile: 'exampledb', data: { generatedAt: 'g1' } }, 'exampledb', sum), true);
  assert.equal(memGraphWanted({ profile: 'exampledb', data: { generatedAt: 'g2' } }, 'exampledb', sum), false);
  assert.equal(memGraphWanted({ profile: 'exampledb', error: 'boom' }, 'exampledb', sum), false, 'no automatic re-read of an error');
});

test('Retry and Refresh drop only the failed entry of that profile', () => {
  const { memDropError, memGraphWanted } = load();
  const failed = { profile: 'exampledb', error: 'boom' };
  assert.equal(memDropError(failed, 'exampledb'), null);
  assert.equal(memGraphWanted(memDropError(failed, 'exampledb'), 'exampledb', { generatedAt: 'g' }), true, 'then it is read again');
  assert.equal(memDropError(failed, 'other'), failed, 'another profile keeps it');
  const good = { profile: 'exampledb', data: { generatedAt: 'g' } };
  assert.equal(memDropError(good, 'exampledb'), good, 'a good graph stays');
  assert.equal(memDropError(null, 'exampledb'), null);
});

test('page: Retry refetches that profile\'s graph; the Refresh button (not the live refresh) clears a failed read', () => {
  assert.match(page, /function retryMemView\(db\) \{\s*state\.memView = memDropError\(state\.memView, db\);\s*ensureMemView\(db\);\s*\}/);
  assert.match(page, /if \(!quiet\) state\.memView = memDropError\(state\.memView, state\.db\);/);
  assert.match(page, /state\.memView = \{ profile: db, data: await getJson\('\/api\/memory\/graph\?profile=' \+ encodeURIComponent\(db\)\) \};/, 'one profile\'s graph');
});
