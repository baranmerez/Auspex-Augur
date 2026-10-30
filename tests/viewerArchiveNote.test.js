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
import { Library, sqlHash } from '../src/reports/library.js';
import { approveInLibrary, approvedJoinPairs } from '../src/reports/service.js';

// Starts src/viewer.js on a free loopback port with a temporary schema memory
// and checks POST /api/memory/archive: host, origin, token, content type,
// body and note checks, the archive itself (notes.json and graph.json) and
// the audit entry of every request that passed origin and token.
const viewer = fileURLToPath(new URL('../src/viewer.js', import.meta.url));
let child, port, home, token, memory;
const profile = 'exampledb';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

function request({ method = 'GET', path: p = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...(token && method === 'GET' ? { 'x-auspex-token': token } : {}), ...headers } }, res => {
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
  method: 'POST', path: '/api/memory/archive', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin: origin(), 'x-auspex-token': token, 'content-type': 'application/json', ...headers },
});
function auditEntries() {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)).map(l => JSON.parse(l));
}
const noteOf = id => memory.readNotes(profile).notes.find(n => n.id === id);
const graphNote = id => JSON.parse(fs.readFileSync(path.join(home, 'memory', profile, 'graph.json'), 'utf8')).notes.find(n => n.id === id);

before(async () => {
  port = await freePort();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-viewer-archive-'));
  memory = new SchemaMemory(path.join(home, 'memory'));
  memory.addNote(profile, { kind: 'rule', schema: 'example', table: 'orders', column: 'status_code', text: 'Cancelled orders use status_code 9.' });
  memory.addNote(profile, { kind: 'observation', schema: 'example', table: 'orders', text: 'created_at is always filled.', evidence: { sql: 'select count(*) from example.orders', figures: { rows: 1200, filled: 1200 } } });
  memory.addNote(profile, { kind: 'inference', text: 'Test Ltd rows look like test data.' });
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

test('requests without the right host, origin or token are refused, change nothing and are not audited', async () => {
  assert.ok(token, 'token embedded in the page');
  const body = JSON.stringify({ profile, id: 1, reason: 'Outdated' });
  const cases = [
    { origin: undefined },
    { origin: 'http://example.test' },
    { origin: `http://localhost:${port}` },
    { origin: 'null' },
    { 'x-auspex-token': undefined },
    { 'x-auspex-token': 'x'.repeat(64) },
  ];
  for (const c of cases) {
    const headers = { origin: origin(), 'x-auspex-token': token, 'content-type': 'application/json', ...c };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const res = await request({ method: 'POST', path: '/api/memory/archive', body, headers });
    assert.equal(res.status, 403, JSON.stringify(c));
    assert.equal(res.json.code, 'x-auspex-token' in c ? 'TOKEN_INVALID' : 'ORIGIN_INVALID', JSON.stringify(c));
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  const foreignHost = await request({ method: 'POST', path: '/api/memory/archive', body,
    headers: { host: 'example.test', origin: 'http://example.test', 'x-auspex-token': token, 'content-type': 'application/json' } });
  assert.equal(foreignHost.status, 403);
  assert.equal(noteOf(1).status, 'active');
  assert.equal(auditEntries().length, 0);
});

test('method, content type, size and body shape are checked; bad requests are audited and change nothing', async () => {
  assert.equal((await request({ path: '/api/memory/archive' })).status, 405);
  assert.equal((await post({ profile, id: 1, reason: 'Outdated' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(JSON.stringify({ profile, id: 1, reason: 'x'.repeat(5000) }))).status, 413);
  const bad = [
    'not json',
    '[]',
    'null',
    { profile, id: 1 },
    { profile, id: 1, reason: 'Outdated', extra: true },
    { profile, id: '1', reason: 'Outdated' },
    { profile, id: 0, reason: 'Outdated' },
    { profile, id: 1.5, reason: 'Outdated' },
    { profile, id: -1, reason: 'Outdated' },
    { profile: 'ExampleDB', id: 1, reason: 'Outdated' },
    { profile: '../memory', id: 1, reason: 'Outdated' },
    { profile, id: 1, reason: '' },
    { profile, id: 1, reason: '   ' },
    { profile, id: 1, reason: ' padded' },
    { profile, id: 1, reason: 'a'.repeat(201) },
    { profile, id: 1, reason: 'two\nlines' },
    { profile, id: 1, reason: 42 },
  ];
  for (const b of bad) {
    const res = await post(b);
    assert.equal(res.status, 400, JSON.stringify(b));
  }
  assert.equal((await post({ profile, id: 1, reason: 'a'.repeat(200) })).status, 200, '200 characters are allowed');
  assert.equal(noteOf(2).status, 'active');
  const audited = auditEntries();
  assert.ok(audited.length >= bad.length, 'requests that passed origin and token are audited');
  assert.ok(audited.every(e => e.source === 'viewer' && e.actor === 'viewer' && e.tool === 'remember' && e.action === 'archive'));
});

test('archive answers 200 once, then 409; unknown notes and profiles 404; audit has no reason or text', async () => {
  const before = auditEntries().length;
  const ok = await post({ profile, id: 2, reason: 'Superseded by a newer measurement' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.note.status, 'archived');
  assert.equal(noteOf(2).archivedReason, 'Superseded by a newer measurement');
  assert.equal(graphNote(2).status, 'archived', 'graph.json rebuilt');
  const again = await post({ profile, id: 2, reason: 'Again' });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'PRECONDITION_FAILED');
  assert.equal(noteOf(2).archivedReason, 'Superseded by a newer measurement', 'reason kept');
  const missing = await post({ profile, id: 999, reason: 'Outdated' });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'NOT_FOUND');
  const noProfile = await post({ profile: 'testdb', id: 1, reason: 'Outdated' });
  assert.equal(noProfile.status, 404);
  assert.equal(fs.existsSync(path.join(home, 'memory', 'testdb')), false, 'no folder created for an unknown profile');
  const entries = auditEntries().slice(before);
  assert.equal(entries.length, 4);
  const [first, second, third] = entries;
  assert.deepEqual([first.profile, first.noteId, first.noteStatus, first.error], [profile, 2, 'archived', undefined]);
  assert.match(first.correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(second.errorCode, 'PRECONDITION_FAILED');
  assert.equal(third.errorCode, 'NOT_FOUND');
  const raw = JSON.stringify(entries);
  assert.ok(!raw.includes('Superseded') && !raw.includes('created_at is always'), 'no reason or note text in the audit log');
});

test('archiving keeps the "used" relations of approved reports in the rebuilt view', async () => {
  const lib = new Library(path.join(home, 'library'));
  const ref = { db: profile, schema: 'example', category: 'Example Reports', name: 'example-report' };
  const joinSql = 'select o.order_id from example.orders o join example.customers c on c.customer_id = o.customer_id';
  lib.saveDraft({ ref, sql: joinSql });
  const last = { sqlHash: sqlHash(joinSql), summary: { joins: [{ columnPairs: [{ left: 'example.orders.customer_id', right: 'example.customers.customer_id' }] }] } };
  lib.appendRun('draft', ref, { at: '2026-10-01T08:00:00.000Z', sqlHash: sqlHash(joinSql), durationMs: 5, rows: 1, warnings: [] }, last);
  const note = memory.addNote(profile, { kind: 'rule', schema: 'example', table: 'customers', text: 'customer_id is the key.' });
  approveInLibrary(lib, ref, { by: 'viewer', memory: new SchemaMemory(path.join(home, 'memory'), { approvedJoins: p => approvedJoinPairs(lib, p) }) });
  const usedEdges = () => JSON.parse(fs.readFileSync(path.join(home, 'memory', profile, 'graph.json'), 'utf8')).edges
    .filter(e => e.level === 'used').map(e => [e.from, e.to, e.columns.join(',')]);
  assert.deepEqual(usedEdges(), [['example.orders', 'example.customers', 'customer_id']], 'seeded');
  const res = await post({ profile, id: note.id, reason: 'Outdated' });
  assert.equal(res.status, 200, res.text);
  assert.equal(graphNote(note.id).status, 'archived');
  assert.deepEqual(usedEdges(), [['example.orders', 'example.customers', 'customer_id']], 'still there after the archive');
});

// ----- A failed archive keeps the dialog open with the typed reason -----
test('page: a failed archive stays in the open dialog with a persistent alert and the typed reason; busy blocks a second submit', () => {
  const src = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
  const confirm = src.match(/function confirmArchiveNote\(n\) \{[\s\S]*?\r?\n\}\r?\n/)[0];
  assert.match(confirm, /const status = h\('div', \{ class: 'dlg-status', role: 'alert' \}\);/);
  assert.match(confirm, /const failure = await runArchiveNote\(state\.db, n, input\.value\);\s*if \(!failure\) \{ busy = false; dlg\.close\('ok'\); return; \}/);
  assert.match(confirm, /status\.textContent = failureText\(failure\);/);
  assert.match(confirm, /input\.readOnly = on;/, 'the reason is kept (read-only while busy, editable after)');
  assert.match(confirm, /const allowed = \(\) => !busy && !final && !archiveReasonProblem\(input\.value\);/, 'no second submit while busy or after an unknown outcome');
  assert.match(confirm, /dlg\.oncancel = ev => \{ if \(busy\) ev\.preventDefault\(\); \};/);
  assert.doesNotMatch(confirm, /method: 'dialog'/);
  const run = src.match(/async function runArchiveNote\(profile, n, text\) \{[\s\S]*?\r?\n\}\r?\n/)[0];
  assert.match(run, /catch \(err\) \{\s*return actionFailure\(err\);/);
  assert.match(run, /finally \{[\s\S]*state\.memory = await getJson\('\/api\/memory'\)/, 'the notes are read again after any outcome');
});
