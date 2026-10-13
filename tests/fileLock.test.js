import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withFileLock, LockBusyError } from '../src/fileLock.js';
import { Library } from '../src/reports/library.js';
import { SchemaMemory } from '../src/memory/store.js';

const srcUrl = rel => pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', rel)).href;
const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Runs an ES module snippet in a separate Node process.
function child(code) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('exit', code => resolve({ code, err, pid: p.pid }));
  });
}

test('two processes appending runs to one report keep every run', async () => {
  const root = tempDir('auspex-lock-lib-');
  const ref = { db: 'local', schema: 's', category: 'c', name: 'r' };
  new Library(root).saveDraft({ ref, sql: 'select 1' });
  const writer = tag => `
    import { Library } from '${srcUrl('reports/library.js')}';
    const lib = new Library(${JSON.stringify(root)});
    for (let i = 0; i < 40; i++) lib.appendRun('draft', ${JSON.stringify(ref)}, { at: new Date().toISOString(), n: '${tag}' + i, warnings: [] }, null);`;
  const results = await Promise.all([child(writer('a')), child(writer('b'))]);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const runs = new Library(root).readMeta('draft', ref).runs;
  assert.equal(runs.length, 80);
  assert.equal(new Set(runs.map(r => r.n)).size, 80);
  assert.equal(fs.existsSync(path.join(root, '.lock')), false, 'lock released');
});

test('two processes adding notes get unique ids and lose none', async () => {
  const root = tempDir('auspex-lock-mem-');
  const writer = tag => `
    import { SchemaMemory } from '${srcUrl('memory/store.js')}';
    const mem = new SchemaMemory(${JSON.stringify(root)});
    for (let i = 0; i < 30; i++) mem.addNote('shop', { kind: 'rule', text: '${tag} rule ' + i });`;
  const results = await Promise.all([child(writer('a')), child(writer('b'))]);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const notes = new SchemaMemory(root).readNotes('shop').notes;
  assert.equal(notes.length, 60);
  assert.equal(new Set(notes.map(n => n.id)).size, 60);
});

test('a lock left by a crashed process is taken over', async () => {
  const lockPath = path.join(tempDir('auspex-lock-crash-'), '.lock');
  const crashed = await child(`
    import { withFileLock } from '${srcUrl('fileLock.js')}';
    withFileLock(${JSON.stringify(lockPath)}, () => process.exit(3));`);
  assert.equal(crashed.code, 3);
  assert.ok(fs.existsSync(lockPath), 'the crashed process left its lock behind');
  assert.equal(withFileLock(lockPath, () => 'ran', { waitMs: 200 }), 'ran');
  assert.equal(fs.existsSync(lockPath), false);
});

test('an old lock is taken over even when its pid is alive', () => {
  const lockPath = path.join(tempDir('auspex-lock-old-'), '.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'someone-else' }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, old, old);
  assert.equal(withFileLock(lockPath, () => 'ran', { waitMs: 200, staleMs: 30000 }), 'ran');
});

test('a fresh lock held by a live process makes the caller wait, then fail with a retryable error', () => {
  const lockPath = path.join(tempDir('auspex-lock-busy-'), '.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'someone-else' }));
  const started = Date.now();
  assert.throws(() => withFileLock(lockPath, () => 'never', { waitMs: 150 }), err => err instanceof LockBusyError && err.retryable === true);
  assert.ok(Date.now() - started >= 150);
  assert.ok(fs.existsSync(lockPath), 'the other owner keeps its lock');
});

test('release never removes a lock that was taken over by someone else', () => {
  const lockPath = path.join(tempDir('auspex-lock-own-'), '.lock');
  withFileLock(lockPath, () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'new-owner' }));
  });
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'new-owner');
});

test('nested use is re-entrant and async functions are refused', () => {
  const lockPath = path.join(tempDir('auspex-lock-nest-'), '.lock');
  assert.equal(withFileLock(lockPath, () => withFileLock(lockPath, () => 'inner')), 'inner');
  assert.throws(() => withFileLock(lockPath, async () => 1), /synchronous/);
  assert.equal(fs.existsSync(lockPath), false);
});

test('existing library and memory files stay readable (no migration)', () => {
  const root = tempDir('auspex-lock-compat-');
  const ref = { db: 'local', schema: 's', category: 'c', name: 'old' };
  const lib = new Library(root);
  lib.saveDraft({ ref, sql: 'select 1' });
  assert.equal(lib.readMeta('draft', ref).sqlVersions.length, 1);
  assert.deepEqual(lib.list().map(i => i.name), ['old'], 'the lock file is not listed as a report');
});

