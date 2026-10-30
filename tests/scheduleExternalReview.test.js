import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../src/reports/library.js';
import { schedulerDatabase } from '../src/schedule/runner.js';
import { readState, readTrend, trendFile, hasTrendPoint } from '../src/schedule/store.js';
import { main } from '../src/scheduleCli.js';

// Regression tests for the external review of the scheduler persistence
// outcome (F1, F3, F4, F6, F7): evidence of a finished slot is never ignored,
// a repair never runs the report SQL again and never writes into the wrong
// trend. Faults are injected through the runner's persist adapters.
const refA = { db: 'local', schema: 'example', category: 'Orders', name: 'example-daily' };
const refB = { db: 'local', schema: 'example', category: 'Orders', name: 'example-other' };
const sqlA = 'select status_code, count(*) as orders from example.orders group by status_code';
const sqlB = 'select customer_id, count(*) as n from example.customers group by customer_id';
let home, env, explains;

function fakeClient() {
  const fields = [{ name: 'k', dataTypeID: 25 }, { name: 'n', dataTypeID: 20 }];
  return {
    async query(q) {
      const t = typeof q === 'string' ? q : q.text;
      if (t.startsWith('EXPLAIN')) {
        explains += 1;
        return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Total Cost': 1, 'Plan Rows': 2, 'Actual Rows': 2, 'Actual Loops': 1, 'Actual Total Time': 0.5 }, 'Planning Time': 0.1, 'Execution Time': 0.6 }] }] };
      }
      if (t.startsWith('FETCH')) return { rows: [['A', '3'], ['B', '4']], fields };
      if (t.includes('pg_type')) return { rows: [{ oid: 25, name: 'text' }, { oid: 20, name: 'bigint' }] };
      if (t.includes('server_version')) return { rows: [{ v: '16.0' }] };
      return { rows: [] };
    },
    release() {},
  };
}
function makeDb() {
  const db = schedulerDatabase({ profiles: new Map([['local', 'postgresql://u@127.0.0.1:1/a']]), statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500 }, { audit: () => {} });
  db.pool = () => ({ connect: async () => fakeClient(), end: async () => {} });
  db.roleChecks.set('local', { status: 'ok', blocking: [], warnings: [] });
  return db;
}
const eacces = () => Object.assign(new Error('EACCES'), { code: 'EACCES', syscall: 'open' });
const writeSchedules = schedules => fs.writeFileSync(path.join(home, 'schedules.json'), JSON.stringify({ notify: 'none', schedules }));
const daily = (report = refA) => [{ id: 'example-daily', profile: 'local', report, cadence: { daily: true, at: '08:00' } }];
const runDue = (now, persist = {}) => main(['run-due'], env, { db: makeDb(), notifyFn: async () => 'log', now: () => now, persist });
const stateFile = () => path.join(home, 'schedule-state.json');
const points = ref => readTrend(trendFile(path.join(home, 'trends'), ref));
const library = () => new Library(path.join(home, 'library'));
const d1 = new Date(2026, 9, 12, 9, 0);
const d1b = new Date(2026, 9, 12, 10, 0);
const d2 = new Date(2026, 9, 13, 9, 0);
const slot1 = '2026-10-12T08:00';
const slot2 = '2026-10-13T08:00';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-schedule-review-'));
  env = { AUSPEX_HOME: home, AUSPEX_DB_LOCAL: 'postgresql://u@127.0.0.1:1/a' };
  explains = 0;
  const lib = library();
  for (const [ref, sql] of [[refA, sqlA], [refB, sqlB]]) {
    const s = lib.saveDraft({ ref, title: ref.name, sql });
    lib.appendRun('draft', ref, { at: new Date().toISOString(), sqlHash: s.hash, version: s.version }, null);
    lib.approve(ref);
  }
  writeSchedules(daily());
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test('F1: unreadable evidence (trend file and report metadata) never reruns the SQL; state "unknown" is retried next time', async () => {
  await runDue(d1, { recordResult: () => { throw eacces(); } });
  assert.equal(explains, 1);
  const original = Library.prototype.readMeta;
  let metaFail = 1;
  Library.prototype.readMeta = function readMeta(...args) {
    if (metaFail-- > 0) throw eacces();
    return original.apply(this, args);
  };
  let r;
  try {
    r = await runDue(d1b, { hasTrendPoint: () => { throw eacces(); } });
  } finally {
    Library.prototype.readMeta = original;
  }
  assert.equal(r.status, 1, 'an unknown outcome is not a success');
  assert.equal(r.out.ran, 0);
  assert.deepEqual(r.out.repairs.map(x => [x.slot, x.persistence.trend, x.persistence.state]), [[slot1, 'unknown', 'unknown']]);
  assert.equal(explains, 1, 'no rerun');
  const next = await runDue(d1b);
  assert.equal(next.status, 0);
  assert.deepEqual(next.out.repairs.map(x => [x.slot, x.persistence.state]), [[slot1, 'ok']]);
  assert.equal(readState(stateFile()).schedules['example-daily'].lastSuccessSlot, slot1);
  assert.equal(points(refA).length, 1);
  assert.equal(explains, 1);
});

