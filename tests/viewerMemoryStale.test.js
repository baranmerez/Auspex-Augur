import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
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

// ----- The page side (mem-state block of src/viewer.html, in isolation with a
// recording h()): a stale graph is called out with a Refresh action, and a
// stale graph without an earlier one is explained with Retry instead of the
// raw message.
const msPage = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const msBlock = msPage.match(/\/\/ mem-state:start[\s\S]*?\/\/ mem-state:end/)?.[0];
const msH = (tag, attrs = {}, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false) });
const msText = n => (typeof n === 'string' ? n : n ? n.kids.map(msText).join(' ') : '');
const msAll = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); n.kids.forEach(k => msAll(k, pred, out)); } return out; };
const msTR = vm.runInNewContext(`(${msPage.match(/const TR = (\{[\s\S]*?\n\});/)[1]})`);
function msLoad(lang = 'en') {
  assert.ok(msBlock, 'mem-state block found');
  const ctx = vm.createContext({ h: msH, t: (en, vars = {}) => String(lang === 'tr' && msTR[en] !== undefined ? msTR[en] : en).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') });
  vm.runInContext(`${msBlock}\nObject.assign(this, { memIsStale, memStaleBanner, memErrorBox, memStaleUnbuilt });`, ctx);
  return ctx;
}

test('page: the summary or the graph marks the memory stale', () => {
  const ctx = msLoad();
  assert.equal(ctx.memIsStale(null, null), false);
  assert.equal(ctx.memIsStale({ stale: true }, null), true);
  assert.equal(ctx.memIsStale({ generatedAt: 'x' }, { stale: true }), true);
  assert.equal(ctx.memIsStale({ generatedAt: 'x' }, { generatedAt: 'x' }), false);
});

test('page: the banner explains the stale graph per client and offers Refresh', () => {
  const ctx = msLoad();
  assert.equal(ctx.memStaleBanner(false, {}), null);
  let refreshed = 0;
  const web = ctx.memStaleBanner(true, { desktop: false, onRefresh: () => refreshed++ });
  assert.equal(web.attrs.role, 'status');
  assert.match(msText(web), /may be out of date/);
  assert.match(msText(web), /The viewer rebuilds it when you refresh/);
  const btn = msAll(web, n => n.tag === 'button')[0];
  assert.equal(btn.attrs.type, 'button');
  btn.attrs.onclick();
  assert.equal(refreshed, 1);
  const desk = ctx.memStaleBanner(true, { desktop: true, onRefresh() {} });
  assert.match(msText(desk), /The desktop app only shows this; the next memory change or agent read rebuilds it/);
  assert.doesNotMatch(msText(desk), /rebuilds it when you refresh/);
});

test('page: a stale graph that could not be rebuilt, without an earlier one, is explained with Retry; other errors keep their detail', () => {
  const ctx = msLoad();
  let retried = 0;
  const box = msAll(ctx.memErrorBox('exampledb', ctx.memStaleUnbuilt, { stale: true, onRetry: () => retried++ }), n => n.attrs.role === 'alert')[0];
  assert.match(msText(box), /The schema memory graph of exampledb is out of date and could not be rebuilt; there is no earlier graph to show/);
  assert.doesNotMatch(msText(box), /see the viewer output\./, 'not the raw server message');
  msAll(box, n => n.tag === 'button')[0].attrs.onclick();
  assert.equal(retried, 1);
  assert.match(msText(ctx.memErrorBox('exampledb', 'graph.json: not found', { stale: true, onRetry() {} })), /could not be rebuilt/, 'the desktop words it differently; the stale summary explains it');
  const other = ctx.memErrorBox('exampledb', 'Memory path is a link or junction; refused.', { stale: false, onRetry() {} });
  assert.match(msText(other), /could not be loaded/);
  assert.match(msText(other), /Memory path is a link or junction; refused\./);
});

test('page: Turkish texts exist for every banner and error string', () => {
  const keys = [...msBlock.matchAll(/\bt\('((?:[^'\\]|\\.)+)'/g)].map(m => m[1].replace(/\\'/g, "'"));
  assert.deepEqual([...new Set(keys)].filter(k => msTR[k] === undefined), []);
  assert.match(msText(msLoad('tr').memStaleBanner(true, { desktop: false, onRefresh() {} })), /güncel olmayabilir/);
});

test('page: Schema, Rules, Views and Functions draw the banner and the error box and never read a failed graph in a loop', () => {
  assert.match(msPage, /<div class="chips" id="chips"><\/div>\s*<div id="memStale"><\/div>/);
  for (const fn of ['renderSchema', 'renderRules', 'renderObjectTab']) assert.match(msPage, new RegExp(`function ${fn}\\([a-z]*\\) \\{\\s*renderMemStale\\(\\);`), fn);
  assert.equal((msPage.match(/if \(memGraphWanted\(mv, state\.db, sum\)\) \{/g) || []).length, 3);
  assert.equal((msPage.match(/memErrorBox\(state\.db, mv\.error, \{ stale: !!sum\.stale, onRetry: \(\) => retryMemView\(state\.db\) \}\)/g) || []).length, 3);
  assert.match(msPage, /memStaleBanner\(stale, \{ desktop: !!tauriCore, onRefresh: \(\) => load\(\) \}\)/);
});

test('page: the route\'s rebuild-failed message is the one the page explains', async () => {
  const dir = path.dirname(staleFile);
  const notesFile = path.join(dir, 'notes.json'), graphFile = path.join(dir, 'graph.json');
  const notes = fs.readFileSync(notesFile, 'utf8'), graph = fs.readFileSync(graphFile, 'utf8');
  fs.writeFileSync(staleFile, '{}');
  fs.writeFileSync(notesFile, '{ broken');
  fs.rmSync(graphFile);
  try {
    const res = await get('/api/memory/graph?profile=exampledb', { 'x-auspex-token': token });
    assert.notEqual(res.status, 200);
    assert.equal(JSON.parse(res.text).error, msLoad().memStaleUnbuilt);
    const summary = JSON.parse((await get('/api/memory', { 'x-auspex-token': token })).text);
    assert.deepEqual(summary.profiles.find(p => p.name === 'exampledb'), { name: 'exampledb', generatedAt: null, stale: true });
  } finally {
    fs.writeFileSync(notesFile, notes);
    fs.writeFileSync(graphFile, graph);
  }
});
