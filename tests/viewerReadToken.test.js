import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Starts src/viewer.js with a synthetic audit log and checks that the GET
// /api routes answer only requests that carry the per-process token, while
// the page and the vendor files stay open (they carry no private data).
const viewer = new URL('../src/viewer.js', import.meta.url);
const marker = 'examplePrivateMarker';
let child, port, home, token;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const get = (rawPath, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

before(async () => {
  port = await freePort();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-viewer-read-token-'));
  const logs = path.join(home, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, '2026-01-01.jsonl'),
    `${JSON.stringify({ ts: '2026-01-01T08:00:00.000Z', tool: 'query', profile: 'exampledb', sql: `select '${marker}' from example.orders` })}\n`);
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_VIEWER_PORT: String(port), AUSPEX_PROFILES_FILE: path.join(home, 'none.json'),
    AUSPEX_LIBRARY_DIR: path.join(home, 'library'), AUSPEX_LOG_DIR: logs, AUSPEX_MEMORY_DIR: path.join(home, 'memory') };
  child = spawn(process.execPath, [fileURLToPath(viewer)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let err = '';
    child.stdout.on('data', d => { if (String(d).includes('Auspex viewer:')) resolve(); });
    child.stderr.on('data', d => { err += d; });
    child.once('exit', code => reject(new Error(`viewer exited with ${code}: ${err}`)));
  });
  token = (await get('/')).text.match(/<meta name="auspex-token" content="([0-9a-f]{64})">/)?.[1];
});

after(() => {
  child?.kill();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

const readRoutes = ['/api/logs?day=2026-01-01', '/api/days', '/api/health', '/api/profiles', '/api/reports',
  '/api/report?stage=draft&db=exampledb&schema=example&category=General&name=example-report', '/api/memory',
  '/api/reports/trend?db=exampledb&schema=example&category=General&name=example-report',
  '/api/memory/graph?profile=exampledb', '/api/memory/table?profile=exampledb&schema=example&table=orders',
  '/api/example-unknown'];

test('read routes refuse requests without the token and return no data', async () => {
  for (const route of readRoutes) {
    for (const headers of [{}, { 'x-auspex-token': 'x'.repeat(64) }, { 'x-auspex-token': '0'.repeat(63) }]) {
      const res = await get(route, headers);
      assert.equal(res.status, 401, `${route} ${JSON.stringify(headers)}`);
      assert.deepEqual(JSON.parse(res.text), { error: 'Missing or invalid token', code: 'TOKEN_INVALID' });
    }
  }
});

test('read routes answer with the token', async () => {
  assert.ok(token, 'token embedded in the page');
  const logs = await get('/api/logs?day=2026-01-01', { 'x-auspex-token': token });
  assert.equal(logs.status, 200);
  assert.ok(logs.text.includes(marker));
  assert.equal((await get('/api/memory', { 'x-auspex-token': token })).status, 200);
  assert.equal((await get('/api/health', { 'x-auspex-token': token })).status, 200);
});

test('the host check still comes first and the page stays open', async () => {
  assert.equal((await get('/api/logs?day=2026-01-01', { host: 'example.test', 'x-auspex-token': token })).status, 403);
  assert.equal((await get('/')).status, 200);
});

test('the page sends the token on every read', () => {
  const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
  assert.match(page, /fetch\(url, \{ cache: 'no-store', headers: \{ 'x-auspex-token': pageToken \} \}\)/);
});
