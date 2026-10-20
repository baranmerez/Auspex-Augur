// Local file safety: planted temp names (#103), linked append targets (#109),
// private script-root files (#110) and linked folders below the library and
// schema-memory roots (#108). Hard links and directory junctions need no
// privilege on Windows, so those cases run everywhere; file symlinks and mode
// bits are POSIX only. Synthetic data only; no database is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePrivateAtomic, copyPrivate, appendPrivate } from '../src/privateFiles.js';
import { createAuditLog } from '../src/auditLog.js';
import { Library } from '../src/reports/library.js';
import { SchemaMemory, fileSegment } from '../src/memory/store.js';

const posixOnly = { skip: process.platform === 'win32' };
const modeOf = file => fs.statSync(file).mode & 0o777;
const keep = 'keep example content\n';
const fixedHex = 'ab'.repeat(8);

function tempDir(t, prefix = 'example-safety-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function permissiveUmask(t) {
  const old = process.umask(0o022);
  t.after(() => process.umask(old));
}

// Collects stderr for one test.
function captureStderr(t) {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = text => { lines.push(String(text)); return true; };
  t.after(() => { process.stderr.write = original; });
  return lines;
}

// Pins the clock and the next random temp suffix, so every temp name the
// writers ever used (pid + time, pid only, random) is known in advance. Call
// once per test; each call of the returned function re-arms the suffix.
function pinTempNames(t) {
  const now = Date.now;
  const randomBytes = crypto.randomBytes;
  const fixed = 1700000000000;
  let first = true;
  Date.now = () => fixed;
  crypto.randomBytes = (size, ...rest) => {
    if (first && size === 8) { first = false; return Buffer.from(fixedHex, 'hex'); }
    return randomBytes(size, ...rest);
  };
  t.after(() => { Date.now = now; crypto.randomBytes = randomBytes; });
  return file => {
    first = true;
    return [`${file}.${process.pid}.${fixed}.tmp`, `${file}.${process.pid}.tmp`, `${file}.${fixedHex}.tmp`];
  };
}

// ---------- #103: temp files ----------

const atomicWriters = [
  ['writePrivateAtomic', (dir, out) => writePrivateAtomic(out, 'example confidential data\n')],
  ['copyPrivate', (dir, out) => {
    const source = path.join(dir, 'example-source.sql');
    fs.writeFileSync(source, 'example confidential data\n');
    copyPrivate(source, out);
  }],
  ['schema memory writeJson', (dir, out) => new SchemaMemory(dir).writeJson(out, { note: 'example confidential data' })],
];

for (const [label, write] of atomicWriters) {
  test(`${label} never writes through a hard link planted at a temp name`, t => {
    const dir = tempDir(t);
    const out = path.join(dir, 'example.report.json');
    const unrelated = path.join(dir, 'example-unrelated.txt');
    fs.writeFileSync(unrelated, keep);
    const names = pinTempNames(t)(out);
    for (const name of names) fs.linkSync(unrelated, name);

    write(dir, out);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), keep, 'unrelated file is untouched');
    assert.match(fs.readFileSync(out, 'utf8'), /example confidential data/);
    for (const name of names) assert.ok(fs.existsSync(name), `planted entry is left alone: ${path.basename(name)}`);
    assert.equal(fs.statSync(out).nlink, 1, 'the result is a new file, not the planted inode');
    const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).map(f => path.join(dir, f));
    assert.deepEqual(leftovers.sort(), [...names].sort(), 'no temp file of this call is left behind');
  });
}

test('atomic writes skip a planted symlink, a dangling symlink and a stale 0644 temp file', posixOnly, t => {
  permissiveUmask(t);
  const tempNames = pinTempNames(t);
  for (const plant of ['symlink', 'dangling', 'stale']) {
    const dir = tempDir(t);
    const out = path.join(dir, 'example.sql');
    const unrelated = path.join(dir, 'example-unrelated.txt');
    fs.writeFileSync(unrelated, keep, { mode: 0o644 });
    const missing = path.join(dir, 'example-missing.txt');
    const names = tempNames(out);
    for (const name of names) {
      if (plant === 'symlink') fs.symlinkSync(unrelated, name);
      else if (plant === 'dangling') fs.symlinkSync(missing, name);
      else fs.writeFileSync(name, 'stale\n', { mode: 0o644 });
    }
    writePrivateAtomic(out, 'select order_id from example.orders\n');
    new SchemaMemory(dir).writeJson(path.join(dir, 'example.json'), { ok: true });
    assert.equal(fs.readFileSync(unrelated, 'utf8'), keep, plant);
    assert.equal(fs.existsSync(missing), false, `${plant}: a dangling link target is not created`);
    assert.ok(fs.lstatSync(out).isFile(), `${plant}: the result is a regular file`);
    assert.equal(modeOf(out), 0o600, `${plant}: the result is owner-only`);
    assert.equal(modeOf(path.join(dir, 'example.json')), 0o600);
    for (const name of names) assert.ok(fs.lstatSync(name), `${plant}: planted entry is left alone`);
  }
});

