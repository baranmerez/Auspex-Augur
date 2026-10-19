import { test, beforeEach, afterEach } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../src/reports/library.js';
import { schedulerDatabase, isUnreachable, ScheduleRunner } from '../src/schedule/runner.js';
import { validateSchedules } from '../src/schedule/config.js';
import { readState, readTrend, trendFile } from '../src/schedule/store.js';
import { main } from '../src/scheduleCli.js';
import { ToolError } from '../src/errors.js';

// scheduleCli.main end to end on a temporary AUSPEX_HOME: a real library and
// state files, the real run_report path (ReportService -> ReadOnlyDatabase
// .runReport, audited) with a fake pg client in place of the network.
const ref = { db: 'local', schema: 'example', category: 'Orders/Delivery', name: 'example-report' };
const sql = 'select status_code, count(*) as orders, sum(amount) as amount from example.orders where created_at >= $1::date and created_at < $2::date group by status_code';
let home, env, audit, sent, connect, notes;

function fakeClient() {
  const fields = [{ name: 'status_code', dataTypeID: 25 }, { name: 'orders', dataTypeID: 20 }, { name: 'amount', dataTypeID: 1700 }];
  return {
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      sent.push({ text, values: q.values });
      if (text.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Total Cost': 1, 'Plan Rows': 2, 'Actual Rows': 2, 'Actual Loops': 1, 'Actual Total Time': 0.5 }, 'Planning Time': 0.1, 'Execution Time': 0.6 }] }] };
      if (text.startsWith('FETCH')) return { rows: [['A', '3', '10.5'], ['B', '4', '2']], fields };
      if (text.includes('pg_type')) return { rows: [{ oid: 25, name: 'text' }, { oid: 20, name: 'bigint' }, { oid: 1700, name: 'numeric' }] };
      if (text.includes('server_version')) return { rows: [{ v: '16.0' }] };
      return { rows: [] };
    },
    release() {},
  };
}

function makeDb() {
  const db = schedulerDatabase({ profiles: new Map([['local', 'postgresql://u@127.0.0.1:1/a']]), statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500 },
    { audit: e => audit.push(e) });
  db.pool = () => ({ connect, end: async () => {} });
  db.roleChecks.set('local', { status: 'ok', blocking: [], warnings: [] });
  return db;
}

function writeSchedules(schedules, extra = {}) {
  fs.writeFileSync(path.join(home, 'schedules.json'), JSON.stringify({ schedules, ...extra }));
}
const schedule = (over = {}) => ({ id: 'weekly-example', profile: 'local', report: ref, preset: 'last_7_days', cadence: { weekly: 'monday', at: '08:00' }, ...over });

function approveReport({ dateRange = true, presets } = {}) {
  const lib = new Library(path.join(home, 'library'));
  const saved = lib.saveDraft({ ref, title: 'Example report <b>', sql, dateRange, presets });
  lib.appendRun('draft', ref, { at: new Date().toISOString(), sqlHash: saved.hash, version: saved.version }, null);
  lib.approve(ref);
  return lib;
}