test('a stale lock taken over by another process meanwhile is never removed (takeover race)', () => {
  const lockPath = path.join(tempDir('auspex-lock-race-'), '.lock');
  // L1: owned by a process that is gone, so every waiter judges it stale.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, host: os.hostname(), token: '1111111111111111' }));
  const live = JSON.stringify({ pid: process.ppid, host: os.hostname(), token: '2222222222222222' });
  // Just as this process starts its takeover, "process A" retires L1 and
  // takes a fresh lock L2. Simulated by hooking the first marker write.
  const original = fs.writeFileSync;
  let raced = false;
  fs.writeFileSync = function (file, ...rest) {
    if (!raced && String(file).includes('.takeover.')) {
      raced = true;
      fs.rmSync(lockPath);
      original.call(fs, lockPath, live, { flag: 'wx' });
    }
    return original.call(this, file, ...rest);
  };
  try {
    assert.throws(() => withFileLock(lockPath, () => 'both would hold it', { waitMs: 150 }), LockBusyError);
  } finally {
    fs.writeFileSync = original;
  }
  assert.ok(raced, 'the race was exercised');
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, '2222222222222222', "A's lock is intact");
});

test('a takeover marker left by a crashed taker does not block the lock', () => {
  const dir = tempDir('auspex-lock-marker-');
  const lockPath = path.join(dir, '.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, host: os.hostname(), token: '3333333333333333' }));
  fs.writeFileSync(`${lockPath}.takeover.3333333333333333`, JSON.stringify({ pid: 2 ** 30, host: os.hostname() }));
  assert.equal(withFileLock(lockPath, () => 'ran', { waitMs: 500 }), 'ran');
  assert.deepEqual(fs.readdirSync(dir), [], 'lock, marker and aside files are gone');
});

// Starts a child that prints "ready" once its first read of target succeeded.
function startReader(code) {
  const reader = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise((resolve, reject) => {
    reader.stdout.on('data', d => { if (String(d).includes('ready')) resolve(); });
    reader.on('exit', c => reject(new Error(`reader exited early (${c})`)));
  });
  return { reader, ready };
}

function seededReport() {
  const lib = new Library(tempDir('auspex-lock-reader-'));
  const ref = { db: 'local', schema: 's', category: 'c', name: 'r' };
  lib.saveDraft({ ref, sql: 'select 1' });
  // At least 1 KB, so a read takes long enough to collide with a rename.
  for (let i = 0; i < 10; i++) lib.appendRun('draft', ref, { at: new Date().toISOString(), n: -i, warnings: [], note: 'x'.repeat(100) }, null);
  return { lib, ref, target: lib.paths('draft', ref).meta };
}

test('a write waits for a reader that holds the file open (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { lib, ref, target } = seededReport();
  const { reader, ready } = startReader(`const fs=require('fs');const fd=fs.openSync(${JSON.stringify(target)},'r');console.log('ready');setTimeout(()=>fs.closeSync(fd),300)`);
  await ready;
  // Measured from "ready", not from the write: the reader closes the file 300 ms
  // after it said ready, so a write that lands needs at least ~300 ms from
  // there, even when this process is scheduled late on a busy machine.
  const readyAt = Date.now();
  lib.appendRun('draft', ref, { at: new Date().toISOString(), n: 'held', warnings: [] }, null);
  assert.ok(Date.now() - readyAt >= 200, 'the rename had to wait for the reader to close the file');
  assert.equal(lib.readMeta('draft', ref).runs.at(-1).n, 'held');
  reader.kill();
});

test('atomic writes keep landing next to a reader polling every millisecond (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { lib, ref, target } = seededReport();
  // Atomics.wait(1) wakes on the same Windows clock tick as the writer's
  // retries; this is the case that used to fail every time.
  const { reader, ready } = startReader(`const fs=require('fs');const b=new Int32Array(new SharedArrayBuffer(4));const end=Date.now()+8000;let first=true;while(Date.now()<end){try{fs.readFileSync(${JSON.stringify(target)});if(first){first=false;console.log('ready')}}catch{};Atomics.wait(b,0,0,1)}`);
  await ready;
  try {
    for (let i = 0; i < 200; i++) lib.appendRun('draft', ref, { at: new Date().toISOString(), n: i, warnings: [] }, null);
  } finally {
    reader.kill();
  }
  assert.equal(lib.readMeta('draft', ref).runs.at(-1).n, 199, 'every write landed');
});

test('a stale lock that cannot be removed ends in LockBusyError instead of spinning', () => {
  const dir = tempDir('auspex-lock-stuck-');
  const lockPath = path.join(dir, '.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, host: os.hostname(), token: '4444444444444444' }));
  // Every takeover attempt fails as if the file were held open (EPERM).
  const original = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, ...rest) => {
    if (String(from) === lockPath) { attempts++; throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); }
    return original.call(fs, from, ...rest);
  };
  const started = Date.now();
  try {
    assert.throws(() => withFileLock(lockPath, () => 'never', { waitMs: 200 }), LockBusyError);
  } finally {
    fs.renameSync = original;
  }
  assert.ok(attempts > 1, 'it retried');
  assert.ok(Date.now() - started < 2000, 'it gave up close to waitMs');
});
