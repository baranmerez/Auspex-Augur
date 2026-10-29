import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedExampleMemory } from './fixtures/exampleMemory.js';

// EN02: a stale graph (graph.stale after a failed rebuild) is rebuilt by the
// viewer's graph route before it is served.
const viewer = new URL('../src/viewer.js', import.meta.url);
let child, port, home, token, noteId, staleFile;

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
  const memory = seedExampleMemory(memoryDir, 'exampledb');
  // A note stored while graph.json could not be rebuilt.
  const original = memory.rebuildViewUnlocked;
  memory.rebuildViewUnlocked = () => { memory.rebuildViewUnlocked = original; throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  noteId = memory.addNote('exampledb', { kind: 'rule', schema: 'example', table: 'customers', text: 'Example rule' }).id;
  staleFile = path.join(memoryDir, 'exampledb', 'graph.stale');
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

test('the graph route rebuilds a stale graph once and serves the stored note', async () => {
  assert.ok(fs.existsSync(staleFile), 'stale before the request');
  const res = await get('/api/memory/graph?profile=exampledb', { 'x-auspex-token': token });
  assert.equal(res.status, 200);
  const graph = JSON.parse(res.text);
  assert.ok(graph.notes.some(n => n.id === noteId));
  assert.equal(graph.stale, undefined);
  assert.ok(!fs.existsSync(staleFile), 'the mark is cleared');
  const notes = JSON.parse(fs.readFileSync(path.join(path.dirname(staleFile), 'notes.json'), 'utf8')).notes;
  assert.equal(notes.filter(n => n.text === 'Example rule').length, 1, 'no second note');
});

test('records without graph.json are listed and rebuilt by the viewer', async () => {
  const dir = path.dirname(staleFile);
  fs.rmSync(path.join(dir, 'graph.json'));
  const summary = JSON.parse((await get('/api/memory', { 'x-auspex-token': token })).text);
  assert.ok(summary.profiles.some(p => p.name === 'exampledb' && p.stale === undefined), 'listed after the rebuild');
  assert.ok(fs.existsSync(path.join(dir, 'graph.json')));
});

test('a graph that cannot be rebuilt is served with stale: true', async () => {
  const dir = path.dirname(staleFile);
  const notesFile = path.join(dir, 'notes.json');
  const notes = fs.readFileSync(notesFile, 'utf8');
  fs.writeFileSync(staleFile, '{}');
  fs.writeFileSync(notesFile, '{ broken');
  try {
    const res = await get('/api/memory/graph?profile=exampledb', { 'x-auspex-token': token });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).stale, true);
    const summary = JSON.parse((await get('/api/memory', { 'x-auspex-token': token })).text);
    assert.equal(summary.profiles.find(p => p.name === 'exampledb').stale, true);
  } finally {
    fs.writeFileSync(notesFile, notes);
  }
});
