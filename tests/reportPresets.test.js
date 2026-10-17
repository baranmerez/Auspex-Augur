import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveBuiltInPreset, resolvePreset, validatePresets, sqlParamCount, builtInPresetKeys, builtInPresetsFor, mismatchedPresets,
} from '../src/reports/presets.js';
import { ReportService } from '../src/reports/service.js';
import { ReadOnlyDatabase } from '../src/db.js';

const fail = msg => new Error(msg);
const at = (y, m, d, hh = 12) => new Date(y, m - 1, d, hh, 0, 0);

// Runs fn with the process time zone set to tz (Node re-reads TZ on change).
function inZone(tz, fn) {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
  }
}

test('each built-in preset resolves to [start inclusive, end exclusive) ISO dates', () => {
  const now = at(2026, 5, 15);
  assert.deepEqual(resolveBuiltInPreset('today', now), ['2026-05-15', '2026-05-16']);
  assert.deepEqual(resolveBuiltInPreset('yesterday', now), ['2026-05-14', '2026-05-15']);
  assert.deepEqual(resolveBuiltInPreset('last_7_days', now), ['2026-05-09', '2026-05-16']);
  assert.deepEqual(resolveBuiltInPreset('this_month', now), ['2026-05-01', '2026-06-01']);
  assert.deepEqual(resolveBuiltInPreset('last_month', now), ['2026-04-01', '2026-05-01']);
  assert.deepEqual(resolveBuiltInPreset('this_year', now), ['2026-01-01', '2027-01-01']);
  assert.deepEqual(resolveBuiltInPreset('last_year', now), ['2025-01-01', '2026-01-01']);
  assert.equal(resolveBuiltInPreset('next_week', now), null);
  assert.deepEqual(builtInPresetKeys, ['today', 'yesterday', 'last_7_days', 'this_month', 'last_month', 'this_year', 'last_year']);
});

test('month and year boundaries roll over correctly', () => {
  assert.deepEqual(resolveBuiltInPreset('yesterday', at(2026, 1, 1)), ['2025-12-31', '2026-01-01']);
  assert.deepEqual(resolveBuiltInPreset('last_month', at(2026, 1, 20)), ['2025-12-01', '2026-01-01']);
  assert.deepEqual(resolveBuiltInPreset('this_month', at(2026, 12, 31)), ['2026-12-01', '2027-01-01']);
  assert.deepEqual(resolveBuiltInPreset('last_7_days', at(2026, 3, 3)), ['2026-02-25', '2026-03-04']);
  assert.deepEqual(resolveBuiltInPreset('last_7_days', at(2024, 3, 3)), ['2024-02-26', '2024-03-04'], 'leap year');
  assert.deepEqual(resolveBuiltInPreset('today', at(2026, 12, 31, 23)), ['2026-12-31', '2027-01-01']);
  assert.deepEqual(resolveBuiltInPreset('today', at(2026, 6, 1, 0)), ['2026-06-01', '2026-06-02']);
});

test('built-in presets are DST-safe: days around a clock change keep their calendar dates', () => {
  inZone('America/New_York', () => {
    // 2026-03-08 springs forward, 2026-11-01 falls back.
    assert.deepEqual(resolveBuiltInPreset('today', new Date(2026, 2, 8, 0, 30)), ['2026-03-08', '2026-03-09']);
    assert.deepEqual(resolveBuiltInPreset('yesterday', new Date(2026, 2, 9, 0, 30)), ['2026-03-08', '2026-03-09']);
    assert.deepEqual(resolveBuiltInPreset('last_7_days', new Date(2026, 2, 10, 0, 30)), ['2026-03-04', '2026-03-11']);
    assert.deepEqual(resolveBuiltInPreset('today', new Date(2026, 10, 1, 23, 30)), ['2026-11-01', '2026-11-02']);
    assert.deepEqual(resolveBuiltInPreset('yesterday', new Date(2026, 10, 2, 0, 15)), ['2026-11-01', '2026-11-02']);
  });
  inZone('Europe/Berlin', () => {
    // 2026-03-29 02:00 -> 03:00.
    assert.deepEqual(resolveBuiltInPreset('last_month', new Date(2026, 3, 1, 0, 5)), ['2026-03-01', '2026-04-01']);
    assert.deepEqual(resolveBuiltInPreset('yesterday', new Date(2026, 2, 30, 0, 5)), ['2026-03-29', '2026-03-30']);
  });
});

