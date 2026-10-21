import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedExampleMemory, seedExampleViewsAndFunctions } from './fixtures/exampleMemory.js';

// /api/memory/function serves one function file of the schema memory with
// the token and path checks of /api/memory/table; the graph carries the
// functions array and the view fields.
const viewer = new URL('../src/viewer.js', import.meta.url);
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-viewer-fn-'));
  const memoryDir = path.join(home, 'memory');
  seedExampleMemory(memoryDir, 'exampledb');
  seedExampleViewsAndFunctions(memoryDir, 'exampledb');
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_VIEWER_PORT: String(port), AUSPEX_PROFILES_FILE: path.join(home, 'none.json'),
    AUSPEX_LIBRARY_DIR: path.join(home, 'library'), AUSPEX_LOG_DIR: path.join(home, 'logs'), AUSPEX_MEMORY_DIR: memoryDir };
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

const route = file => `/api/memory/function?profile=exampledb&file=${encodeURIComponent(file)}`;

test('a function file is served with the token only', async () => {
  assert.equal((await get(route('functions/example/order_total.json'))).status, 401);
  const res = await get(route('functions/example/order_total.json'), { 'x-auspex-token': token });
  assert.equal(res.status, 200);
  const rec = JSON.parse(res.text);
  assert.deepEqual([rec.schema, rec.name, rec.overloads.length], ['example', 'order_total', 2]);
});

test('other paths are refused: tables, traversal, case, separators, other profiles', async () => {
  for (const file of ['tables/example/orders.json', 'functions/../graph.json', 'functions/example/order_total.JSON', 'functions/Example/x.json',
    'functions/example/a/b.json', 'functions\\example\\order_total.json', 'graph.json', 'functions//x.json']) {
    const res = await get(route(file), { 'x-auspex-token': token });
    assert.equal(res.status, 400, file);
    assert.deepEqual(JSON.parse(res.text), { error: 'Invalid memory file' }, file);
  }
  const badProfile = await get('/api/memory/function?profile=..&file=functions/example/order_total.json', { 'x-auspex-token': token });
  assert.equal(badProfile.status, 400);
  const missing = await get(route('functions/example/nope.json'), { 'x-auspex-token': token });
  assert.deepEqual([missing.status, JSON.parse(missing.text).error], [400, 'File not found']);
  const table = await get('/api/memory/table?profile=exampledb&file=functions/example/order_total.json', { 'x-auspex-token': token });
  assert.equal(table.status, 400, 'the table route still accepts table files only');
});

test('the graph carries functions and the view fields', async () => {
  const graph = JSON.parse((await get('/api/memory/graph?profile=exampledb', { 'x-auspex-token': token })).text);
  assert.deepEqual(graph.functions.map(f => f.id), ['example.order_count', 'example.order_report', 'example.order_total']);
  assert.deepEqual(graph.nodes.find(n => n.id === 'example.v_order_list').viewFunctions, ['example.order_total']);
  assert.ok(graph.edges.some(e => e.level === 'view'));
});