test('F1 control: an unreadable trend file alone still finds the saved run', async () => {
  await runDue(d1, { recordResult: () => { throw eacces(); } });
  const r = await runDue(d1b, { hasTrendPoint: () => { throw eacces(); } });
  assert.equal(r.out.ran, 0);
  assert.deepEqual(r.out.repairs.map(x => [x.persistence.trend, x.persistence.state]), [['ok', 'ok']]);
  assert.equal(points(refA).length, 1, 'the existing point is not duplicated');
  assert.equal(explains, 1);
});

test('F3: an older finished slot the scheduler moved past is repaired; lastSuccessSlot never moves back', async () => {
  await runDue(d1, { appendTrend: () => { throw eacces(); }, recordResult: () => { throw eacces(); } });
  const r = await runDue(d2);
  assert.equal(r.status, 0);
  assert.deepEqual(r.out.repairs.map(x => [x.slot, x.repaired, x.persistence.trend]), [[slot1, 'state', 'ok']]);
  assert.deepEqual(r.out.results.map(x => x.slot), [slot2], 'the new slot runs');
  assert.deepEqual(points(refA).map(p => p.slot), [slot1, slot2]);
  assert.equal(readState(stateFile()).schedules['example-daily'].lastSuccessSlot, slot2);
  assert.equal(explains, 2);
  const again = await runDue(d2);
  assert.deepEqual([again.out.ran, again.out.repairs], [0, undefined]);
});

test('F4: a pending point goes to the report it was taken from, even when the schedule changed report', async () => {
  await runDue(d1, { appendTrend: () => { throw eacces(); } });
  assert.deepEqual(readState(stateFile()).schedules['example-daily'].pendingTrends[0].report, refA);
  writeSchedules(daily(refB));
  const r = await runDue(d1b);
  assert.deepEqual(r.out.repairs.map(x => [x.repaired, x.persistence.trend]), [['trend', 'ok']]);
  assert.equal(points(refA).length, 1);
  assert.equal(points(refB).length, 0);
});

test('F4: a legacy pending point without its report is replayed only to a verifiably same report, else lost', async () => {
  await runDue(d1, { appendTrend: () => { throw eacces(); } });
  const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  const entry = state.schedules['example-daily'];
  entry.pendingTrend = { slot: entry.pendingTrends[0].slot, point: entry.pendingTrends[0].point }; // earlier build: no report
  delete entry.pendingTrends;
  fs.writeFileSync(stateFile(), JSON.stringify(state));
  writeSchedules(daily(refB));
  const r = await runDue(d1b);
  assert.equal(r.status, 1, 'a lost point is reported');
  assert.deepEqual(r.out.repairs.map(x => [x.persistence.trend, x.persistence.trendLost]), [['lost', [slot1]]]);
  assert.equal(points(refB).length, 0, 'never written into another report');
  assert.equal(points(refA).length, 0);
  assert.equal(readState(stateFile()).schedules['example-daily'].pendingTrends, undefined);
});