const run = (argv, now) => main(argv, env, { db: makeDb(), notifyFn: async m => { notes.push(m); return 'log'; }, now: () => now });
const monday = new Date(2026, 9, 12, 9, 0);
const tuesday = new Date(2026, 9, 13, 10, 0);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-schedule-'));
  env = { AUSPEX_HOME: home, AUSPEX_DB_LOCAL: 'postgresql://u@127.0.0.1:1/a' };
  audit = []; sent = []; notes = [];
  connect = async () => fakeClient();
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test('run-due runs an approved report for its slot, records state, trend and audit with actor scheduler', async () => {
  approveReport();
  writeSchedules([schedule()]);
  const r = await run(['run-due'], tuesday);
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.deepEqual(r.out.results.map(x => [x.status, x.slot]), [['ok', '2026-10-12T08:00']]);
  // The preset is resolved against Monday's slot, not Tuesday's run time.
  const explain = sent.find(s => s.text.startsWith('EXPLAIN'));
  assert.deepEqual(explain.values, ['2026-10-06', '2026-10-13']);
  const state = readState(path.join(home, 'schedule-state.json'));
  assert.equal(state.schedules['weekly-example'].lastSuccessSlot, '2026-10-12T08:00');
  assert.equal(state.schedules['weekly-example'].last.status, 'ok');
  const points = readTrend(trendFile(path.join(home, 'trends'), ref));
  assert.equal(points.length, 1);
  const p = points[0];
  assert.equal(p.slot, '2026-10-12T08:00');
  assert.equal(p.preset, 'last_7_days');
  assert.deepEqual(p.params, ['2026-10-06', '2026-10-13']);
  assert.equal(p.rows, 2);
  assert.equal(p.previewComplete, true);
  assert.deepEqual(p.totals, [{ column: 'orders', total: 7 }, { column: 'amount', total: 12.5 }], 'status_code is a code column and stays out');
  assert.ok(!JSON.stringify(p).includes('"A"') && !JSON.stringify(p).includes('"B"'), 'no row values in the trend point');
  // Every audit entry of the run carries source and actor "scheduler".
  const dbEntry = audit.find(e => e.tool === 'run_report');
  assert.equal(dbEntry.source, 'scheduler');
  assert.equal(dbEntry.actor, 'scheduler');
  // The scheduler's own entry goes to the audit log of the configured home.
  const logs = path.join(home, 'logs');
  const logged = fs.readdirSync(logs).flatMap(f => fs.readFileSync(path.join(logs, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
  const runEntry = logged.find(e => e.tool === 'schedule_run');
  assert.equal(runEntry.actor, 'scheduler');
  assert.equal(runEntry.status, 'ok');
  assert.equal(runEntry.correlationId, dbEntry.correlationId);
  assert.deepEqual(notes, [{ reportTitle: 'Example report <b>', status: 'ok', errorCode: null, rows: 2, estimatedRows: null }]);
  // The run is in the approved report's history like a run_report run.
  const meta = new Library(path.join(home, 'library')).readMeta('approved', ref);
  assert.equal(meta.runs.at(-1).preset, 'last_7_days');

  // The slot is done: the next run-due on the same week does nothing.
  const again = await run(['run-due'], new Date(2026, 9, 14, 10, 0));
  assert.equal(again.status, 0);
  assert.equal(again.out.ran, 0);
});

test('an unreachable database is skipped-unreachable, exits 1 and is retried by the next run-due', async () => {
  approveReport();
  writeSchedules([schedule()]);
  connect = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }); };
  const r = await run(['run-due'], monday);
  assert.equal(r.status, 1);
  assert.equal(r.out.results[0].status, 'skipped-unreachable');
  assert.equal(r.out.results[0].errorCode, 'CONNECTION_FAILED');
  assert.equal(notes[0].status, 'skipped-unreachable');
  assert.equal(readTrend(trendFile(path.join(home, 'trends'), ref)).length, 0);
  const state = readState(path.join(home, 'schedule-state.json')).schedules['weekly-example'];
  assert.equal(state.last.status, 'skipped-unreachable');
  assert.equal(state.lastSuccessSlot, undefined);
  assert.equal(audit.find(e => e.tool === 'run_report').actor, 'scheduler', 'the failed connection is audited too');
  // 30 minutes later the database is back: the same slot runs.
  connect = async () => fakeClient();
  const retry = await run(['run-due'], new Date(2026, 9, 12, 9, 30));
  assert.equal(retry.status, 0);
  assert.deepEqual(retry.out.results.map(x => [x.status, x.slot]), [['ok', '2026-10-12T08:00']]);
});