test('the SQL parameter count is the highest $n outside literals and comments', () => {
  assert.equal(sqlParamCount('select 1'), 0);
  assert.equal(sqlParamCount('select * from example.orders where created_at >= $1 and created_at < $2'), 2);
  assert.equal(sqlParamCount("select '$5', $1 -- $9\n, $$ $7 $$, \"a$3\", x$4"), 1);
  assert.equal(sqlParamCount('select $3::int'), 3);
  assert.deepEqual(builtInPresetsFor(2, true), builtInPresetKeys);
  assert.deepEqual(builtInPresetsFor(2, false), [], 'two parameters alone are not a date range');
  assert.deepEqual(builtInPresetsFor(2), []);
  assert.deepEqual(builtInPresetsFor(1, true), []);
  assert.deepEqual(builtInPresetsFor(3, true), []);
});

test('custom presets are validated: names, uniqueness, built-in names, length and value types', () => {
  const ok = validatePresets([{ name: '  April 2023 trial ', params: ['2023-04-01', '2023-05-01'] }], 2, fail);
  assert.deepEqual(ok, [{ name: 'April 2023 trial', params: ['2023-04-01', '2023-05-01'] }]);
  assert.deepEqual(validatePresets([{ name: 'Mixed', params: ['a', 1, true, null] }], 4, fail)[0].params, ['a', 1, true, null]);
  assert.deepEqual(validatePresets([], 2, fail), []);
  const bad = [
    [[{ name: '', params: [1] }], /1-60 characters/],
    [[{ name: 'x'.repeat(61), params: [1] }], /1-60 characters/],
    [[{ name: 'A', params: [1] }, { name: 'a', params: [2] }], /used twice/],
    [[{ name: 'Today', params: [1] }], /built-in preset name/],
    [[{ name: 'A', params: [1, 2] }], /2 value\(s\), but the SQL uses 1/],
    [[{ name: 'A', params: [{}] }], /strings, numbers, booleans or null/],
    [[{ name: 'A', params: [Number.NaN] }], /strings, numbers, booleans or null/],
    [[{ name: 'A', params: 'x' }], /params must be an array/],
    [[{ name: 'A\nB', params: [1] }], /control characters/],
    ['nope', /must be an array/],
  ];
  for (const [input, re] of bad) assert.throws(() => validatePresets(input, 1, fail), re, JSON.stringify(input));
  assert.throws(() => validatePresets(Array.from({ length: 51 }, (_, i) => ({ name: `p${i}`, params: [] })), 0, fail), /At most 50/);
  assert.deepEqual(mismatchedPresets([{ name: 'A', params: [1] }, { name: 'B', params: [1, 2] }], 2), ['A']);
});

test('resolvePreset: built-in needs dateRange and two parameters, custom is found case-insensitively, unknown lists the names', () => {
  const now = at(2026, 5, 15);
  assert.deepEqual(resolvePreset('this_month', [], 2, fail, now, true), { preset: 'this_month', params: ['2026-05-01', '2026-06-01'], builtIn: true });
  assert.throws(() => resolvePreset('this_month', [], 2, fail, now), /no date-range parameters; save it with dateRange: true/);
  assert.throws(() => resolvePreset('today', [], 3, fail, now, true), /exactly 2 parameters/);
  const presets = [{ name: 'April 2023 trial', params: ['2023-04-01', '2023-05-01'] }];
  assert.deepEqual(resolvePreset('april 2023 TRIAL', presets, 2, fail), { preset: 'April 2023 trial', params: ['2023-04-01', '2023-05-01'], builtIn: false });
  assert.throws(() => resolvePreset('April 2023 trial', presets, 1, fail), /current SQL uses 1/);
  assert.throws(() => resolvePreset('missing', presets, 2, fail, now, true), /Available: today, .*April 2023 trial/);
  assert.throws(() => resolvePreset('missing', presets, 2, fail, now, false), /Available: April 2023 trial\./);
});

