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
