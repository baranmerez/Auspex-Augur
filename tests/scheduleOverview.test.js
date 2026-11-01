import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from '../src/reports/library.js';
import { recordResult } from '../src/schedule/store.js';
import { scheduleOverview } from '../src/schedule/viewerData.js';

// The Schedules screen data (#154): every schedule of schedules.json with its
// target check, built by src/schedule/viewerData.js for GET /api/schedules
// (browser) and `stageCli.js schedule-overview` (desktop). Files only.
const cli = fileURLToPath(new URL('../src/stageCli.js', import.meta.url));
const viewer = fileURLToPath(new URL('../src/viewer.js', import.meta.url));
const sqlText = 'select order_id from example.orders where created_at >= $1 and created_at < $2';
const ref = name => ({ db: 'exampledb', schema: 'example', category: 'Orders/Delivery', name });
const testRef = { db: 'testdb', schema: 'test', category: 'Invoices', name: 'open-invoices' };

function approve(lib, r, input) {
  const saved = lib.saveDraft({ ref: r, title: `Title of ${r.name}`, ...input });
  lib.appendRun('draft', r, { at: '2026-10-01T08:00:00.000Z', sqlHash: saved.hash, params: ['2026-09-01', 'secret-param-value'] }, null);
  lib.approve(r);
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-sched-overview-'));
  const lib = new Library(path.join(home, 'library'));
  approve(lib, ref('late-orders'), { sql: sqlText, dateRange: true });
  approve(lib, ref('revoked'), { sql: 'select 1 as orders' });
  lib.revoke(ref('revoked'));
  lib.saveDraft({ ref: ref('draft-only'), title: 'Draft only', sql: 'select 1 as orders' });
  approve(lib, testRef, { sql: 'select 1 as invoices where $1::date < now()', presets: [{ name: 'Q1', params: ['2026-01-01'] }] });
  const s = (id, report, extra = {}) => ({ id, profile: report.db, report, cadence: { daily: true, at: '08:00' }, ...extra });
  fs.writeFileSync(path.join(home, 'schedules.json'), JSON.stringify({ schedules: [
    s('late-weekly', ref('late-orders'), { preset: 'last_7_days', cadence: { weekly: 'monday', at: '08:00' } }),
    s('revoked-daily', ref('revoked')),
    s('draft-daily', ref('draft-only')),
    s('removed-daily', ref('removed')),
    s('bad-preset', ref('late-orders'), { preset: 'no_such_preset' }),
    s('no-preset', ref('late-orders')),
    s('invoices-q1', testRef, { preset: 'Q1' }),
    s('paused', ref('late-orders'), { preset: 'last_7_days', enabled: false }),
  ] }));
  recordResult(path.join(home, 'schedule-state.json'), 'late-weekly', { status: 'failed', slot: '2026-10-26T08:00', at: '2026-10-26T06:00:00.000Z', errorCode: 'QUERY_FAILED' });
  return home;
}
const strip = list => list.map(({ next, ...rest }) => rest);

test('every configured schedule is listed with its target, also when its report was revoked, removed or is only a draft', () => {
  const home = makeHome();
  const env = { AUSPEX_HOME: home };
  const before = fs.readdirSync(home).sort();
  const o = scheduleOverview({ env, library: new Library(path.join(home, 'library')) });
  assert.equal(o.file, 'ok');
  assert.equal(o.error, null);
  assert.equal(o.stateUnreadable, false);
  const by = Object.fromEntries(o.schedules.map(s => [s.id, s]));
  assert.deepEqual(o.schedules.map(s => s.id), ['late-weekly', 'revoked-daily', 'draft-daily', 'removed-daily', 'bad-preset', 'no-preset', 'invoices-q1', 'paused']);
  assert.equal(by['late-weekly'].target, 'ok');
  assert.equal(by['late-weekly'].title, 'Title of late-orders');
  assert.deepEqual(by['late-weekly'].report, ref('late-orders'));
  assert.equal(by['late-weekly'].profile, 'exampledb');
  assert.deepEqual(by['late-weekly'].last, { status: 'failed', slot: '2026-10-26T08:00', at: '2026-10-26T06:00:00.000Z', errorCode: 'QUERY_FAILED' });
  assert.equal(by['revoked-daily'].target, 'draft', 'a revoked report is a draft again');
  assert.equal(by['draft-daily'].target, 'draft');
  assert.equal(by['draft-daily'].problemCode, 'PRECONDITION_FAILED');
  assert.equal(by['removed-daily'].target, 'missing');
  assert.equal(by['removed-daily'].problemCode, 'NOT_FOUND');
  assert.equal(by['bad-preset'].target, 'preset');
  assert.match(by['bad-preset'].problem, /Unknown preset "no_such_preset"/);
  assert.equal(by['no-preset'].target, 'preset');
  assert.match(by['no-preset'].problem, /takes 2 parameter\(s\)/);
  assert.equal(by['invoices-q1'].target, 'ok', 'a second profile with a custom preset');
  assert.equal(by['invoices-q1'].profile, 'testdb');
  assert.equal(by.paused.enabled, false);
  assert.equal(by.paused.next, null, 'a disabled schedule has no next slot');
  const text = JSON.stringify(o);
  assert.ok(!text.includes('select ') && !text.includes('secret-param-value') && !text.includes('2026-09-01'), 'no SQL and no parameter values');
  assert.deepEqual(fs.readdirSync(home).sort(), before, 'nothing is written');
});