test('unreachable means a network failure; server errors and authentication are failures', () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']) {
    assert.equal(isUnreachable(Object.assign(new Error('x'), { code })), true, code);
  }
  assert.equal(isUnreachable(new ToolError('CONNECTION_FAILED', 'Could not connect', { retryable: true })), true);
  assert.equal(isUnreachable(new ToolError('CONNECTION_FAILED', 'password authentication failed')), false);
  assert.equal(isUnreachable(Object.assign(new Error('auth'), { code: '28P01', severity: 'FATAL' })), false);
  assert.equal(isUnreachable(Object.assign(new Error('starting up'), { code: '57P03', severity: 'FATAL' })), false);
  assert.equal(isUnreachable(Object.assign(new Error('syntax'), { code: '42601', severity: 'ERROR' })), false);
  assert.equal(isUnreachable(new ToolError('TIMEOUT', 'statement timeout')), false);
});

test('other failures are failed with the error code, exit 1, and notify without the message', async () => {
  approveReport();
  writeSchedules([schedule()]);
  connect = async () => ({ ...fakeClient(), async query(q) { const text = typeof q === 'string' ? q : q.text; if (text.startsWith('EXPLAIN')) throw Object.assign(new Error('relation "example.orders" does not exist'), { code: '42P01', severity: 'ERROR' }); return { rows: [] }; } });
  const r = await run(['run-due'], monday);
  assert.equal(r.status, 1);
  assert.equal(r.out.results[0].status, 'failed');
  assert.equal(r.out.results[0].errorCode, 'DATABASE_ERROR');
  assert.deepEqual(notes, [{ reportTitle: 'Example report <b>', status: 'failed', errorCode: 'DATABASE_ERROR' }]);
  const state = readState(path.join(home, 'schedule-state.json')).schedules['weekly-example'];
  assert.deepEqual(Object.keys(state.last).sort(), ['at', 'errorCode', 'slot', 'status'], 'no message in the state the viewer reads');
});

test('only approved reports run, and only from their approved SQL', async () => {
  const lib = new Library(path.join(home, 'library'));
  lib.saveDraft({ ref, title: 'Example report', sql, dateRange: true });
  writeSchedules([schedule()]);
  const r = await run(['run-due'], monday);
  assert.equal(r.status, 1);
  assert.equal(r.out.results[0].status, 'failed');
  assert.equal(r.out.results[0].errorCode, 'PRECONDITION_FAILED');
  assert.equal(sent.length, 0, 'no database call for a draft');

  // Approved, then a new draft is saved: the schedule still runs the approved SQL.
  fs.rmSync(path.join(home, 'schedule-state.json'), { force: true });
  const hash = lib.readMeta('draft', ref).activeHash;
  lib.appendRun('draft', ref, { at: new Date().toISOString(), sqlHash: hash }, null);
  lib.approve(ref);
  lib.saveDraft({ ref, sql: 'select 1 as x where $1::date < $2::date', dateRange: true });
  const ok = await run(['run-due'], monday);
  assert.equal(ok.status, 0, JSON.stringify(ok.out));
  assert.ok(sent.find(s => s.text.startsWith('EXPLAIN')).text.includes('example.orders'));
});

test('built-in presets need a dateRange report; reports with parameters need a preset', async () => {
  approveReport({ dateRange: false, presets: [{ name: 'Example set', params: ['2026-01-01', '2026-02-01'] }] });
  writeSchedules([schedule(), schedule({ id: 'custom', preset: 'Example set' }), schedule({ id: 'none', preset: undefined })]);
  const r = await run(['run-due'], monday);
  assert.equal(r.status, 1);
  assert.deepEqual(r.out.results.map(x => [x.id, x.status]), [['weekly-example', 'failed'], ['custom', 'ok'], ['none', 'failed']]);
  assert.match(r.out.results[0].message, /not available/);
  assert.match(r.out.results[2].message, /set "preset"/);
});