// ---------- #109: append targets ----------

test('appends refuse a final path with a second hard link; audit and changelog stay best effort', t => {
  const dir = tempDir(t);
  const outside = path.join(dir, 'example-readable.txt');
  fs.writeFileSync(outside, keep);
  const stderr = captureStderr(t);

  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir);
  const day = new Date().toISOString().slice(0, 10);
  fs.linkSync(outside, path.join(logDir, `${day}.jsonl`));
  const audit = createAuditLog(logDir);
  assert.doesNotThrow(() => audit({ tool: 'query', profile: 'exampledb', sql: 'select 1 from example.orders' }));

  const memory = new SchemaMemory(path.join(dir, 'memory'));
  fs.mkdirSync(memory.profileDir('exampledb'), { recursive: true });
  fs.linkSync(outside, path.join(memory.profileDir('exampledb'), 'changelog.jsonl'));
  assert.doesNotThrow(() => memory.appendChangelog('exampledb', { event: 'synthetic', table: 'example.orders' }));

  assert.equal(fs.readFileSync(outside, 'utf8'), keep, 'nothing is appended through the hard link');
  assert.equal(stderr.filter(line => /audit log write failed: refused .*hard link/.test(line)).length, 1);
  assert.equal(stderr.filter(line => /changelog write failed: refused .*hard link/.test(line)).length, 1);
  assert.ok(stderr.every(line => line.length < 600), 'stderr notes stay short');

  // A new log and an existing log with one link work as before.
  const fresh = path.join(dir, 'fresh', 'example.jsonl');
  appendPrivate(fresh, 'one\n');
  appendPrivate(fresh, 'two\n');
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'one\ntwo\n');
});

test('appends refuse a final symlink, also a dangling one, in the audit log and the changelog', posixOnly, t => {
  permissiveUmask(t);
  const dir = tempDir(t);
  const outside = path.join(dir, 'example-readable.txt');
  fs.writeFileSync(outside, keep, { mode: 0o644 });
  const missing = path.join(dir, 'example-missing.txt');
  const stderr = captureStderr(t);

  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir);
  const day = new Date().toISOString().slice(0, 10);
  fs.symlinkSync(outside, path.join(logDir, `${day}.jsonl`));
  createAuditLog(logDir)({ tool: 'query', profile: 'exampledb', sql: 'select 1 from example.orders' });

  const memory = new SchemaMemory(path.join(dir, 'memory'));
  fs.mkdirSync(memory.profileDir('exampledb'), { recursive: true });
  fs.symlinkSync(missing, path.join(memory.profileDir('exampledb'), 'changelog.jsonl'));
  memory.appendChangelog('exampledb', { event: 'synthetic', table: 'example.orders' });

  assert.equal(fs.readFileSync(outside, 'utf8'), keep, 'outside file unchanged');
  assert.equal(modeOf(outside), 0o644, 'outside file mode unchanged');
  assert.equal(fs.existsSync(missing), false, 'dangling link target is not created');
  assert.throws(() => appendPrivate(path.join(logDir, `${day}.jsonl`), 'x\n'), /refused .*symbolic link/);
  assert.equal(stderr.filter(line => /write failed: refused/.test(line)).length, 2);

  const fresh = path.join(logDir, 'fresh.jsonl');
  appendPrivate(fresh, 'one\n');
  assert.equal(modeOf(fresh), 0o600, 'a new log file is owner-only');
});

// ---------- #110: script-root files ----------

test('script-root copies of save_report and save_execute_script are created 0600', posixOnly, t => {
  permissiveUmask(t);
  const dir = tempDir(t);
  const scripts = path.join(dir, 'example-scripts');
  fs.mkdirSync(scripts);
  fs.chmodSync(scripts, 0o755);
  const lib = new Library(path.join(dir, 'library'));
  const ref = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'example-orders' };
  const target = fileName => ({ root: 'scripts', dir: scripts, folder: 'example', fileName });

  const report = lib.saveDraft({ ref, sql: 'select order_id from example.orders', target: target('01_example_report.sql') });
  const change = lib.saveExecuteScript({
    ref: { ...ref, name: 'example-change' },
    sql: 'BEGIN;\nUPDATE example.orders SET status_code = 1 WHERE order_id = 1;\nROLLBACK;',
    target: target('02_example_change.sql'),
  });
  assert.equal(modeOf(report.externalFile), 0o600, 'report SQL copy is owner-only');
  assert.equal(modeOf(change.externalFile), 0o600, 'change script copy is owner-only');
  assert.equal(modeOf(scripts), 0o755, 'the configured script root keeps its mode');
  assert.throws(() => lib.saveDraft({ ref, sql: 'select 1', target: target('01_example_report.sql') }), /already exists/);
});
