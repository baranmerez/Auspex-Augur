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
  vm.runInContext(`${block}\nthis.api = { scheduleBadge, scheduleLines, trendSeries, trendChart };`, context);
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
