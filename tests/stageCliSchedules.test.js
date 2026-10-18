import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendTrend, recordResult } from '../src/schedule/store.js';
import { scheduleIndex, reportTrend } from '../src/schedule/viewerData.js';

// The read-only `schedules` and `trend` commands of src/stageCli.js, which the
// desktop app runs for its report list: the same data the browser viewer
// builds from src/schedule/viewerData.js, written nowhere.
const cli = fileURLToPath(new URL('../src/stageCli.js', import.meta.url));
const ref = { db: 'exampledb', schema: 'example', category: 'Orders/Delivery', name: 'example-report' };

function homeWith({ schedules, state = true, trend = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-cli-sched-'));
  if (schedules !== undefined) fs.writeFileSync(path.join(home, 'schedules.json'), typeof schedules === 'string' ? schedules : JSON.stringify(schedules));
  if (state) recordResult(path.join(home, 'schedule-state.json'), 'weekly-example', { status: 'ok', slot: '2026-10-12T08:00', at: '2026-10-12T06:00:00.000Z' });
  if (trend) appendTrend(path.join(home, 'trends'), ref, { v: 1, slot: '2026-10-12T08:00', ranAt: '2026-10-12T06:00:00.000Z', preset: 'last_7_days', params: ['2026-10-05', '2026-10-12'], rows: 3, totals: [{ column: 'amount', total: '12345678901234.57' }] });
  return home;
}

function run(home, args) {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json') };
  const res = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `one JSON line: ${res.stdout}${res.stderr}`);
  return { status: res.status, out: JSON.parse(lines[0]) };
}

const schedules = { schedules: [{ id: 'weekly-example', profile: 'exampledb', report: ref, preset: 'last_7_days', cadence: { weekly: 'monday', at: '08:00' } }] };

test('schedules lists each report\'s schedules as [key, schedules] pairs, like the viewer index', () => {
  const home = homeWith({ schedules });
  const { status, out } = run(home, ['schedules']);
  assert.equal(status, 0);
  assert.equal(out.ok, true);
  assert.equal(out.error, null);
  const expected = scheduleIndex({ env: { AUSPEX_HOME: home } });
  assert.deepEqual(out.byReport.map(([k]) => k), [...expected.byReport.keys()]);
  const [key, items] = out.byReport[0];
  assert.equal(key, 'exampledb|example|Orders/Delivery|example-report');
  assert.equal(items[0].id, 'weekly-example');
  assert.equal(items[0].cadence, 'weekly monday 08:00');
  assert.deepEqual(items[0].last, { status: 'ok', slot: '2026-10-12T08:00', at: '2026-10-12T06:00:00.000Z' });
  assert.match(items[0].next, /^\d{4}-\d{2}-\d{2}T08:00$/);
  assert.deepEqual(fs.readdirSync(home).sort(), ['schedule-state.json', 'schedules.json', 'trends'], 'nothing is written');
});

test('a broken schedules file is reported as error, not as a failure', () => {
  const { status, out } = run(homeWith({ schedules: '{"schedules": [{"id": "x"}]}' }), ['schedules']);
  assert.equal(status, 0);
  assert.equal(out.ok, true);
  assert.equal(typeof out.error, 'string');
  assert.deepEqual(out.byReport, []);
  assert.equal(run(homeWith({ schedules }), ['schedules', '--extra']).out.code, 'INVALID_INPUT');
});

test('trend returns the report\'s points without parameter values, like GET /api/reports/trend', () => {
  const home = homeWith({ schedules });
  const { status, out } = run(home, ['trend', '--db', ref.db, '--schema', ref.schema, '--category', ref.category, '--name', ref.name]);
  assert.equal(status, 0);
  assert.deepEqual(out.points, reportTrend(ref, { env: { AUSPEX_HOME: home } }).points);
  assert.equal(out.points.length, 1);
  assert.equal(out.points[0].params, undefined, 'parameter values are left out');
  assert.deepEqual(out.points[0].totals, [{ column: 'amount', total: '12345678901234.57' }]);
});

test('trend refuses a bad location or unknown arguments', () => {
  const home = homeWith({ schedules });
  const bad = run(home, ['trend', '--db', '../x', '--schema', 'example', '--category', 'Orders', '--name', 'example-report']);
  assert.equal(bad.status, 1);
  assert.equal(bad.out.ok, false);
  assert.equal(bad.out.code, 'INVALID_INPUT');
  assert.equal(run(home, ['trend', '--expected-hash', 'abc']).out.ok, false);
});
