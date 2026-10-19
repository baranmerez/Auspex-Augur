import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual range resolver from the bundled viewer without a DOM
// or database. The /api/days response is sorted ascending by load().
const viewer = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const resolver = viewer.match(/function resolveRange\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(resolver, 'viewer must contain resolveRange');

function viewerRange(range, days) {
  const state = {
    range,
    days: days.map(day => ({ day })).sort((a, b) => a.day.localeCompare(b.day)),
    from: null,
    to: null,
  };
  const context = { state, localDay: () => '2026-10-20', addDays: () => { throw new Error('Unexpected relative date'); } };
  return Array.from(vm.runInNewContext(`${resolver}\nresolveRange()`, context));
}

test('All starts with the oldest audit day, not the newest', () => {
  assert.deepEqual(viewerRange('all', ['2026-09-02', '2026-01-03', '2026-10-19']),
    ['2026-01-03', '2026-10-20']);
});

test('All uses today when there are no audit files', () => {
  assert.deepEqual(viewerRange('all', []), ['2026-10-20', '2026-10-20']);
});
