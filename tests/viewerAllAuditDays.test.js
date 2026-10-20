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
  const context = { state, localDay: () => '2026-10-20', addDays };
  return Array.from(vm.runInNewContext(`${resolver}\nresolveRange()`, context));
}

// Same result as the viewer's addDays, without depending on the local time zone.
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const dayCount = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;

test('All starts with the oldest audit day, not the newest', () => {
  assert.deepEqual(viewerRange('all', ['2026-09-02', '2026-01-03', '2026-10-19']),
    ['2026-01-03', '2026-10-20']);
});

test('All uses today when there are no audit files', () => {
  assert.deepEqual(viewerRange('all', []), ['2026-10-20', '2026-10-20']);
});

test('All stops at the last 398 days, so the log request stays within the 400-day limit', () => {
  const [from, to] = viewerRange('all', ['2024-01-01', '2026-10-19']);
  assert.equal(from, addDays('2026-10-20', -397));
  assert.equal(to, '2026-10-20');
  // load() asks for one extra day on each side.
  assert.equal(dayCount(addDays(from, -1), addDays(to, 1)), 400);
});
