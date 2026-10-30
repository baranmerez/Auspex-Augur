import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Library } from '../src/reports/library.js';
import { appendTrend, recordResult } from '../src/schedule/store.js';

// 1) The schedule-view block of src/viewer.html in isolation, with a tiny DOM
//    double that keeps text children as plain strings: badges and the trend
//    chart put names in as text, never as markup.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ schedule-view:start[\s\S]*?\/\/ schedule-view:end/)?.[0];

function load() {
  assert.ok(block, 'schedule-view block found in viewer.html');
  const node = (tag, attrs = {}, kids = []) => ({ tag, attrs, kids: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false), textContent: undefined, append(...k) { this.kids.push(...k); } });
  const context = vm.createContext({
    h: (tag, attrs, ...kids) => node(tag, attrs, kids.map(k => (typeof k === 'object' ? k : String(k)))),
    svg: (tag, attrs) => node(tag, attrs),
    t: (en, vars = {}) => en.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''),
    fmt: n => (n === null || n === undefined ? '–' : String(n)),
  });
  vm.runInContext(`${block}\nthis.api = { scheduleBadge, scheduleLines, trendSeries, trendChart, scheduleKind, scheduleTrendInfo };`, context);
  return context.api;
}
const api = load();

test('the list badge shows the worst last result of a report\'s schedules', () => {
  assert.equal(api.scheduleBadge(undefined), null);
  assert.equal(api.scheduleBadge([]), null);
  assert.equal(api.scheduleBadge([{ id: 'a', last: null }]).cls, 'sched-none');
  assert.equal(api.scheduleBadge([{ last: { status: 'ok' } }]).label, 'scheduled: ok');
  assert.equal(api.scheduleBadge([{ last: { status: 'ok' } }, { last: { status: 'skipped-unreachable' } }]).cls, 'sched-skipped');
  assert.equal(api.scheduleBadge([{ last: { status: 'skipped-unreachable' } }, { last: { status: 'failed' } }]).cls, 'sched-failed');
  assert.equal(api.scheduleBadge([{ last: { status: '<img src=x onerror=alert(1)>' } }]).cls, 'sched-none', 'an unknown status is not used as a class');
  const [line] = api.scheduleLines([{ id: 'weekly-example', cadence: 'weekly monday 08:00', preset: 'last_7_days', next: '2026-10-19T08:00', last: { status: 'failed', errorCode: 'DATABASE_ERROR', slot: '2026-10-12T08:00' } }]);
  assert.equal(line.last, 'scheduled: failed (DATABASE_ERROR) · 2026-10-12T08:00');
});

test('saving problems of the latest slot are told apart from plain ok and failed, worst first, in the amber or red badge colours', () => {
  const ok = { last: { status: 'ok', slot: '2026-10-12T08:00' } };
  const saveFailed = { last: { status: 'ok', slot: '2026-10-12T08:00', persistenceError: 'TREND_WRITE_FAILED' }, pendingTrends: 1, pendingSlots: ['2026-10-12T08:00'] };
  const pending = { last: { status: 'ok', slot: '2026-10-12T08:00' }, pendingTrends: 2, pendingSlots: ['2026-10-05T08:00', '2026-10-12T08:00'] };
  const lostNow = { last: { status: 'ok', slot: '2026-10-19T08:00', trendLost: true } };
  const unreadable = { last: null, stateUnreadable: true };
  assert.equal(api.scheduleKind(ok), 'ok');
  assert.equal(api.scheduleKind(saveFailed), 'save-failed');
  assert.equal(api.scheduleKind(pending), 'repair-pending');
  assert.equal(api.scheduleKind(lostNow), 'trend-lost');
  assert.equal(api.scheduleKind(unreadable), 'unreadable');
  assert.equal(api.scheduleKind({ ...saveFailed, last: { ...saveFailed.last, persistenceError: '<b>x</b>' } }), 'repair-pending', 'only an upper-case code counts');
  const badge = list => { const b = api.scheduleBadge(list); return [b.cls, b.label]; };
  assert.deepEqual(badge([saveFailed]), ['sched-skipped', 'scheduled: ran, saving failed']);
  assert.deepEqual(badge([pending]), ['sched-skipped', 'scheduled: ran, repair pending']);
  assert.deepEqual(badge([lostNow]), ['sched-skipped', 'scheduled: ran, trend point lost']);
  assert.deepEqual(badge([unreadable]), ['sched-skipped', 'scheduled: state unreadable']);
  assert.deepEqual(badge([ok, pending, saveFailed]), ['sched-skipped', 'scheduled: ran, saving failed'], 'worst of the report\'s schedules');
  assert.deepEqual(badge([saveFailed, { last: { status: 'failed' } }]), ['sched-failed', 'scheduled: failed']);
  assert.deepEqual(badge([unreadable, { last: { status: 'skipped-unreachable' } }]), ['sched-skipped', 'scheduled: state unreadable']);
  const old = { last: { status: 'ok', slot: '2026-10-19T08:00' }, trendLostSlots: ['2026-09-07T08:00', '2026-09-14T08:00', '2026-09-21T08:00', '2026-09-28T08:00'] };
  const [l1, l2, l3, l4] = api.scheduleLines([saveFailed, pending, old, unreadable]);
  assert.equal(l1.last, 'scheduled: ran, saving failed (TREND_WRITE_FAILED) · 2026-10-12T08:00');
  assert.deepEqual(JSON.parse(JSON.stringify(l2.notes)), ['2 trend points wait to be saved by the next scheduled run']);
  assert.deepEqual(JSON.parse(JSON.stringify(l3.notes)), ['4 trend points lost (2026-09-07T08:00, 2026-09-14T08:00, 2026-09-21T08:00 +1)']);
  assert.equal(l4.last, 'scheduler state unreadable: last result unknown', 'not "no scheduled run yet"');
  assert.equal(api.scheduleLines([{ last: null }])[0].last, 'no scheduled run yet');
});

