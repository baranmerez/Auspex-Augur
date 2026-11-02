import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedExampleMemory } from './fixtures/exampleMemory.js';

// The table page's memory edits: POST /api/memory/edit and GET
// /api/memory/table-profile of src/viewer.js, and the same edits through
// src/stageCli.js memory-edit / table-profile as the desktop app runs them.
// One sequence of edits goes through both; the stored notes and profile come
// out the same (timestamps aside). Synthetic example data only.
const viewer = fileURLToPath(new URL('../src/viewer.js', import.meta.url));
const cli = fileURLToPath(new URL('../src/stageCli.js', import.meta.url));
const profile = 'exampledb';
let child, port, viewerHome, cliHome, token;

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
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
const origin = () => `http://127.0.0.1:${port}`;
const post = (body, headers = {}) => request({
  method: 'POST', path: '/api/memory/edit', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin: origin(), 'x-auspex-token': token, 'content-type': 'application/json', ...headers },
});
const cliEnv = home => {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json') };
  for (const k of ['AUSPEX_LIBRARY_DIR', 'AUSPEX_LOG_DIR', 'AUSPEX_MEMORY_DIR', 'AUSPEX_DATA_DIR']) delete env[k];
  return env;
};
function runCli(args, input = null) {
  const res = spawnSync(process.execPath, [cli, ...args], { env: cliEnv(cliHome), encoding: 'utf8', input: input ?? undefined });
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `one JSON line: ${res.stdout}${res.stderr}`);
  return { status: res.status, out: JSON.parse(lines[0]) };
}
const auditOf = home => {
  const dir = path.join(home, 'logs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)).map(l => JSON.parse(l)) : [];
};
const notesOf = home => JSON.parse(fs.readFileSync(path.join(home, 'memory', profile, 'notes.json'), 'utf8'));
const profileFile = home => path.join(home, 'memory', profile, 'table-profiles', 'example', 'orders.json');
// Stored state without timestamps and fingerprints (which carry the report
// and note hashes, equal in both homes, but are checked elsewhere).
const strip = v => JSON.parse(JSON.stringify(v, (k, x) => (/At$|^at$|^asOf$|^fingerprint$/.test(k) ? undefined : x)));

before(async () => {
  port = await freePort();
  viewerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-viewer-edit-'));
  cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-cli-edit-'));
  for (const home of [viewerHome, cliHome]) seedExampleMemory(path.join(home, 'memory'), profile);
  const env = { ...cliEnv(viewerHome), AUSPEX_VIEWER_PORT: String(port) };
  child = spawn(process.execPath, [viewer], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let err = '';
    child.stdout.on('data', d => { if (String(d).includes('Auspex viewer:')) resolve(); });
    child.stderr.on('data', d => { err += d; });
    child.once('exit', code => reject(new Error(`viewer exited with ${code}: ${err}`)));
  });
  token = (await request({ path: '/' })).text.match(/<meta name="auspex-token" content="([0-9a-f]{64})">/)?.[1];
});
after(() => {
  child?.kill();
  for (const home of [viewerHome, cliHome]) if (home) fs.rmSync(home, { recursive: true, force: true });
});

// The seed has notes #1 (rule on status_code) and #2 (observation on delivered_at).
const sequence = [
  { op: 'note-add', profile, schema: 'example', table: 'orders', kind: 'rule', text: 'An order is never deleted.\nCancelled orders keep their rows.' },
  { op: 'note-add', profile, schema: 'example', table: 'orders', column: 'amount', kind: 'observation', text: 'amount is never negative.' },
  { op: 'note-edit', profile, id: 2, text: 'Filled after delivery; empty while in transit.' },
  { op: 'profile-save', profile, schema: 'example', table: 'orders', sections: { purpose: 'One row per order of Example Co.', caveats: 'Never delete rows.' }, expectedVersion: null },
  { op: 'required-mark', profile, schema: 'example', table: 'orders', target: { schema: 'example', table: 'status_codes' }, required: true },
  { op: 'required-mark', profile, schema: 'example', table: 'orders', target: { schema: 'test', table: 'invoices' }, required: true },
  { op: 'required-mark', profile, schema: 'example', table: 'orders', target: { schema: 'test', table: 'invoices' }, required: false },
];

