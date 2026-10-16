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
import { Library, sqlHash } from '../src/reports/library.js';

// Starts src/viewer.js on a free loopback port with a temporary library and
// checks the approve/revoke routes: origin, token, host, body and stage checks,
// and the audit entry of every request that passed origin and token.
const viewer = new URL('../src/viewer.js', import.meta.url);
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
let child, port, home, token, lib;

const ref = { db: 'exampledb', schema: 'example', category: 'Example Reports', name: 'example-report' };
const other = { ...ref, name: 'example-report-2' };
const sql = 'select order_id, status_code from example.orders';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

function request({ method = 'GET', path: p = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const origin = () => `http://127.0.0.1:${port}`;
const post = (route, body, headers = {}) => request({
  method: 'POST', path: route, body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin: origin(), 'x-auspex-token': token, 'content-type': 'application/json', ...headers },
});
function auditEntries() {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)).map(l => JSON.parse(l));
}

function seedDraft(r) {
  lib.saveDraft({ ref: r, title: 'Example report', sql });
  lib.appendRun('draft', r, { at: '2026-10-01T08:00:00.000Z', sqlHash: sqlHash(sql), durationMs: 9, rows: 2, warnings: [] }, null);
}

before(async () => {
  port = await freePort();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-viewer-approve-'));
  lib = new Library(path.join(home, 'library'));
  seedDraft(ref);
  seedDraft(other);
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_VIEWER_PORT: String(port), AUSPEX_PROFILES_FILE: path.join(home, 'none.json'),
    AUSPEX_LIBRARY_DIR: path.join(home, 'library'), AUSPEX_LOG_DIR: path.join(home, 'logs'), AUSPEX_MEMORY_DIR: path.join(home, 'memory') };
  child = spawn(process.execPath, [fileURLToPath(viewer)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let err = '';
    child.stdout.on('data', d => { if (String(d).includes('Auspex viewer:')) resolve(); });
    child.stderr.on('data', d => { err += d; });
    child.once('exit', code => reject(new Error(`viewer exited with ${code}: ${err}`)));
  });
  const res = await request({ path: '/' });
  token = res.text.match(/<meta name="auspex-token" content="([0-9a-f]{64})">/)?.[1];
});