// ReportService over a temp library and a fake database that records params.
function tempService() {
  const calls = [];
  const fake = {
    resolveProfile: name => String(name).toLowerCase(),
    async runReport(profile, sql, options) {
      calls.push(options.params);
      fake.lastOptions = options;
      return { profile, serverVersion: '16.0', plan: [{ Plan: { 'Node Type': 'Result', 'Total Cost': 0.01, 'Plan Rows': 1 } }], explainMs: 1, previewMs: 1,
        columns: [{ name: 'order_id', type: 'integer' }], rows: [[1]], rowCount: 1, truncated: false, previewExecuted: true };
    },
  };
  const svc = new ReportService(fake, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-preset-test-')));
  return { svc, calls, fake };
}
const ref = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'Orders by day' };
const rangeSql = 'select count(*) as orders from example.orders where created_at >= $1 and created_at < $2';

test('save_report stores presets, replaces them when given and keeps them otherwise', () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: rangeSql, presets: [{ name: 'April 2023 trial', params: ['2023-04-01', '2023-05-01'] }] });
  assert.deepEqual(svc.library.readMeta('draft', ref).presets, [{ name: 'April 2023 trial', params: ['2023-04-01', '2023-05-01'] }]);
  svc.save({ ...ref, sql: rangeSql + ' -- v2' });
  assert.equal(svc.library.readMeta('draft', ref).presets.length, 1, 'kept when presets is not passed');
  svc.save({ ...ref, sql: rangeSql, presets: [] });
  assert.deepEqual(svc.library.readMeta('draft', ref).presets, []);
  assert.throws(() => svc.save({ ...ref, sql: rangeSql, presets: [{ name: 'Short', params: ['2023-04-01'] }] }), /SQL uses 2/);
});

test('saving SQL with another parameter count reports presets that no longer fit', () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: rangeSql, presets: [{ name: 'Q1', params: ['2026-01-01', '2026-04-01'] }] });
  const res = svc.save({ ...ref, sql: 'select count(*) from example.orders where status_code = $1' });
  assert.deepEqual(res.presetMismatch, ['Q1']);
  assert.ok(!('presetMismatch' in svc.save({ ...ref, sql: rangeSql })));
});

test('dateRange is opt-in, needs exactly two parameters and is kept until changed', async () => {
  const { svc, calls } = tempService();
  // Two parameters that are not a date range: no built-in presets.
  const statusSql = 'select count(*) from example.orders where status_code = $1 and customer_id = $2';
  svc.save({ ...ref, sql: statusSql });
  assert.deepEqual(svc.list()[0].presets.builtIn, []);
  assert.equal(svc.list()[0].dateRange, false);
  await assert.rejects(svc.run(ref, { preset: 'today' }), /no date-range parameters; save it with dateRange: true/);
  assert.equal(calls.length, 0);
  assert.throws(() => svc.save({ ...ref, sql: 'select count(*) from example.orders where created_at >= $1', dateRange: true }), /exactly 2 parameters/);
  svc.save({ ...ref, sql: rangeSql, dateRange: true });
  assert.deepEqual(svc.list()[0].presets.builtIn, builtInPresetKeys);
  svc.save({ ...ref, sql: rangeSql + ' -- v2' });
  assert.equal(svc.list()[0].dateRange, true, 'kept when dateRange is not passed');
  svc.save({ ...ref, sql: rangeSql, dateRange: false });
  assert.deepEqual(svc.list()[0].presets.builtIn, []);
});

test('the audit entry of a preset run records the preset next to the resolved params', async () => {
  const entries = [];
  const client = {
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      if (text.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Total Cost': 0.01, 'Plan Rows': 1 } }] }] };
      if (text.startsWith('FETCH')) return { rows: [[1]], fields: [{ name: 'order_id', dataTypeID: 23 }] };
      if (text.includes('pg_type')) return { rows: [{ oid: 23, name: 'integer' }] };
      if (text.includes('server_version')) return { rows: [{ v: '16.0' }] };
      return { rows: [] };
    },
    release() {},
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['exampledb', 'postgresql://u@127.0.0.1:1/a']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500,
  }, { audit: e => entries.push(e) });
  db.pool = () => ({ connect: async () => client });
  db.roleChecks.set('exampledb', { status: 'ok', blocking: [], warnings: [] });
  const svc = new ReportService(db, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-preset-audit-')));
  svc.save({ ...ref, sql: rangeSql, dateRange: true });
  await svc.run(ref, { preset: 'last_year' });
  await svc.run(ref, { params: ['2026-01-01', '2026-02-01'] });
  const runs = entries.filter(e => e.tool === 'run_report');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].preset, 'last_year');
  assert.deepEqual(runs[0].params, resolveBuiltInPreset('last_year'));
  assert.ok(!('preset' in runs[1]));
});

