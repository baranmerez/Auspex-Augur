import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../src/reports/library.js';
import { schedulerDatabase } from '../src/schedule/runner.js';
import { readState, readTrend, trendFile, appendTrend, recordResult } from '../src/schedule/store.js';
import { notificationText } from '../src/schedule/notify.js';
import { main } from '../src/scheduleCli.js';

// #146 / EN03: the report execution and the local writes after it (trend
// point, scheduler state) are separate outcomes. Faults are injected at each
// write boundary through the runner's persist adapters; recovery never runs
// the report SQL again and never adds a second point for a slot.
const ref = { db: 'local', schema: 'example', category: 'Orders', name: 'example-report' };
const sql = 'select status_code, count(*) as orders from example.orders where created_at >= $1::date and created_at < $2::date group by status_code';
let home, env, explains, notes;

function fakeClient() {
  const fields = [{ name: 'status_code', dataTypeID: 25 }, { name: 'orders', dataTypeID: 20 }];
  return {
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      if (text.startsWith('EXPLAIN')) {
        explains += 1;
        return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Total Cost': 1, 'Plan Rows': 2, 'Actual Rows': 2, 'Actual Loops': 1, 'Actual Total Time': 0.5 }, 'Planning Time': 0.1, 'Execution Time': 0.6 }] }] };
      }
      if (text.startsWith('FETCH')) return { rows: [['A', '3'], ['B', '4']], fields };
      if (text.includes('pg_type')) return { rows: [{ oid: 25, name: 'text' }, { oid: 20, name: 'bigint' }] };
      if (text.includes('server_version')) return { rows: [{ v: '16.0' }] };
      return { rows: [] };
    },
    release() {},
  };
}

function makeDb() {
  const db = schedulerDatabase({ profiles: new Map([['local', 'postgresql://u@127.0.0.1:1/a']]), statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500 },
    { audit: () => {} });
  db.pool = () => ({ connect: async () => fakeClient(), end: async () => {} });
  db.roleChecks.set('local', { status: 'ok', blocking: [], warnings: [] });
  return db;
}

const stateFile = () => path.join(home, 'schedule-state.json');
const points = () => readTrend(trendFile(path.join(home, 'trends'), ref));
const slotKey = '2026-10-12T08:00';
const tuesday = new Date(2026, 9, 13, 10, 0);

// A write that fails with a synthetic EACCES while failing() is true.
function faulty(fn, failing) {
  return (...args) => {
    if (failing()) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', syscall: 'open' });
    return fn(...args);
  };
}

const runDue = (persist = {}) => main(['run-due'], env, { db: makeDb(), notifyFn: async m => { notes.push(m); return 'log'; }, now: () => tuesday, persist });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-schedule-persist-'));
  env = { AUSPEX_HOME: home, AUSPEX_DB_LOCAL: 'postgresql://u@127.0.0.1:1/a' };
  explains = 0;
  notes = [];
  const lib = new Library(path.join(home, 'library'));
  const saved = lib.saveDraft({ ref, title: 'Example report', sql, dateRange: true });
  lib.appendRun('draft', ref, { at: new Date().toISOString(), sqlHash: saved.hash, version: saved.version }, null);
  lib.approve(ref);
  fs.writeFileSync(path.join(home, 'schedules.json'), JSON.stringify({
    notify: 'failures',
    schedules: [{ id: 'weekly-example', profile: 'local', report: ref, preset: 'last_7_days', cadence: { weekly: 'monday', at: '08:00' } }],
  }));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test('no fault: execution and persistence both ok, exit 0, one point', async () => {
  const r = await runDue();
  assert.equal(r.status, 0);
  assert.deepEqual(r.out.results.map(x => [x.status, x.persistence]), [['ok', { trend: 'ok', state: 'ok' }]]);
  assert.equal(points().length, 1);
  assert.deepEqual([points()[0].scheduleId, points()[0].slot], ['weekly-example', slotKey]);
  assert.deepEqual(notes, [], 'failures mode: a clean run does not notify');
  assert.equal((await runDue()).out.ran, 0);
  assert.equal(explains, 1);
});