test('POST /api/memory/edit: host, origin and token checks come first; refused requests change nothing', async () => {
  assert.ok(token, 'token embedded in the page');
  const body = JSON.stringify(sequence[0]);
  for (const c of [{ origin: undefined }, { origin: 'http://example.test' }, { 'x-auspex-token': undefined }, { 'x-auspex-token': 'x'.repeat(64) }]) {
    const headers = { origin: origin(), 'x-auspex-token': token, 'content-type': 'application/json', ...c };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const res = await request({ method: 'POST', path: '/api/memory/edit', body, headers });
    assert.equal(res.status, 403, JSON.stringify(c));
  }
  const foreign = await request({ method: 'POST', path: '/api/memory/edit', body, headers: { host: 'example.test', origin: 'http://example.test', 'x-auspex-token': token, 'content-type': 'application/json' } });
  assert.equal(foreign.status, 403);
  assert.equal(auditOf(viewerHome).length, 0);
  assert.equal((await request({ path: '/api/memory/edit' })).status, 405);
  // Past the origin and token checks every request is audited.
  assert.equal((await post(sequence[0], { 'content-type': 'text/plain' })).status, 415);
  assert.equal(notesOf(viewerHome).notes.length, 2);
  assert.deepEqual(auditOf(viewerHome).map(e => e.errorCode), ['INVALID_INPUT']);
});

test('bad requests are refused with 400 and audited without their text', async () => {
  const bad = [
    'not json', '[]',
    { op: 'drop-table', profile },
    { ...sequence[0], extra: 'x' },
    { ...sequence[0], kind: 'inference' },
    { ...sequence[0], text: '   ' },
    { ...sequence[0], text: 'bell\u0007' },
    { op: 'note-edit', profile, id: '2', text: 'x' },
    { op: 'profile-save', profile, schema: 'example', table: 'orders', sections: { secret: 'x' }, expectedVersion: null },
    { op: 'required-mark', profile, schema: 'example', table: 'orders', target: { schema: 'example' }, required: true },
    { op: 'profile-review', profile, schema: 'example', table: 'orders', decision: 'maybe', proposalVersion: 1 },
  ];
  for (const b of bad) assert.equal((await post(b)).status, 400, JSON.stringify(b));
  assert.equal((await post({ ...sequence[0], profile: 'Example' })).json.code, 'PROFILE_INVALID');
  const notFound = await post({ ...sequence[0], table: 'nope' });
  assert.equal(notFound.status, 404);
  const big = await post({ op: 'profile-save', profile, schema: 'example', table: 'orders', sections: { purpose: 'x'.repeat(70000) }, expectedVersion: null });
  assert.equal(big.status, 413);
  assert.equal(notesOf(viewerHome).notes.length, 2);
  assert.ok(!fs.existsSync(profileFile(viewerHome)));
  assert.ok(!JSON.stringify(auditOf(viewerHome)).includes('never deleted'), 'no note text in the audit log');
});

