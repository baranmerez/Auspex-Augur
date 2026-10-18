import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaMemory } from '../src/memory/store.js';
import { seedExampleMemory } from './fixtures/exampleMemory.js';

// Starts src/viewer.js on a free loopback port with a temporary schema memory
// and checks POST /api/memory/column-score: host, origin, token, method,
// content type, size, strict body, 404/409 cases, the write (user layer only,
// clear semantics, graph.json rebuilt) and the audit entries (no free text).
const viewer = fileURLToPath(new URL('../src/viewer.js', import.meta.url));
const route = '/api/memory/column-score';
let child, port, home, token, memory;
const profile = 'exampledb';

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
const post = (body, headers = {}) => request({
  method: 'POST', path: route, body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin: origin(), 'x-auspex-token': token, 'content-type': 'application/json', ...headers },
});
function auditEntries() {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)).map(l => JSON.parse(l));
}
const fresh = () => new SchemaMemory(path.join(home, 'memory'));
const scoreOf = column => fresh().readTable(profile, 'example', 'orders').columnScores[column];
const graphScore = column => JSON.parse(fs.readFileSync(path.join(home, 'memory', profile, 'graph.json'), 'utf8')).nodes.find(n => n.id === 'example.orders').columnScores[column];
const ok = (extra = {}) => ({ profile, schema: 'example', table: 'orders', column: 'amount', score: 4, ...extra });

before(async () => {
  port = await freePort();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-viewer-score-'));
  memory = seedExampleMemory(path.join(home, 'memory'), profile);
  fs.mkdirSync(path.join(home, 'memory', 'emptydb'), { recursive: true });
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_VIEWER_PORT: String(port), AUSPEX_PROFILES_FILE: path.join(home, 'none.json'),
    AUSPEX_LIBRARY_DIR: path.join(home, 'library'), AUSPEX_LOG_DIR: path.join(home, 'logs'), AUSPEX_MEMORY_DIR: path.join(home, 'memory') };
  child = spawn(process.execPath, [viewer], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('requests without the right host, origin or token get 403, change nothing and are not audited', async () => {
  assert.ok(token, 'token embedded in the page');
  const before = JSON.stringify(scoreOf('amount'));
  const body = JSON.stringify(ok());
  for (const c of [{ origin: undefined }, { origin: 'http://example.test' }, { origin: `http://localhost:${port}` }, { origin: 'null' }, { 'x-auspex-token': undefined }, { 'x-auspex-token': 'x'.repeat(64) }]) {
    const headers = { origin: origin(), 'x-auspex-token': token, 'content-type': 'application/json', ...c };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const res = await request({ method: 'POST', path: route, body, headers });
    assert.equal(res.status, 403, JSON.stringify(c));
    assert.equal(res.json.code, 'x-auspex-token' in c ? 'TOKEN_INVALID' : 'ORIGIN_INVALID', JSON.stringify(c));
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  const foreignHost = await request({ method: 'POST', path: route, body, headers: { host: 'example.test', origin: 'http://example.test', 'x-auspex-token': token, 'content-type': 'application/json' } });
  assert.equal(foreignHost.status, 403);
  assert.equal(JSON.stringify(scoreOf('amount')), before);
  assert.equal(auditEntries().length, 0);
});

test('method, content type and size: 405, 415, 413', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await request({ method, path: route });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'POST');
  }
  assert.equal((await post(ok(), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(ok(), { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post(JSON.stringify({ ...ok(), pad: 'x'.repeat(5000) }))).status, 413);
});

test('strict body: unknown keys, missing fields and bad values get 400 and change nothing', async () => {
  const before = JSON.stringify(fresh().readTable(profile, 'example', 'orders').columnScores);
  const bad = [
    'not json', '[]', 'null', '42',
    { schema: 'example', table: 'orders', column: 'amount', score: 4 },
    ok({ extra: true }),
    ok({ by: 'agent' }),
    ok({ reason: 'free text is not accepted here' }),
    ok({ note: 'usage note' }),
    ok({ score: 0 }), ok({ score: 6 }), ok({ score: 2.5 }), ok({ score: '4' }), ok({ score: null }),
    { profile, schema: 'example', table: 'orders', column: 'amount' },
    ok({ clear: true }),
    { profile, schema: 'example', table: 'orders', column: 'amount', clear: false },
    { profile, schema: 'example', table: 'orders', column: 'amount', clear: 'true' },
    { profile, schema: 'example', table: 'orders', column: 'amount', clear: true, roles: [] },
    ok({ roles: 'join' }), ok({ roles: ['owner'] }), ok({ roles: ['join', 'join'] }), ok({ roles: [1] }),
    ok({ profile: 'ExampleDB' }), ok({ profile: '../memory' }), ok({ profile: '' }),
    ok({ schema: '' }), ok({ table: 42 }), ok({ column: 'a'.repeat(64) }), ok({ column: 'ş'.repeat(32) }), ok({ column: 'two\nlines' }), ok({ column: 'del\u007fx' }),
  ];
  for (const b of bad) {
    const res = await post(b);
    assert.equal(res.status, 400, JSON.stringify(b));
  }
  assert.equal(JSON.stringify(fresh().readTable(profile, 'example', 'orders').columnScores), before);
});

test('unknown profile, table or column: 404; table not described: 409', async () => {
  const cases = [
    [ok({ profile: 'otherdb' }), 404], [ok({ profile: 'emptydb' }), 404],
    [ok({ table: 'status_codes' }), 404], [ok({ column: 'missing_column' }), 404],
    [ok({ table: 'order_items', column: 'order_id' }), 409],
    [{ profile, schema: 'example', table: 'orders', column: 'amount', clear: true }, 409],
  ];
  for (const [b, status] of cases) {
    const res = await post(b);
    assert.equal(res.status, status, JSON.stringify(b));
    assert.equal(res.json.code, status === 404 ? 'NOT_FOUND' : 'PRECONDITION_FAILED', JSON.stringify(b));
  }
  assert.equal(fs.existsSync(path.join(home, 'memory', 'otherdb')), false, 'no folder created for an unknown profile');
});

test('a score writes the user layer only; the agent layer and other columns stay; the view is rebuilt', async () => {
  const agentBefore = JSON.stringify(scoreOf('amount').agent);
  const otherBefore = JSON.stringify(scoreOf('order_id'));
  const res = await post(ok({ roles: ['aggregate', 'display'] }));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.json.column, res.json.score, res.json.scoreBy], ['amount', 4, 'user']);
  const saved = scoreOf('amount');
  assert.deepEqual([saved.user.score, saved.user.roles], [4, ['display', 'aggregate']], 'roles in canonical order');
  assert.equal(JSON.stringify(saved.agent), agentBefore, 'agent layer untouched');
  assert.equal(JSON.stringify(scoreOf('order_id')), otherBefore);
  assert.deepEqual([graphScore('amount').score, graphScore('amount').scoreBy], [4, 'user'], 'graph.json rebuilt');
  // A second score keeps the first in the user history.
  assert.equal((await post(ok({ score: 2 }))).status, 200);
  const again = scoreOf('amount');
  assert.equal(again.user.score, 2);
  assert.equal(again.user.roles, undefined, 'no roles given: none stored');
  assert.equal(again.user.history[0].score, 4);
  assert.equal(JSON.stringify(again.agent), agentBefore);
});

test('clear removes only the user score; the agent score is effective again; a second clear is 409', async () => {
  const res = await post({ profile, schema: 'example', table: 'orders', column: 'amount', clear: true });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.json.score, res.json.scoreBy], [3, 'agent']);
  const saved = scoreOf('amount');
  assert.equal(saved.user.cleared, true);
  assert.equal(saved.user.history[0].score, 2, 'the removed score stays in history');
  assert.equal(saved.agent.score, 3);
  assert.deepEqual([graphScore('amount').score, graphScore('amount').scoreBy], [3, 'agent']);
  assert.equal((await post({ profile, schema: 'example', table: 'orders', column: 'amount', clear: true })).status, 409);
  // Non-ASCII column names work.
  assert.equal((await post(ok({ column: 'teslim_durum_kodu', score: 3 }))).status, 200);
});