test('F4 control: a legacy pending point of the same report is replayed', async () => {
  await runDue(d1, { appendTrend: () => { throw eacces(); } });
  const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  const entry = state.schedules['example-daily'];
  entry.pendingTrend = { slot: entry.pendingTrends[0].slot, point: entry.pendingTrends[0].point };
  delete entry.pendingTrends;
  fs.writeFileSync(stateFile(), JSON.stringify(state));
  const r = await runDue(d1b);
  assert.equal(r.status, 0);
  assert.equal(points(refA).length, 1);
});

test('F6: a schedule entry that is not an object stops the run; the file is left unchanged', async () => {
  const text = JSON.stringify({ schedules: { 'example-daily': null, 'example-other': 'garbage' } });
  fs.writeFileSync(stateFile(), text);
  const r = await runDue(d1);
  assert.equal(r.status, 1);
  assert.equal(r.out.code, 'STATE_UNREADABLE');
  assert.equal(explains, 0);
  assert.equal(fs.readFileSync(stateFile(), 'utf8'), text);
  assert.deepEqual(Object.keys(readState(stateFile()).schedules), ['example-daily', 'example-other'], 'lenient readers unchanged');
});

test('F7: a saved result shared by two runs with the same time is not borrowed; the point is reported lost', async () => {
  await runDue(d1, { recordResult: () => { throw eacces(); } });
  const lib = library();
  const meta = lib.readMeta('approved', refA);
  const tagged = meta.runs.findLast(x => x.schedule);
  const { schedule, ...untagged } = tagged;
  meta.runs.push({ ...untagged, params: ['manual'] });
  meta.last = { ...meta.last, preview: [['Z', '999']], previewTruncated: false, previewExecuted: true };
  lib.writeMeta('approved', refA, meta);
  fs.rmSync(trendFile(path.join(home, 'trends'), refA));
  const r = await runDue(d1b);
  assert.deepEqual(r.out.repairs.map(x => x.persistence), [{ trend: 'lost', state: 'ok' }]);
  assert.equal(points(refA).length, 0, 'no point with another run\'s totals');
  assert.equal(hasTrendPoint(path.join(home, 'trends'), refA, 'example-daily', slot1), false);
  assert.equal(readState(stateFile()).schedules['example-daily'].last.trendLost, true);
  assert.equal(explains, 1);
});

test('F1 follow-up: an unreadable trend file with readable metadata and no saved run lets the slot run; its point goes pending', async () => {
  const r = await runDue(d1, { hasTrendPoint: () => { throw eacces(); }, appendTrend: () => { throw eacces(); } });
  assert.equal(r.out.ran, 1, 'the slot is due and runs');
  assert.deepEqual(r.out.results.map(x => [x.status, x.persistence.trend, x.persistence.state]), [['ok', 'failed', 'ok']]);
  assert.equal(r.out.repairs, undefined, 'no "unknown" repair for a slot that never ran');
  assert.deepEqual(readState(stateFile()).schedules['example-daily'].pendingTrends.map(p => p.slot), [slot1]);
  assert.equal(explains, 1);
});

test('several failing repairs of one schedule send one summary notification with the slot count and range', async () => {
  fs.writeFileSync(path.join(home, 'schedules.json'), JSON.stringify({ notify: 'failures', schedules: daily() }));
  const sent = [];
  const run = (now, persist) => main(['run-due'], env, { db: makeDb(), notifyFn: async m => { sent.push(m); return 'log'; }, now: () => now, persist });
  const fail = () => { throw eacces(); };
  await run(d1, { appendTrend: fail }); // slot 1: point pending, state written
  await run(d2, { appendTrend: fail, recordResult: fail }); // slot 2: point and state both fail
  sent.length = 0;
  const r = await run(new Date(2026, 9, 14, 9, 0), { appendTrend: fail, reconcileSlot: fail });
  assert.deepEqual(r.out.repairs.map(x => [x.slot, x.repaired]), [[slot1, 'trend'], [slot2, 'state']], 'per-slot details stay in the output');
  assert.equal(r.out.ran, 0, 'the newest slot waits for the unrecorded older one');
  assert.equal(sent.length, 1, 'one notification for the schedule');
  assert.deepEqual(sent[0].repairSlots, { count: 2, from: slot1, to: slot2 });
  const { notificationText } = await import('../src/schedule/notify.js');
  assert.match(notificationText(sent[0]).text, /\(2 slots, 2026-10-12T08:00 to 2026-10-13T08:00\)$/);
  assert.equal(explains, 2);
});