test('run_report with a preset resolves the values and records the preset; params still work; both together are refused', async () => {
  const { svc, calls, fake } = tempService();
  svc.save({ ...ref, sql: rangeSql, dateRange: true, presets: [{ name: 'April 2023 trial', params: ['2023-04-01', '2023-05-01'] }] });
  const a = await svc.run(ref, { preset: 'April 2023 trial' });
  assert.equal(a.preset, 'April 2023 trial');
  assert.deepEqual(a.params, ['2023-04-01', '2023-05-01']);
  assert.deepEqual(calls.at(-1), ['2023-04-01', '2023-05-01']);
  assert.equal(fake.lastOptions.preset, 'April 2023 trial', 'the preset reaches the audited database call');
  const b = await svc.run(ref, { preset: 'today' });
  assert.equal(b.preset, 'today');
  assert.deepEqual(b.params, resolveBuiltInPreset('today'));
  const c = await svc.run(ref, { params: ['2026-01-01', '2026-02-01'] });
  assert.ok(!('preset' in c));
  assert.deepEqual(calls.at(-1), ['2026-01-01', '2026-02-01']);
  const runs = svc.library.readMeta('draft', ref).runs;
  assert.deepEqual(runs.map(r => [r.preset, r.params]), [
    ['April 2023 trial', ['2023-04-01', '2023-05-01']], ['today', resolveBuiltInPreset('today')], [null, ['2026-01-01', '2026-02-01']],
  ]);
  await assert.rejects(svc.run(ref, { preset: 'today', params: ['x', 'y'] }), /either preset or params/);
  await assert.rejects(svc.run(ref, { preset: 'missing' }), /Unknown preset/);
  assert.equal(calls.length, 3, 'refused runs never reach the database');
});

test('list_reports shows the presets and the preset of the last run; the HTML embeds them, a shared copy does not', async () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: rangeSql, dateRange: true, presets: [{ name: 'April 2023 trial', params: ['2023-04-01', '2023-05-01'] }] });
  await svc.run(ref, { preset: 'last_month' });
  const [item] = svc.list();
  assert.equal(item.paramCount, 2);
  assert.deepEqual(item.presets, { builtIn: builtInPresetKeys, custom: ['April 2023 trial'], mismatched: [] });
  assert.equal(item.lastRun.preset, 'last_month');
  const html = fs.readFileSync(svc.library.paths('draft', ref).html, 'utf8');
  const data = JSON.parse(html.match(/<script id="auspex-report" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.presets, { paramCount: 2, builtIn: builtInPresetKeys, custom: [{ name: 'April 2023 trial', params: ['2023-04-01', '2023-05-01'] }], mismatched: [] });
  const shared = svc.share(ref, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-preset-share-')));
  const sharedHtml = fs.readFileSync(shared.file, 'utf8');
  assert.ok(!sharedHtml.includes('April 2023 trial') && !sharedHtml.includes('"presets"'), 'no presets in a shared copy');
  // Without parameters: no built-in presets.
  svc.save({ ...ref, name: 'All orders', sql: 'select count(*) from example.orders' });
  const plain = svc.list().find(i => i.name === 'all-orders');
  assert.deepEqual(plain.presets, { builtIn: [], custom: [], mismatched: [] });
});

test('custom presets that no longer fit the SQL are listed as mismatched in list_reports and the embedded data', () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: rangeSql, presets: [{ name: 'Q1', params: ['2026-01-01', '2026-04-01'] }] });
  svc.save({ ...ref, sql: 'select count(*) from example.orders where status_code = $1' });
  assert.deepEqual(svc.list()[0].presets.mismatched, ['Q1']);
  const html = fs.readFileSync(svc.library.paths('draft', ref).html, 'utf8');
  const data = JSON.parse(html.match(/<script id="auspex-report" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.presets.mismatched, ['Q1']);
});