test('trend write fails: exit 1 and a notification; the next run-due appends the point from state without SQL', async () => {
  let fail = true;
  const r = await runDue({ appendTrend: faulty(appendTrend, () => fail) });
  assert.equal(r.status, 1, 'a persistence failure fails the CLI run');
  const [res] = r.out.results;
  assert.equal(res.status, 'ok', 'the report execution itself succeeded');
  assert.deepEqual(res.persistence, { trend: 'failed', state: 'ok', error: { code: 'DISK_ERROR', message: 'EACCES (open)' } });
  assert.equal(res.trendError, 'DISK_ERROR');
  assert.equal(points().length, 0);
  const entry = readState(stateFile()).schedules['weekly-example'];
  assert.equal(entry.lastSuccessSlot, slotKey);
  assert.equal(entry.pendingTrend.slot, slotKey);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].persistenceError, 'DISK_ERROR');
  const text = notificationText(notes[0]).text;
  assert.match(text, /saving its trend point or the scheduler state failed \(DISK_ERROR\)/);
  assert.ok(!/select|example\.orders|2026-10-06/i.test(JSON.stringify(notes[0]) + text), 'no SQL or parameters in the notification');

  fail = false;
  const repair = await runDue({ appendTrend: faulty(appendTrend, () => fail) });
  assert.equal(repair.status, 0);
  assert.equal(repair.out.ran, 0);
  assert.deepEqual(repair.out.repairs.map(x => [x.repaired, x.slot, x.persistence]), [['trend', slotKey, { trend: 'ok', state: 'ok' }]]);
  assert.equal(points().length, 1);
  assert.equal(points()[0].rows, 2);
  assert.equal(readState(stateFile()).schedules['weekly-example'].pendingTrend, undefined);
  assert.equal(explains, 1, 'the report SQL ran once');
  const third = await runDue();
  assert.equal(third.out.repairs, undefined);
  assert.equal(points().length, 1);
});

test('state write fails: exit 1; the next run-due reconciles the slot from its trend point, one point, no rerun', async () => {
  let fail = true;
  const r = await runDue({ recordResult: faulty(recordResult, () => fail) });
  assert.equal(r.status, 1);
  assert.deepEqual(r.out.results[0].persistence, { trend: 'ok', state: 'failed', error: { code: 'DISK_ERROR', message: 'EACCES (open)' } });
  assert.equal(points().length, 1);
  assert.equal(fs.existsSync(stateFile()), false);
  fail = false;
  const next = await runDue();
  assert.equal(next.status, 0);
  assert.equal(next.out.ran, 0, 'the slot is not run again');
  assert.deepEqual(next.out.repairs.map(x => [x.repaired, x.persistence]), [['state', { trend: 'ok', state: 'ok' }]]);
  const entry = readState(stateFile()).schedules['weekly-example'];
  assert.deepEqual([entry.lastSuccessSlot, entry.last.reconciled], [slotKey, true]);
  assert.equal(points().length, 1);
  assert.equal(explains, 1);
});

test('trend and state writes both fail: the next run-due rebuilds the point from the saved run, no rerun', async () => {
  let fail = true;
  const r = await runDue({ appendTrend: faulty(appendTrend, () => fail), recordResult: faulty(recordResult, () => fail) });
  assert.deepEqual(r.out.results[0].persistence.trend, 'failed');
  assert.deepEqual(r.out.results[0].persistence.state, 'failed');
  const meta = new Library(path.join(home, 'library')).readMeta('approved', ref);
  assert.deepEqual(meta.runs.at(-1).schedule, { id: 'weekly-example', slot: slotKey }, 'the saved run names its slot');
  fail = false;
  const next = await runDue();
  assert.equal(next.status, 0);
  assert.equal(next.out.ran, 0);
  assert.equal(points().length, 1);
  assert.deepEqual([points()[0].slot, points()[0].rows, points()[0].preset], [slotKey, 2, 'last_7_days']);
  assert.equal(readState(stateFile()).schedules['weekly-example'].lastSuccessSlot, slotKey);
  assert.equal(explains, 1);
});

test('a corrupt state file stops the scheduler before any SQL and is left unchanged', async () => {
  fs.writeFileSync(stateFile(), '{ "schedules": ');
  const r = await runDue();
  assert.equal(r.status, 1);
  assert.equal(r.out.code, 'STATE_UNREADABLE');
  assert.equal(r.out.file, stateFile());
  assert.match(r.out.message, /schedule-state\.json cannot be read .* left unchanged/);
  assert.equal(fs.readFileSync(stateFile(), 'utf8'), '{ "schedules": ');
  assert.equal(explains, 0);
  assert.throws(() => recordResult(stateFile(), 'weekly-example', { status: 'ok', slot: slotKey, at: 'x' }), /cannot be read/);
  assert.equal(fs.readFileSync(stateFile(), 'utf8'), '{ "schedules": ', 'never overwritten');
  const status = await main(['status'], env, { now: () => tuesday });
  assert.match(status.out.stateError, /cannot be read/);
  assert.deepEqual(readState(stateFile()), { schedules: {} }, 'readers without strict still see an empty state');
});

test('trend points are idempotent per schedule and slot; older points without keys stay readable', () => {
  const root = path.join(home, 'trends');
  const file = trendFile(root, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ v: 1, ranAt: '2026-01-01T00:00:00.000Z', rows: 5 })}\n`);
  const point = { v: 1, scheduleId: 'weekly-example', slot: slotKey, rows: 2 };
  assert.equal(appendTrend(root, ref, point).points, 2);
  assert.deepEqual(appendTrend(root, ref, { ...point, rows: 9 }), { file, points: 2, duplicate: true });
  assert.equal(appendTrend(root, ref, { ...point, slot: '2026-10-19T08:00' }).points, 3);
  assert.deepEqual(readTrend(file).map(p => p.rows), [5, 2, 2]);
});