test('a manual run resolves against now, adds no trend point and keeps the slot open', async () => {
  approveReport();
  writeSchedules([schedule()]);
  const r = await run(['run', '--id', 'weekly-example'], tuesday);
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.deepEqual(sent.find(s => s.text.startsWith('EXPLAIN')).values, ['2026-10-07', '2026-10-14']);
  assert.equal(readTrend(trendFile(path.join(home, 'trends'), ref)).length, 0);
  const state = readState(path.join(home, 'schedule-state.json')).schedules['weekly-example'];
  assert.equal(state.last.manual, true);
  assert.equal(state.lastSuccessSlot, undefined);
  assert.equal((await run(['run', '--id', 'missing'], tuesday)).status, 2);
  assert.equal((await run(['run'], tuesday)).status, 2);
});

test('disabled schedules and slots not yet due are not run; a broken file exits 2 and notifies', async () => {
  approveReport();
  writeSchedules([schedule({ enabled: false })]);
  assert.equal((await run(['run-due'], monday)).out.ran, 0);
  writeSchedules([schedule({ profile: undefined })]);
  const bad = await run(['run-due'], monday);
  assert.equal(bad.status, 2);
  assert.match(bad.out.message, /no default profile/);
  assert.deepEqual(notes, [{ reportTitle: 'schedules.json', status: 'failed', errorCode: 'INVALID_INPUT' }]);
  assert.equal(sent.length, 0);
  assert.equal((await run(['unknown'], monday)).status, 2);
});

test('status lists schedules, problems, the last result and the next slot without a database', async () => {
  approveReport();
  writeSchedules([schedule(), schedule({ id: 'daily-example', cadence: { daily: true, at: '07:30' }, report: { ...ref, name: 'missing-report' } })]);
  await run(['run-due'], monday);
  sent = [];
  const r = await run(['status'], monday);
  assert.equal(r.status, 0);
  assert.equal(sent.length, 0);
  const [a, b] = r.out.schedules;
  assert.equal(a.last.status, 'ok');
  assert.equal(a.next, '2026-10-19T08:00');
  assert.equal(a.problem, null);
  assert.equal(a.title, 'Example report <b>');
  assert.match(b.problem, /not found/);
  assert.equal(b.next, '2026-10-13T07:30');
});