test('a legacy pending point whose report history cannot be read now is kept and replayed later, not lost', async () => {
  await runDue(d1, { appendTrend: () => { throw eacces(); } });
  const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  const entry = state.schedules['example-daily'];
  entry.pendingTrend = { slot: entry.pendingTrends[0].slot, point: entry.pendingTrends[0].point };
  delete entry.pendingTrends;
  fs.writeFileSync(stateFile(), JSON.stringify(state));
  const original = Library.prototype.readMeta;
  let metaFail = 1;
  Library.prototype.readMeta = function readMeta(...args) {
    if (metaFail-- > 0) throw eacces();
    return original.apply(this, args);
  };
  let r;
  try {
    r = await runDue(d1b);
  } finally {
    Library.prototype.readMeta = original;
  }
  assert.equal(r.status, 1);
  assert.deepEqual(r.out.repairs.map(x => [x.persistence.trend, x.persistence.state]), [['unknown', 'not-attempted']]);
  assert.ok(readState(stateFile()).schedules['example-daily'].pendingTrend, 'kept');
  const next = await runDue(d1b);
  assert.equal(next.status, 0);
  assert.equal(points(refA).length, 1);
  assert.equal(explains, 1);
});

const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute);
const lastSuccess = () => readState(stateFile()).schedules['example-daily']?.lastSuccessSlot;

test('N1: a slot at or before the last success never runs again, and lastSuccessSlot only moves forward', async () => {
  writeSchedules(daily(refA).map(s => ({ ...s, cadence: { daily: true, at: '08:00' } })));
  await runDue(at(12, 8, 30));
  writeSchedules(daily(refA).map(s => ({ ...s, cadence: { daily: true, at: '09:00' } })));
  await runDue(at(12, 9, 30));
  assert.equal(lastSuccess(), '2026-10-12T09:00');
  writeSchedules(daily(refA).map(s => ({ ...s, cadence: { daily: true, at: '08:00' } })));
  const r = await runDue(at(12, 9, 45));
  assert.equal(r.out.ran, 0, 'the 08:00 slot is before the last success');
  assert.equal(lastSuccess(), '2026-10-12T09:00');
  assert.equal(explains, 2);
  const { recordResult } = await import('../src/schedule/store.js');
  recordResult(stateFile(), 'example-daily', { status: 'ok', slot: '2026-10-11T08:00', at: 'x' });
  assert.equal(lastSuccess(), '2026-10-12T09:00', 'an older result does not move it back');
});

test('N2: while an older slot cannot be recorded, the newer due slot waits; no SQL for it until the repair succeeds', async () => {
  const store = await import('../src/schedule/store.js');
  await runDue(at(12, 9), { appendTrend: () => { throw eacces(); }, recordResult: () => { throw eacces(); } });
  let fail = 1;
  const r = await runDue(at(13, 9), { reconcileSlot: (...a) => { if (fail-- > 0) throw eacces(); return store.reconcileSlot(...a); } });
  assert.deepEqual(r.out.repairs.map(x => [x.slot, x.persistence.state]), [[slot1, 'failed']]);
  assert.equal(r.out.ran, 0, 'the 13th waits');
  assert.equal(explains, 1);
  const next = await runDue(at(13, 10));
  assert.equal(next.out.ran, 1);
  assert.deepEqual(points(refA).map(p => p.slot), [slot1, slot2]);
  assert.equal(lastSuccess(), slot2);
  assert.equal(explains, 2);
});

test('N3: repair errors never copy file content into the result', async () => {
  const lib = library();
  fs.writeFileSync(lib.paths('approved', refA).meta, 'PRIVATE_RECORD customer_id=42 secret');
  const r = await runDue(at(12, 9));
  const text = JSON.stringify(r.out);
  assert.ok(!text.includes('PRIVATE_RECORD') && !text.includes('customer_id=42'), text);
  assert.deepEqual(r.out.repairs.map(x => x.persistence.error), [{ code: 'INTERNAL', message: 'a local file is not valid JSON' }]);
});