test('the badge follows the latest slot: historic lost points and a repaired saving error no longer keep it amber', () => {
  // Points lost weeks ago (trendLostSlots is never cleared), then later runs went fine.
  const historic = { last: { status: 'ok', slot: '2026-10-26T08:00' }, trendLostSlots: ['2026-09-28T08:00'] };
  assert.equal(api.scheduleKind(historic), 'ok');
  assert.deepEqual(api.scheduleBadge([historic]).cls, 'sched-ok');
  const [line] = api.scheduleLines([historic]);
  assert.equal(line.last, 'scheduled: ok · 2026-10-26T08:00');
  assert.deepEqual(JSON.parse(JSON.stringify(line.notes)), ['1 trend point lost (2026-09-28T08:00)'], 'the older loss stays in the line');
  assert.match(JSON.stringify(api.trendChart([{ slot: '2026-10-26T08:00', rows: 3 }], api.scheduleTrendInfo([historic]))), /1 trend point was lost before it could be saved \(2026-09-28T08:00\)/, 'and in the chart note');
  // The saving error of the latest slot after run-due saved its point: no pending entry for that slot.
  const repaired = { last: { status: 'ok', slot: '2026-10-26T08:00', persistenceError: 'TREND_WRITE_FAILED' } };
  assert.equal(api.scheduleKind(repaired), 'ok');
  assert.equal(api.scheduleLines([repaired])[0].last, 'scheduled: ok · 2026-10-26T08:00', 'no stale code in the line');
  // An older slot still waiting while the latest one is fine: ok badge, the wait in the notes.
  const olderWait = { last: { status: 'ok', slot: '2026-10-26T08:00' }, pendingTrends: 1, pendingSlots: ['2026-10-19T08:00'] };
  assert.equal(api.scheduleKind(olderWait), 'ok');
  assert.deepEqual(JSON.parse(JSON.stringify(api.scheduleLines([olderWait])[0].notes)), ['1 trend point waits to be saved by the next scheduled run']);
});

test('the trend note says points were lost or wait to be saved instead of "none yet"', () => {
  const info = api.scheduleTrendInfo([{ last: { status: 'ok', slot: 'b', trendLost: true }, trendLostSlots: ['a'] }, { pendingTrends: 1 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(info)), { lost: ['a', 'b'], pending: 1 });
  const empty = JSON.stringify(api.trendChart([], info));
  assert.doesNotMatch(empty, /No trend points yet/);
  assert.match(empty, /2 trend points were lost before they could be saved \(a, b\)/);
  assert.match(empty, /1 trend point waits to be saved; the next scheduled run saves it/);
  assert.match(JSON.stringify(api.trendChart([{ slot: 'c', rows: 1 }], { lost: ['a'], pending: 0 })), /1 trend point was lost before it could be saved \(a\)/, 'also below a chart');
  assert.match(JSON.stringify(api.trendChart([], { lost: [], pending: 0 })), /No trend points yet/);
});

const points = [
  { slot: '2026-10-05T08:00', rows: 2, totals: [{ column: 'amount', total: 10 }] },
  { slot: '2026-10-12T08:00', rows: null, estimatedRows: 50, totals: null },
  { slot: '2026-10-19T08:00', rows: 4, totals: [{ column: 'amount', total: 12 }, { column: '<img src=x onerror=alert(1)>', total: 1 }] },
];

test('trend series: rows first, then column totals; gaps stay null', () => {
  const s = api.trendSeries(points);
  assert.deepEqual(JSON.parse(JSON.stringify(s.labels)), ['2026-10-05T08:00', '2026-10-12T08:00', '2026-10-19T08:00']);
  assert.deepEqual(JSON.parse(JSON.stringify(s.series.map(x => [x.name, x.values]))), [
    ['Rows', [2, null, 4]], ['amount', [10, null, 12]], ['<img src=x onerror=alert(1)>', [null, null, 1]],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.trendSeries([{ slot: 'x', totals: [{ column: 'a', total: 'NaN' }] }]).series)), []);
  assert.equal(api.trendSeries('junk').series.length, 0);
});