test('missing, invalid and empty configuration and an unreadable state are told apart', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-sched-overview-'));
  const env = { AUSPEX_HOME: home };
  const library = new Library(path.join(home, 'library'));
  assert.deepEqual({ ...scheduleOverview({ env, library }) }, { file: 'missing', error: null, stateUnreadable: false, schedules: [] });
  fs.writeFileSync(path.join(home, 'schedules.json'), '{"schedules": [{"id": "x"}]}');
  const invalid = scheduleOverview({ env, library });
  assert.equal(invalid.file, 'invalid');
  assert.match(invalid.error, /profile|report|schedule/);
  fs.writeFileSync(path.join(home, 'schedules.json'), '{"schedules": []}');
  assert.equal(scheduleOverview({ env, library }).file, 'ok');
  assert.deepEqual(scheduleOverview({ env, library }).schedules, []);
  fs.writeFileSync(path.join(home, 'schedules.json'), JSON.stringify({ schedules: [{ id: 'daily', profile: 'exampledb', report: ref('removed'), cadence: { daily: true, at: '08:00' } }] }));
  fs.writeFileSync(path.join(home, 'schedule-state.json'), '{broken');
  const unreadable = scheduleOverview({ env, library });
  assert.equal(unreadable.stateUnreadable, true);
  assert.equal(unreadable.schedules[0].stateUnreadable, true);
  assert.equal(unreadable.schedules[0].last, null);
  assert.equal(fs.readFileSync(path.join(home, 'schedule-state.json'), 'utf8'), '{broken', 'the broken state is left as it is');
});

test('the desktop command gives the same data as the viewer function', () => {
  const home = makeHome();
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json') };
  const res = spawnSync(process.execPath, [cli, 'schedule-overview'], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const { ok, ...out } = JSON.parse(lines[0]);
  assert.equal(ok, true);
  const expected = scheduleOverview({ env: { AUSPEX_HOME: home }, library: new Library(path.join(home, 'library')) });
  assert.deepEqual(strip(out.schedules), strip(expected.schedules));
  assert.deepEqual({ ...out, schedules: null }, { ...expected, schedules: null });
  const extra = spawnSync(process.execPath, [cli, 'schedule-overview', '--x'], { env, encoding: 'utf8' });
  assert.equal(extra.status, 1);
  assert.equal(JSON.parse(extra.stdout).code, 'INVALID_INPUT');
});

// The browser route on a temporary home.
let child, port, home, token;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const request = (method, rawPath, { withToken = true } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers: { host: `127.0.0.1:${port}`, ...(token && withToken && method === 'GET' ? { 'x-auspex-token': token } : {}) } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

before(async () => {
  port = await freePort();
  home = makeHome();
  child = spawn(process.execPath, [viewer], { env: { ...process.env, AUSPEX_HOME: home, AUSPEX_VIEWER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let err = '';
    child.stdout.on('data', d => { if (String(d).includes('Auspex viewer:')) resolve(); });
    child.stderr.on('data', d => { err += d; });
    child.once('exit', code => reject(new Error(`viewer exited with ${code}: ${err}`)));
  });
  token = (await request('GET', '/')).body.match(/<meta name="auspex-token" content="([0-9a-f]{64})">/)?.[1];
});

after(() => {
  child?.kill();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('GET /api/schedules returns the overview; it needs the token and has no write route', async () => {
  const res = await request('GET', '/api/schedules');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  const expected = scheduleOverview({ env: { AUSPEX_HOME: home }, library: new Library(path.join(home, 'library')) });
  assert.deepEqual(strip(body.schedules), strip(expected.schedules));
  assert.equal(body.file, 'ok');
  assert.equal((await request('GET', '/api/schedules', { withToken: false })).status, 401);
  assert.equal((await request('POST', '/api/schedules')).status, 405);
});