test('N3: a legacy pending point with unreadable report metadata reports a fixed text', async () => {
  fs.writeFileSync(stateFile(), JSON.stringify({ schedules: { 'example-daily': { lastSuccessSlot: slot1, pendingTrend: { slot: slot1, point: { v: 1, scheduleId: 'example-daily', slot: slot1, sqlHash: 'x' } } } } }));
  fs.writeFileSync(library().paths('approved', refA).meta, '"PRIVATE_RECORD customer_id=42" trailing');
  const r = await runDue(at(12, 9));
  assert.ok(!JSON.stringify(r.out).includes('PRIVATE_RECORD'));
  assert.deepEqual(r.out.repairs.map(x => [x.repaired, x.persistence.error.message]), [['trend', 'a local file is not valid JSON']]);
});

test('N6: a failed schema-memory step of a scheduled run is in its schedule_run audit entry (code only)', async () => {
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(home, 'memory', 'local'), 'not a folder'); // the memory step of the run fails
  const entries = [];
  const r = await main(['run-due'], env, { db: makeDb(), notifyFn: async () => 'log', now: () => d1, audit: e => entries.push(e) });
  assert.equal(r.out.results[0].status, 'ok', 'the report run itself stands');
  const run = entries.find(e => e.tool === 'schedule_run');
  assert.match(String(run.memoryErrorCode), /^[A-Z_]+$/);
  assert.equal(run.partialCommit, undefined);
});

test('R2: an earlier slot whose state repair keeps failing stops the backlog; later slots wait, then all repair in order', async () => {
  const store = await import('../src/schedule/store.js');
  const fail = () => { throw eacces(); };
  // Oct 12 and Oct 13 ran (Oct 13 by an earlier build that did not hold it
  // back), their points and state were not written: the Oct 13 run is added
  // to the saved runs as such a build left it.
  await runDue(at(12, 9), { appendTrend: fail, recordResult: fail });
  const lib = library();
  const meta = lib.readMeta('approved', refA);
  const oct13At = '2026-10-13T07:00:00.000Z';
  meta.runs.push({ ...meta.runs.at(-1), at: oct13At, schedule: { id: 'example-daily', slot: slot2 } });
  meta.last = { ...meta.last, at: oct13At };
  lib.writeMeta('approved', refA, meta);
  assert.equal(explains, 1);
  // Oct 14: the Oct 12 state repair keeps failing.
  const failOct12 = (...a) => (a[2] === slot1 ? fail() : store.reconcileSlot(...a));
  const blocked = await runDue(at(14, 9), { reconcileSlot: failOct12 });
  assert.deepEqual(blocked.out.repairs.map(x => [x.slot, x.persistence.state]), [[slot1, 'failed']], 'Oct 13 is not committed in this run');
  assert.equal(blocked.out.ran, 0, 'Oct 14 is held');
  assert.equal(lastSuccess(), undefined);
  const again = await runDue(at(14, 10), { reconcileSlot: failOct12 });
  assert.deepEqual(again.out.repairs.map(x => x.slot), [slot1], 'Oct 12 stays eligible');
  assert.equal(again.out.ran, 0);
  assert.equal(explains, 1, 'no SQL while blocked');
  // Recovery: Oct 12 (its saved result was replaced by Oct 13's: lost), then
  // Oct 13, then Oct 14 runs once.
  const recovered = await runDue(at(14, 11));
  assert.deepEqual(recovered.out.repairs.map(x => [x.slot, x.persistence.trend, x.persistence.state]), [[slot1, 'lost', 'ok'], [slot2, 'ok', 'ok']]);
  assert.deepEqual(recovered.out.results.map(x => x.slot), ['2026-10-14T08:00']);
  assert.deepEqual(points(refA).map(p => p.slot), [slot2, '2026-10-14T08:00']);
  assert.equal(lastSuccess(), '2026-10-14T08:00');
  assert.equal(explains, 2);
});