test('the trend chart puts column names in as text, never as markup', () => {
  const chart = api.trendChart(points);
  const texts = [];
  const walk = n => {
    if (typeof n === 'string') { texts.push(n); return; }
    assert.ok(!('innerHTML' in n.attrs) && !('outerHTML' in n.attrs));
    if (n.textContent !== undefined) texts.push(n.textContent);
    n.kids.forEach(walk);
  };
  walk(chart);
  assert.ok(texts.includes('<img src=x onerror=alert(1)>'), 'the hostile name is a text child');
  assert.ok(texts.includes('2026-10-19T08:00: 12'), 'point titles are text');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(block));
  assert.match(JSON.stringify(api.trendChart([])), /No trend points yet/);
});

// 2) The viewer routes on a temporary AUSPEX_HOME: schedules on approved
//    reports in /api/reports and the trend route (aggregates, no parameters).
const viewer = new URL('../src/viewer.js', import.meta.url);
const ref = { db: 'exampledb', schema: 'example', category: 'Orders/Delivery', name: 'example-report' };
let child, port, home, token;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const request = (method, rawPath, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers: { host: `127.0.0.1:${port}`, ...(token && method === 'GET' ? { 'x-auspex-token': token } : {}), ...headers } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

before(async () => {
  port = await freePort();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-viewer-schedule-'));
  const lib = new Library(path.join(home, 'library'));
  const saved = lib.saveDraft({ ref, title: 'Example report', sql: 'select 1 as orders where $1::date < $2::date', dateRange: true });
  lib.appendRun('draft', ref, { at: new Date().toISOString(), sqlHash: saved.hash }, null);
  lib.approve(ref);
  fs.writeFileSync(path.join(home, 'schedules.json'), JSON.stringify({ schedules: [{ id: 'weekly-example', profile: 'exampledb', report: ref, preset: 'last_7_days', cadence: { weekly: 'monday', at: '08:00' } }] }));
  recordResult(path.join(home, 'schedule-state.json'), 'weekly-example', { status: 'skipped-unreachable', slot: '2026-10-12T08:00', at: '2026-10-12T06:00:00.000Z', errorCode: 'CONNECTION_FAILED' });
  appendTrend(path.join(home, 'trends'), ref, { v: 1, slot: '2026-10-05T08:00', ranAt: 'x', preset: 'last_7_days', params: ['2026-09-29', '2026-10-06'], rows: 3, totals: [{ column: 'orders', total: 3 }] });
  child = spawn(process.execPath, [fileURLToPath(viewer)], { env: { ...process.env, AUSPEX_HOME: home, AUSPEX_VIEWER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let err = '';
    child.stdout.on('data', d => { if (String(d).includes('Auspex viewer:')) resolve(); });
    child.stderr.on('data', d => { err += d; });
    child.once('exit', code => reject(new Error(`viewer exited with ${code}: ${err}`)));
  });
  // The /api routes need the per-process token the page carries.
  token = (await request('GET', '/')).body.match(/<meta name="auspex-token" content="([0-9a-f]{64})">/)?.[1];
});

after(() => {
  child?.kill();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('/api/reports carries the schedule and last result of approved reports', async () => {
  const res = await request('GET', '/api/reports');
  assert.equal(res.status, 200);
  const r = JSON.parse(res.body).reports.find(x => x.name === 'example-report');
  assert.equal(r.stage, 'approved');
  assert.equal(r.schedules.length, 1);
  assert.equal(r.schedules[0].cadence, 'weekly monday 08:00');
  assert.deepEqual(r.schedules[0].last, { status: 'skipped-unreachable', slot: '2026-10-12T08:00', at: '2026-10-12T06:00:00.000Z', errorCode: 'CONNECTION_FAILED' });
  assert.match(r.schedules[0].next, /^\d{4}-\d{2}-\d{2}T08:00$/);
  for (const k of ['pendingTrends', 'pendingSlots', 'trendLostSlots', 'stateUnreadable']) assert.equal(Object.hasOwn(r.schedules[0], k), false, `${k} only when there is something to say`);
});

test('the trend route returns aggregates without parameters and validates the report path', async () => {
  const q = new URLSearchParams(ref);
  const res = await request('GET', `/api/reports/trend?${q}`);
  assert.equal(res.status, 200);
  const { points: got } = JSON.parse(res.body);
  assert.deepEqual(got, [{ slot: '2026-10-05T08:00', ranAt: 'x', preset: 'last_7_days', rows: 3, totals: [{ column: 'orders', total: 3 }] }]);
  assert.deepEqual(JSON.parse((await request('GET', `/api/reports/trend?${new URLSearchParams({ ...ref, name: 'other' })}`)).body), { points: [] });
  assert.equal((await request('GET', `/api/reports/trend?${new URLSearchParams({ ...ref, schema: '..' })}`)).status, 400);
  assert.equal((await request('POST', `/api/reports/trend?${q}`)).status, 405, 'no write route');
  assert.equal((await request('GET', `/api/reports/trend?${q}`, { host: 'evil.example.test' })).status, 403, 'same Host check');
});

test('a broken schedules.json is reported, the report list still loads', async () => {
  fs.writeFileSync(path.join(home, 'schedules.json'), '{"schedules": [{"id": "x"}]}');
  const body = JSON.parse((await request('GET', '/api/reports')).body);
  assert.match(body.schedulesError, /profile|report|schedule/);
  assert.equal(body.reports.find(x => x.name === 'example-report').schedules, undefined);
});

test('day counts follow a log file that grows (cached by size and modification time)', async () => {
  const dir = path.join(home, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026-10-19.jsonl');
  const entry = JSON.stringify({ ts: '2026-10-19T08:00:00.000Z', tool: 'query', profile: 'exampledb' }) + '\n';
  fs.writeFileSync(file, entry + entry);
  const count = async () => JSON.parse((await request('GET', '/api/days')).body).find(d => d.day === '2026-10-19')?.count;
  assert.equal(await count(), 2);
  assert.equal(await count(), 2, 'unchanged file, same count');
  fs.appendFileSync(file, entry);
  assert.equal(await count(), 3, 'a grown file is counted again');
});

test('scheduleIndex passes saving problems on as codes, counts and slot keys, and flags an unreadable state without writing', async () => {
  const { scheduleIndex, scheduleKey } = await import('../src/schedule/viewerData.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-sched-index-'));
  try {
    const env = { AUSPEX_HOME: dir };
    fs.writeFileSync(path.join(dir, 'schedules.json'), JSON.stringify({ schedules: [
      { id: 'a', profile: 'exampledb', report: ref, preset: 'last_7_days', cadence: { weekly: 'monday', at: '08:00' } },
      { id: 'b', profile: 'exampledb', report: ref, preset: 'last_7_days', cadence: { weekly: 'monday', at: '09:00' } }] }));
    const stateFile = path.join(dir, 'schedule-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ schedules: {
      a: { last: { status: 'ok', slot: '2026-10-12T08:00', at: 'x', persistenceError: 'STATE_WRITE_FAILED', message: 'C:\\secret\\file is locked' },
        pendingTrends: [{ slot: '2026-10-05T08:00', point: { rows: 1 } }, { slot: '2026-10-12T08:00', point: { rows: 2 } }], trendLostSlots: ['2026-09-28T08:00', '<script>'] },
      b: { last: { status: 'ok', slot: '2026-10-12T09:00', at: 'y', trendLost: true, persistenceError: 'not a code' } } } }));
    const [a, b] = scheduleIndex({ env }).byReport.get(scheduleKey(ref));
    assert.deepEqual(a.last, { status: 'ok', slot: '2026-10-12T08:00', at: 'x', persistenceError: 'STATE_WRITE_FAILED' });
    assert.equal(a.pendingTrends, 2);
    assert.deepEqual(a.pendingSlots, ['2026-10-05T08:00', '2026-10-12T08:00']);
    assert.deepEqual(a.trendLostSlots, ['2026-09-28T08:00'], 'only slot keys');
    assert.equal(a.stateUnreadable, undefined);
    assert.deepEqual(b.last, { status: 'ok', slot: '2026-10-12T09:00', at: 'y', trendLost: true });
    assert.ok(!JSON.stringify([a, b]).includes('secret'), 'no messages or file paths');
    // A state file that cannot be read strictly: no last result, flagged, left as it is.
    const broken = '{"schedules": {"a": "not an object"}}';
    fs.writeFileSync(stateFile, broken);
    const before = fs.statSync(stateFile).mtimeMs;
    const [ua] = scheduleIndex({ env }).byReport.get(scheduleKey(ref));
    assert.equal(ua.stateUnreadable, true);
    assert.equal(ua.last, null);
    fs.writeFileSync(stateFile, '{ not json');
    assert.equal(scheduleIndex({ env }).byReport.get(scheduleKey(ref))[0].stateUnreadable, true);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '{ not json', 'never written');
    assert.ok(fs.statSync(stateFile).mtimeMs >= before);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['schedule-state.json', 'schedules.json'], 'no lock or temp files left');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