test('task-command prints, never runs, one daily task with a retry 30 minutes later', async () => {
  writeSchedules([schedule()], { taskTime: '08:05' });
  const r = await main(['task-command'], env, { nodePath: "C:\\Program Files\\node's\\node.exe" });
  assert.equal(r.status, 0);
  assert.match(r.text, /New-ScheduledTaskTrigger -Daily -At '08:05'/);
  assert.match(r.text, /New-ScheduledTaskTrigger -Daily -At '08:35'/);
  assert.match(r.text, /-RestartCount 1 -RestartInterval \(New-TimeSpan -Minutes 30\)/);
  assert.match(r.text, /scheduleCli\.js" run-due --home "[^"]+"'/);
  assert.match(r.text, /-Execute 'C:\\Program Files\\node''s\\node\.exe'/, 'single quotes are doubled');
  assert.match(r.text, /Register-ScheduledTask -TaskName 'Auspex scheduled reports'/);
  assert.ok(!fs.existsSync(path.join(home, 'schedule-state.json')));
  writeSchedules([schedule({ cadence: { daily: true, at: '23:45' } })]);
  assert.match((await main(['task-command'], env, {})).text, /-At '00:15'/, 'the retry wraps past midnight');
});

// The run lock (src/fileLock.js rules, held for the whole run).
const lockFile = () => path.join(home, 'scheduler.lock');
const writeLock = (body, ageMs = 0) => {
  fs.writeFileSync(lockFile(), body);
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(lockFile(), t, t); }
};
const liveLock = () => JSON.stringify({ pid: process.pid, host: os.hostname(), token: '0123456789abcdef', at: new Date().toISOString() });
// lockWaitMs 0: no wait window, so the outcome never depends on how fast the disk is.
const runLocked = (argv, now) => main(argv, env, { db: makeDb(), notifyFn: async m => { notes.push(m); return 'log'; }, now: () => now, lockWaitMs: 0 });

test('exit 3 while another run holds the lock; nothing runs and the lock stays', async () => {
  approveReport();
  writeSchedules([schedule()]);
  writeLock(liveLock());
  const r = await runLocked(['run-due'], monday);
  assert.equal(r.status, 3);
  assert.equal(r.out.code, 'BUSY');
  assert.equal(sent.length, 0);
  assert.deepEqual(notes, [], 'a normal overlap does not notify');
  assert.ok(fs.existsSync(lockFile()));
  assert.equal((await runLocked(['run', '--id', 'weekly-example'], monday)).status, 3);
});

test('a lock held past the task limit is reported with a notification, and taken over past the hold limit', async () => {
  approveReport();
  writeSchedules([schedule()]);
  writeLock(liveLock(), 2.5 * 3600 * 1000);
  const r = await runLocked(['run-due'], monday);
  assert.equal(r.status, 3);
  assert.match(r.out.message, /longer than the task limit/);
  assert.deepEqual(notes, [{ reportTitle: 'scheduler lock', status: 'failed', errorCode: 'LOCK_BUSY' }]);
  // Past 3 h a live-looking pid (reused after a reboot) no longer keeps it.
  writeLock(liveLock(), 3.5 * 3600 * 1000);
  const taken = await runLocked(['run-due'], monday);
  assert.equal(taken.status, 0, JSON.stringify(taken.out));
  assert.ok(!fs.existsSync(lockFile()), 'released after the run');
});

test('a lock left by a dead process is taken over', async () => {
  approveReport();
  writeSchedules([schedule()]);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeLock(JSON.stringify({ pid: dead, host: os.hostname(), token: 'fedcba9876543210', at: new Date().toISOString() }));
  const r = await runLocked(['run-due'], monday);
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.ok(!fs.existsSync(lockFile()));
});

test('an empty lock file (a taker between create and write) is not removed while fresh', async () => {
  approveReport();
  writeSchedules([schedule()]);
  writeLock('');
  assert.equal((await runLocked(['run-due'], monday)).status, 3);
  assert.ok(fs.existsSync(lockFile()), 'the fresh empty lock is kept');
  writeLock('', 60 * 1000);
  assert.equal((await runLocked(['run-due'], monday)).status, 0, 'an empty lock older than 30 s is stale');
});

test('the trend point uses the result this run stored, not meta.last re-read after a concurrent run', async () => {
  const lib = approveReport();
  writeSchedules([schedule()]);
  const config = { profiles: new Map([['local', 'x']]), profileInfo: new Map(), scriptRoots: new Map(), libraryDir: path.join(home, 'library'), memoryDir: path.join(home, 'memory'), logDir: path.join(home, 'logs') };
  const runner = new ScheduleRunner(config, { stateFile: path.join(home, 'schedule-state.json'), trendsDir: path.join(home, 'trends'), db: makeDb(), notifyFn: async () => 'log', audit: () => {}, now: () => monday });
  // Another process's run_report lands right after this run stored its result.
  const original = runner.reports.library.appendRun.bind(runner.reports.library);
  runner.reports.library.appendRun = (stage, r, run, last) => {
    const meta = original(stage, r, run, last);
    const other = { ...meta, last: { ...meta.last, summary: { ...meta.last.summary, rows: 999 }, preview: [['Z', '900', '900']] } };
    lib.writeMeta(stage, r, other);
    return meta;
  };
  const slot = { key: '2026-10-12T08:00', at: new Date(2026, 9, 12, 8, 0) };
  const res = await runner.run(validateSchedules({ schedules: [schedule()] }).schedules[0], slot);
  assert.equal(res.status, 'ok', JSON.stringify(res));
  const [p] = readTrend(trendFile(path.join(home, 'trends'), ref));
  assert.equal(p.rows, 2);
  assert.deepEqual(p.totals, [{ column: 'orders', total: 7 }, { column: 'amount', total: 12.5 }]);
  assert.equal(lib.readMeta('approved', ref).last.summary.rows, 999, 'the concurrent result is on disk');
});

test('run_report results do not carry the stored last result', async () => {
  approveReport();
  const config = { profiles: new Map([['local', 'x']]), profileInfo: new Map(), scriptRoots: new Map(), libraryDir: path.join(home, 'library'), memoryDir: path.join(home, 'memory'), logDir: path.join(home, 'logs') };
  const runner = new ScheduleRunner(config, { stateFile: path.join(home, 's.json'), trendsDir: path.join(home, 'trends'), db: makeDb(), audit: () => {} });
  const out = await runner.reports.run(ref, { preset: 'last_7_days' });
  assert.equal(out.last, undefined);
});

test('status warns about schedules due after the task time', async () => {
  approveReport();
  writeSchedules([schedule(), schedule({ id: 'late', cadence: { daily: true, at: '09:00' } })], { taskTime: '08:05' });
  const r = await run(['status'], monday);
  assert.equal(r.out.taskTime, '08:05');
  assert.equal(r.out.warnings.length, 1);
  assert.match(r.out.warnings[0], /"late" is due at 09:00, later than the task time 08:05/);
  writeSchedules([schedule(), schedule({ id: 'late', cadence: { daily: true, at: '09:00' } })]);
  assert.deepEqual((await run(['status'], monday)).out.warnings, [], 'the default task time is the latest schedule time');
});

test('task-command passes AUSPEX_HOME as --home and names, never prints, settings the task does not inherit', async () => {
  writeSchedules([schedule()]);
  const r = await main(['task-command'], { ...env, AUSPEX_LIBRARY_DIR: path.join(home, 'library') }, { nodePath: 'C:\node\node.exe' });
  assert.equal(r.status, 0);
  assert.ok(r.text.includes(`run-due --home "${path.resolve(home)}"'`), r.text);
  assert.match(r.text, /# Profile\(s\) local come from AUSPEX_DB_\* variables/);
  assert.match(r.text, /does not inherit AUSPEX_LIBRARY_DIR/);
  assert.ok(!r.text.includes('postgresql://'), 'no connection string');
  assert.match(r.text, /Run task-command again and re-register the task after changing schedule times/);
  const plain = await main(['task-command'], {}, { nodePath: 'C:\node\node.exe' });
  assert.ok(!plain.text.includes('--home'), 'no --home without AUSPEX_HOME');
});

test('--home selects the AUSPEX_HOME of a run and is validated', async () => {
  approveReport();
  writeSchedules([schedule()]);
  const { AUSPEX_HOME, ...noHome } = env;
  const r = await main(['status', '--home', home], noHome, { now: () => monday });
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.equal(r.out.schedules[0].id, 'weekly-example');
  assert.equal((await main(['status', '--home', 'relative/dir'], noHome)).status, 2);
  assert.equal((await main(['status', '--home', path.join(home, 'missing')], noHome)).status, 2);
  assert.equal((await main(['status', '--home', home, '--home', home], noHome)).status, 2);
});

test('an empty result is notified with its row count, also when only failures are notified', async () => {
  approveReport();
  writeSchedules([schedule()], { notify: 'failures' });
  connect = async () => {
    const c = fakeClient();
    const query = c.query;
    c.query = async q => {
      const res = await query(q);
      const text = typeof q === 'string' ? q : q.text;
      if (text.startsWith('EXPLAIN')) res.rows[0]['QUERY PLAN'][0].Plan['Actual Rows'] = 0;
      if (text.startsWith('FETCH')) res.rows = [];
      return res;
    };
    return c;
  };
  const r = await run(['run-due'], tuesday);
  assert.equal(r.out.results[0].status, 'ok');
  assert.deepEqual(notes, [{ reportTitle: 'Example report <b>', status: 'ok', errorCode: null, rows: 0, estimatedRows: null }]);
});

test('a run with rows is not notified when only failures are notified', async () => {
  approveReport();
  writeSchedules([schedule()], { notify: 'failures' });
  await run(['run-due'], tuesday);
  assert.deepEqual(notes, []);
});