after(() => {
  child?.kill();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('the page carries a per-process token and may not be framed', async () => {
  assert.ok(token, 'token embedded in the page');
  assert.ok(!page.includes(token), 'the token is not in the source file');
  const res = await request({ path: '/' });
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('requests without the right origin, token or host are refused and change nothing', async () => {
  const body = JSON.stringify(ref);
  const cases = [
    { origin: undefined },
    { origin: 'http://example.test' },
    { origin: `http://localhost:${port}` },
    { origin: 'null' },
    { 'x-auspex-token': undefined },
    { 'x-auspex-token': 'x'.repeat(64) },
    { 'x-auspex-token': `${'0'.repeat(63)}` },
  ];
  for (const c of cases) {
    const headers = { origin: origin(), 'x-auspex-token': token, 'content-type': 'application/json', ...c };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const res = await request({ method: 'POST', path: '/api/reports/approve', body, headers });
    assert.equal(res.status, 403, JSON.stringify(c));
    assert.equal(res.json.code, 'x-auspex-token' in c ? 'TOKEN_INVALID' : 'ORIGIN_INVALID', JSON.stringify(c));
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  const foreignHost = await request({ method: 'POST', path: '/api/reports/approve', body,
    headers: { host: 'example.test', origin: 'http://example.test', 'x-auspex-token': token, 'content-type': 'application/json' } });
  assert.equal(foreignHost.status, 403);
  assert.equal(lib.exists('draft', ref), true, 'still a draft');
  assert.equal(auditEntries().length, 0, 'refused requests are not audited');
});

test('methods, content type, body shape, size and traversal are checked', async () => {
  assert.equal((await request({ path: '/api/reports/approve' })).status, 405);
  assert.equal((await request({ method: 'POST', path: '/api/reports' })).status, 405);
  assert.equal((await post('/api/reports/approve', ref, { 'content-type': 'text/plain' })).status, 415);
  for (const body of [
    'not json', '[]', 'null', '"x"',
    { ...ref, extra: 1 },
    { ...ref, name: 42 },
    { db: ref.db, schema: ref.schema, category: ref.category },
    { ...ref, category: '..' },
    { ...ref, schema: '../../SELECT' },
    { ...ref, category: 'Example Reports/../..' },
    { ...ref, name: '../example-report' },
    { ...ref, name: 'Example Report' },
    { ...ref, db: 'ExampleDB' },
  ]) {
    const res = await post('/api/reports/approve', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${res.text}`);
  }
  const big = await post('/api/reports/approve', JSON.stringify({ ...ref, name: 'a'.repeat(5000) }));
  assert.equal(big.status, 413);
  assert.equal(lib.exists('draft', ref), true);
});

test('approve and revoke move the report, answer 404/409 otherwise, and are audited', async () => {
  const before = auditEntries().length;
  assert.equal((await post('/api/reports/approve', { ...ref, name: 'missing-report' })).status, 404);
  assert.equal((await post('/api/reports/revoke', ref)).status, 409, 'a draft cannot be revoked');

  const ok = await post('/api/reports/approve', ref);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.stage, ok.json.version], ['approved', 1]);
  assert.equal(lib.exists('approved', ref), true);
  assert.equal(lib.exists('draft', ref), false);
  const graph = path.join(home, 'memory', 'exampledb', 'graph.json');
  assert.ok(fs.existsSync(graph), 'the schema memory view is rebuilt');
  fs.rmSync(graph);
  assert.equal((await post('/api/reports/approve', ref)).status, 409, 'already approved');

  const listed = (await request({ path: '/api/reports' })).json.reports;
  assert.deepEqual(listed.map(r => [r.name, r.stage]).sort(), [['example-report', 'approved'], ['example-report-2', 'draft']]);
  assert.equal(listed.find(r => r.stage === 'draft').activeVersion, 1);

  const back = await post('/api/reports/revoke', ref);
  assert.equal(back.status, 200, back.text);
  assert.deepEqual([back.json.stage, back.json.version], ['draft', 1]);
  assert.ok(fs.existsSync(graph), 'rebuilt again on revoke');
  assert.equal(lib.exists('draft', ref), true);
  assert.equal((await post('/api/reports/revoke', ref)).status, 409, 'already a draft');

  const entries = auditEntries().slice(before);
  assert.ok(entries.every(e => e.source === 'viewer' && e.actor === 'viewer' && /^[0-9a-f-]{36}$/.test(e.correlationId)));
  const done = entries.filter(e => !e.error);
  assert.deepEqual(done.map(e => [e.tool, e.report, e.fromStage, e.toStage, e.version]), [
    ['approve_report', 'exampledb/example/Example Reports/example-report', 'draft', 'approved', 1],
    ['revoke_report', 'exampledb/example/Example Reports/example-report', 'approved', 'draft', 1],
  ]);
  assert.equal(done[0].correlationId, ok.json.correlationId);
  assert.deepEqual(entries.filter(e => e.error).map(e => [e.tool, e.errorCode]), [
    ['approve_report', 'NOT_FOUND'], ['revoke_report', 'PRECONDITION_FAILED'], ['approve_report', 'PRECONDITION_FAILED'], ['revoke_report', 'PRECONDITION_FAILED'],
  ]);
  assert.ok(!JSON.stringify(entries).includes('status_code from'), 'no SQL in the audit log');
});

test('a draft without a successful run of its SQL is refused with 409', async () => {
  lib.saveDraft({ ref: other, sql: `${sql} where order_id > 0` });
  const res = await post('/api/reports/approve', other);
  assert.equal(res.status, 409);
  assert.match(res.json.error, /no successful run/);
  assert.equal(lib.exists('draft', other), true);
});

// The page block (stage-change) in isolation: which action a report offers,
// the confirm facts and the request it sends.
const block = page.match(/\/\/ stage-change:start[\s\S]*?\/\/ stage-change:end/)?.[0];
function loadBlock() {
  assert.ok(block, 'stage-change block found in viewer.html');
  const context = vm.createContext({ JSON });
  vm.runInContext(`${block}\nthis.stageChangeFor = stageChangeFor; this.stageChangeFacts = stageChangeFacts; this.postStageChange = postStageChange; this.invokeStageChange = invokeStageChange;`, context);
  return context;
}

test('the page offers approve on drafts and revoke on approved reports, with a route and a desktop command', () => {
  const { stageChangeFor } = loadBlock();
  const pick = sc => [sc.kind, sc.path, sc.command, sc.to];
  assert.deepEqual(pick(stageChangeFor({ stage: 'draft' })), ['approve', '/api/reports/approve', 'approve_report', 'approved']);
  assert.deepEqual(pick(stageChangeFor({ stage: 'approved' })), ['revoke', '/api/reports/revoke', 'revoke_report', 'draft']);
  assert.equal(stageChangeFor({ stage: 'execute' }), null);
  assert.equal(stageChangeFor(null), null);
  assert.match(stageChangeFor({ stage: 'draft' }).note, /schema memory view/);
});

test('the desktop page invokes the Tauri command with only the report location and maps setup errors', async () => {
  const { invokeStageChange } = loadBlock();
  const calls = [];
  const r = { ...ref, stage: 'draft', title: 'T', lastRun: null, extra: 'x' };
  const okInvoke = async (cmd, args) => { calls.push([cmd, args]); return { ok: true, stage: 'approved', version: 1 }; };
  assert.equal((await invokeStageChange(okInvoke, 'approve_report', r)).version, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['approve_report', ref]]);
  const failing = e => async () => { throw e; };
  await assert.rejects(invokeStageChange(failing({ code: 'PRECONDITION_FAILED', message: 'Report is approved, not draft.' }), 'approve_report', r),
    err => err.message === 'Report is approved, not draft.' && err.code === 'PRECONDITION_FAILED' && err.setupText === null);
  await assert.rejects(invokeStageChange(failing({ code: 'AUSPEX_ROOT_MISSING', message: 'x' }), 'approve_report', r), err => /auspexRoot/.test(err.setupText));
  await assert.rejects(invokeStageChange(failing({ code: 'NODE_NOT_FOUND', message: 'x' }), 'revoke_report', r), err => /AUSPEX_NODE/.test(err.setupText));
  await assert.rejects(invokeStageChange(failing('plain text'), 'revoke_report', r), err => err.message === 'plain text');
});

test('every setup text of the desktop has a Turkish translation', () => {
  for (const code of ['AUSPEX_ROOT_MISSING', 'NODE_NOT_FOUND']) {
    const text = page.match(new RegExp(`${code}: '([^']+)'`))?.[1];
    assert.ok(text, code);
    assert.ok(page.includes(`'${text}': '`), `TR entry for ${code}`);
  }
});

test('confirm facts show name, version, last run, rows and warnings', () => {
  const { stageChangeFacts } = loadBlock();
  const r = { ...ref, stage: 'draft', title: 'Example report', activeVersion: 3, approvedVersion: 1, lastRun: { at: '2026-10-01T08:00:00.000Z', rows: 2, warnings: 1 } };
  assert.deepEqual(JSON.parse(JSON.stringify(stageChangeFacts(r))), [
    ['Report', 'Example report'], ['Location', 'exampledb › example › Example Reports › example-report'], ['Version', 'v3'],
    ['Last run', '2026-10-01T08:00:00.000Z'], ['Rows', 2], ['Warnings', 1],
  ]);
  assert.equal(stageChangeFacts({ ...r, stage: 'approved' })[2][1], 'v1');
  assert.deepEqual(JSON.parse(JSON.stringify(stageChangeFacts({ ...r, lastRun: null, activeVersion: null }).map(f => f[1]).slice(2))), [null, null, null, null]);
});

test('the page sends the token and only the report location, and surfaces server errors', async () => {
  const { postStageChange } = loadBlock();
  const calls = [];
  const fakeFetch = status => async (url, init) => { calls.push({ url, init }); return { ok: status === 200, status, statusText: '', json: async () => (status === 200 ? { stage: 'approved' } : { error: 'Report is approved, not draft.' }) }; };
  const r = { ...ref, stage: 'draft', title: 'T', lastRun: null };
  assert.deepEqual(JSON.parse(JSON.stringify(await postStageChange(fakeFetch(200), 'tok', '/api/reports/approve', r))), { stage: 'approved' });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Auspex-Token'], 'tok');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), ref);
  await assert.rejects(postStageChange(fakeFetch(409), 'tok', '/api/reports/approve', r), err => /approved, not draft/.test(err.message) && !err.viewerRestarted);
  const refused = async () => ({ ok: false, status: 403, statusText: '', json: async () => ({ error: 'Missing or invalid token', code: 'TOKEN_INVALID' }) });
  await assert.rejects(postStageChange(refused, 'old-token', '/api/reports/approve', r), err => err.viewerRestarted === true);
});