test('the same edits through the viewer and stageCli store the same notes and profile', async () => {
  for (const req of sequence) {
    const v = await post(req);
    assert.equal(v.status, 200, `${req.op}: ${v.text}`);
    const c = runCli(['memory-edit'], JSON.stringify(req));
    assert.equal(c.status, 0, `${req.op}: ${JSON.stringify(c.out)}`);
    assert.equal(c.out.ok, true);
  }
  assert.deepEqual(strip(notesOf(viewerHome)), strip(notesOf(cliHome)));
  assert.deepEqual(strip(JSON.parse(fs.readFileSync(profileFile(viewerHome), 'utf8'))), strip(JSON.parse(fs.readFileSync(profileFile(cliHome), 'utf8'))));
  const notes = notesOf(viewerHome).notes;
  const edited = notes.find(n => n.id === 2);
  assert.equal(edited.status, 'archived');
  assert.equal(edited.archivedReason, 'edited');
  const replacement = notes.find(n => n.replaces === 2);
  assert.equal(replacement.source, 'user');
  assert.equal(edited.replacedBy, replacement.id);
  assert.equal(notes.find(n => n.text.startsWith('An order is never deleted')).source, 'user');
  // Audit entries name the tool the edit acts like, never the text.
  for (const home of [viewerHome, cliHome]) {
    const entries = auditOf(home).filter(e => !e.error);
    assert.deepEqual(entries.map(e => `${e.tool}:${e.action}`), ['remember:add', 'remember:add', 'remember:edit', 'table_profile:save', 'table_profile:mark', 'table_profile:mark', 'table_profile:unmark']);
    assert.ok(!JSON.stringify(entries).includes('Example Co'));
  }
});

test('GET /api/memory/table-profile and stageCli table-profile return the same view', async () => {
  const v = await request({ path: `/api/memory/table-profile?profile=${profile}&schema=example&table=orders` });
  assert.equal(v.status, 200, v.text);
  const c = runCli(['table-profile', '--profile', profile, '--schema', 'example', '--table', 'orders']);
  assert.equal(c.status, 0);
  const { ok, ...cliView } = c.out;
  assert.deepEqual(strip(v.json), strip(cliView));
  assert.equal(v.json.profile.author, 'user');
  assert.equal(v.json.profile.owner, 'user');
  assert.equal(v.json.profile.freshness, 'fresh');
  assert.deepEqual(v.json.requiredTables.map(r => [r.id, r.evidence.map(e => e.type).join(',')]), [['example.customers', 'catalog'], ['example.status_codes', 'user']]);
  assert.equal((await request({ path: `/api/memory/table-profile?profile=${profile}&schema=example&table=` })).status, 400);
  const noToken = await request({ path: `/api/memory/table-profile?profile=${profile}&schema=example&table=orders`, headers: { 'x-auspex-token': '' } });
  assert.equal(noToken.status, 401);
});

test('a stale edit is refused with 409 STALE_VERSION; a proposal is accepted with its version', async () => {
  const stale = await post({ op: 'profile-save', profile, schema: 'example', table: 'orders', sections: { purpose: 'Other text.' }, expectedVersion: null });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'STALE_VERSION');
  // An agent rewrite of the user's profile is a proposal (written here
  // through the store as the MCP tool would).
  const { SchemaMemory } = await import('../src/memory/store.js');
  for (const home of [viewerHome, cliHome]) new SchemaMemory(path.join(home, 'memory')).saveTableProfile(profile, { schema: 'example', table: 'orders', sections: { purpose: 'Agent rewrite.' } });
  const review = { op: 'profile-review', profile, schema: 'example', table: 'orders', decision: 'accept', proposalVersion: 2 };
  assert.equal((await post({ ...review, proposalVersion: 9 })).status, 409);
  const ok = await post(review);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.current, 2);
  const c = runCli(['memory-edit'], JSON.stringify(review));
  assert.equal(c.out.ok, true);
  assert.deepEqual(strip(JSON.parse(fs.readFileSync(profileFile(viewerHome), 'utf8'))), strip(JSON.parse(fs.readFileSync(profileFile(cliHome), 'utf8'))));
});

test('stageCli memory-edit refuses arguments, bad JSON and a too large request', () => {
  assert.equal(runCli(['memory-edit', '--profile', profile], '{}').out.code, 'INVALID_INPUT');
  assert.equal(runCli(['memory-edit'], 'not json').out.code, 'INVALID_INPUT');
  const big = runCli(['memory-edit'], JSON.stringify({ op: 'profile-save', profile, schema: 'example', table: 'orders', sections: { purpose: 'x'.repeat(70000) }, expectedVersion: 2 }));
  assert.equal(big.status, 1);
  assert.match(big.out.message, /too large/);
});