test('audit: score_columns, layer user, actor viewer, names and numbers only, no free text', async () => {
  const entries = auditEntries();
  assert.ok(entries.length > 10, 'requests that passed origin and token are audited');
  for (const e of entries) {
    assert.deepEqual([e.tool, e.source, e.actor, e.layer], ['score_columns', 'viewer', 'viewer', 'user']);
    assert.ok(!('reason' in e) && !('note' in e) && !('text' in e) && !('summary' in e), JSON.stringify(e));
    for (const [k, v] of Object.entries(e)) {
      if (['error', 'ts', 'correlationId'].includes(k)) continue;
      assert.ok(typeof v !== 'string' || v.length <= 80, `${k} is short: ${v}`);
    }
    assert.ok(!JSON.stringify(e).includes('free text is not accepted here'));
    assert.ok(!JSON.stringify(e).includes('usage note'));
  }
  const okEntries = entries.filter(e => !e.error);
  assert.deepEqual(okEntries.map(e => [e.action, e.column, e.score ?? null]),
    [['set', 'amount', 4], ['set', 'amount', 2], ['clear', 'amount', null], ['set', 'teslim_durum_kodu', 3]]);
  assert.deepEqual(okEntries[0].roles, ['display', 'aggregate']);
  assert.deepEqual([okEntries[0].profile, okEntries[0].schema, okEntries[0].table, okEntries[0].columns], [profile, 'example', 'orders', 1]);
  const refused = entries.filter(e => e.error);
  assert.ok(refused.some(e => e.errorCode === 'NOT_FOUND') && refused.some(e => e.errorCode === 'PRECONDITION_FAILED') && refused.some(e => e.errorCode === 'INVALID_INPUT'));
});

test('the read-only routes stay GET only and the page carries the new dialog', async () => {
  assert.equal((await request({ method: 'POST', path: '/api/memory/graph?profile=exampledb', headers: { origin: origin(), 'x-auspex-token': token } })).status, 405);
  const page = await request({ path: '/' });
  assert.match(page.text, /<dialog class="dlg" id="scoreDlg"/);
});
