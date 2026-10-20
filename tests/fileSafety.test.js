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
import { fileURLToPath } from 'node:url';
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

// The audit day file names the audit log may use during this test: today in
// UTC and the day a few minutes later, so a UTC midnight rollover between
// planting the link and writing the entry is covered.
function auditDays() {
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  return [...new Set([day(Date.now()), day(Date.now() + 10 * 60000)])];
}

test('appends refuse a final path with a second hard link; audit and changelog stay best effort', t => {
  const dir = tempDir(t);
  const outside = path.join(dir, 'example-readable.txt');
  fs.writeFileSync(outside, keep);
  const stderr = captureStderr(t);

  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir);
  for (const day of auditDays()) fs.linkSync(outside, path.join(logDir, `${day}.jsonl`));
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
  const days = auditDays();
  for (const day of days) fs.symlinkSync(outside, path.join(logDir, `${day}.jsonl`));
  createAuditLog(logDir)({ tool: 'query', profile: 'exampledb', sql: 'select 1 from example.orders' });

  const memory = new SchemaMemory(path.join(dir, 'memory'));
  fs.mkdirSync(memory.profileDir('exampledb'), { recursive: true });
  fs.symlinkSync(missing, path.join(memory.profileDir('exampledb'), 'changelog.jsonl'));
  memory.appendChangelog('exampledb', { event: 'synthetic', table: 'example.orders' });

  assert.equal(fs.readFileSync(outside, 'utf8'), keep, 'outside file unchanged');
  assert.equal(modeOf(outside), 0o644, 'outside file mode unchanged');
  assert.equal(fs.existsSync(missing), false, 'dangling link target is not created');
  assert.throws(() => appendPrivate(path.join(logDir, `${days[0]}.jsonl`), 'x\n'), /refused .*symbolic link/);
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

// ---------- #108: linked folders below the roots ----------

function junction(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction'); // a directory symlink on POSIX
}

const exampleRef = { db: 'exampledb', schema: 'example', category: 'Reports', name: 'example-orders' };

test('the library refuses a linked category, nested category or stage folder and writes nothing outside', t => {
  const cases = [
    ['category', ['_drafts', 'exampledb', 'example', 'Reports'], exampleRef, lib => lib.saveDraft({ ref: exampleRef, sql: 'select order_id from example.orders' })],
    ['nested category', ['_drafts', 'exampledb', 'example', 'Orders', 'Delivery'], { ...exampleRef, category: 'Orders/Delivery' },
      lib => lib.saveDraft({ ref: { ...exampleRef, category: 'Orders/Delivery' }, sql: 'select order_id from example.orders' })],
    ['schema folder', ['SELECT', 'exampledb', 'example'], exampleRef, lib => lib.readSql('approved', exampleRef)],
    ['stage folder', ['EXECUTE'], exampleRef,
      lib => lib.saveExecuteScript({ ref: exampleRef, sql: 'BEGIN;\nUPDATE example.orders SET status_code = 1 WHERE order_id = 1;\nROLLBACK;' })],
  ];
  for (const [label, linkParts, , act] of cases) {
    const dir = tempDir(t);
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'example-orders.sql'), 'select 1 from example.orders\n');
    const before = fs.readdirSync(outside, { recursive: true }).sort();
    const lib = new Library(path.join(dir, 'library'));
    junction(outside, path.join(lib.root, ...linkParts));
    assert.throws(() => act(lib), /link or junction; refused/, label);
    assert.deepEqual(fs.readdirSync(outside, { recursive: true }).sort(), before, `${label}: nothing written outside`);
    assert.ok(Array.isArray(lib.list()), `${label}: listing still works`);
  }
});

test('a library root that is itself a link and normal nested categories keep working', t => {
  const dir = tempDir(t);
  const real = path.join(dir, 'real-library');
  fs.mkdirSync(real);
  junction(real, path.join(dir, 'library'));
  const lib = new Library(path.join(dir, 'library'));
  const ref = { ...exampleRef, category: 'Orders/Delivery/Daily' };
  lib.saveDraft({ ref, sql: 'select order_id from example.orders' });
  assert.equal(lib.readSql('draft', ref), 'select order_id from example.orders\n');
  assert.ok(fs.existsSync(path.join(real, '_drafts', 'exampledb', 'example', 'Orders', 'Delivery', 'Daily', 'example-orders.sql')));
  assert.deepEqual(lib.list().map(r => r.category), ['Orders/Delivery/Daily']);
});

test('the schema memory refuses linked profile, schema and legacy folders before reads and writes', t => {
  const record = (schema, table) => ({ schema, table, columns: [], constraints: [], indexes: [], referencedBy: [] });
  const legacySchema = 'example\u{1F600}'; // a name whose older file name differs
  const cases = [
    ['profile folder', ['exampledb'], m => m.writeTable('exampledb', record('example', 'orders'))],
    ['schema folder', ['exampledb', 'tables', 'example'], m => m.writeTable('exampledb', record('example', 'orders'))],
    ['schema folder read', ['exampledb', 'tables', 'example'], m => m.readTable('exampledb', 'example', 'orders')],
    ['notes', ['exampledb'], m => m.writeNotes('exampledb', { nextId: 1, notes: [] })],
    ['legacy schema folder', ['exampledb', 'tables', 'example~efbfbd~efbfbd'], m => m.readTable('exampledb', legacySchema, 'orders')],
  ];
  for (const [label, linkParts, act] of cases) {
    const dir = tempDir(t);
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'orders.json'), JSON.stringify(record(legacySchema, 'orders')));
    const before = fs.readdirSync(outside, { recursive: true }).sort();
    const memory = new SchemaMemory(path.join(dir, 'memory'));
    junction(outside, path.join(memory.root, ...linkParts));
    assert.throws(() => act(memory), /link or junction; refused/, label);
    assert.deepEqual(fs.readdirSync(outside, { recursive: true }).sort(), before, `${label}: nothing written outside`);
  }
  assert.notEqual(fileSegment(legacySchema), 'example~efbfbd~efbfbd', 'the legacy case uses a different folder');
});

test('a schema-memory root that is itself a link keeps working', t => {
  const dir = tempDir(t);
  const real = path.join(dir, 'real-memory');
  fs.mkdirSync(real);
  junction(real, path.join(dir, 'memory'));
  const memory = new SchemaMemory(path.join(dir, 'memory'));
  memory.writeTable('exampledb', { schema: 'example', table: 'orders', columns: [], constraints: [], indexes: [], referencedBy: [] });
  assert.equal(memory.readTable('exampledb', 'example', 'orders').table, 'orders');
  assert.ok(fs.existsSync(path.join(real, 'exampledb', 'tables', 'example', 'orders.json')));
});

// ---------- review follow-ups: one linked file never breaks the rest ----------

const describeOrders = () => ({
  profile: 'exampledb', relation: 'example.orders', schema: 'example', table: 'orders', kind: 'table', oid: 1001, estimated_rows: 10, comment: null,
  columns: [{ column: 'order_id', attnum: 1, type: 'integer', not_null: true, default: null, comment: null }],
  constraints: [], indexes: [], referencedBy: [],
});

// A directory junction (a directory symlink on POSIX) or a hard link at the
// changelog path: memory writes still succeed and the view is rebuilt.
for (const kind of ['junction', 'hard link']) {
  test(`a ${kind} at changelog.jsonl does not fail describe or remember`, t => {
    const dir = tempDir(t);
    const stderr = captureStderr(t);
    const outsideDir = path.join(dir, 'outside');
    fs.mkdirSync(outsideDir);
    const outside = path.join(dir, 'example-readable.txt');
    fs.writeFileSync(outside, keep);
    const memory = new SchemaMemory(path.join(dir, 'memory'));
    fs.mkdirSync(memory.profileDir('exampledb'), { recursive: true });
    const changelog = path.join(memory.profileDir('exampledb'), 'changelog.jsonl');
    if (kind === 'junction') junction(outsideDir, changelog);
    else fs.linkSync(outside, changelog);

    assert.doesNotThrow(() => memory.recordDescribe(describeOrders()));
    const note = memory.addNote('exampledb', { kind: 'rule', schema: 'example', table: 'orders', column: 'order_id', text: 'Synthetic example rule.' });
    assert.ok(note, 'the note is stored and reported');
    assert.equal(memory.readNotes('exampledb').notes.length, 1, 'exactly one note, no retry duplicate');
    assert.ok(fs.existsSync(path.join(memory.profileDir('exampledb'), 'graph.json')), 'the view is rebuilt');
    assert.equal(fs.readFileSync(outside, 'utf8'), keep);
    assert.deepEqual(fs.readdirSync(outsideDir), []);
    assert.ok(stderr.some(line => /changelog/.test(line)), 'the refusal is reported on stderr');
  });
}

test('a linked table file is skipped in the memory view and later writes still work', t => {
  const dir = tempDir(t);
  const stderr = captureStderr(t);
  const memory = new SchemaMemory(path.join(dir, 'memory'));
  memory.recordDescribe(describeOrders());
  const outsideDir = path.join(dir, 'outside');
  fs.mkdirSync(outsideDir);
  junction(outsideDir, path.join(memory.profileDir('exampledb'), 'tables', 'example', 'customers.json'));

  assert.deepEqual(memory.listTables('exampledb').map(x => x.table), ['orders']);
  assert.doesNotThrow(() => memory.recordDescribe({ ...describeOrders(), estimated_rows: 20 }));
  assert.ok(stderr.some(line => /table skipped: .*customers\.json/.test(line)));
});

test('a linked report file is skipped in the library list; the rest is listed', t => {
  const dir = tempDir(t);
  const stderr = captureStderr(t);
  const lib = new Library(path.join(dir, 'library'));
  const good = { ...exampleRef, name: 'example-good' };
  const bad = { ...exampleRef, name: 'example-linked' };
  lib.saveDraft({ ref: good, sql: 'select order_id from example.orders' });
  lib.saveDraft({ ref: bad, sql: 'select order_id from example.orders' });
  const outsideDir = path.join(dir, 'outside');
  fs.mkdirSync(outsideDir);
  const meta = lib.paths('draft', bad).meta;
  fs.rmSync(meta);
  junction(outsideDir, meta);

  assert.deepEqual(lib.list().map(r => r.name), ['example-good']);
  assert.ok(stderr.some(line => /report skipped in the list/.test(line)));
});

test('save_report refuses a linked SELECT folder before writing the script-root file', t => {
  const dir = tempDir(t);
  const scripts = path.join(dir, 'example-scripts');
  fs.mkdirSync(scripts);
  const outsideDir = path.join(dir, 'outside');
  fs.mkdirSync(outsideDir);
  const lib = new Library(path.join(dir, 'library'));
  junction(outsideDir, path.join(lib.root, 'SELECT', 'exampledb', 'example', 'Reports'));
  const target = { root: 'scripts', dir: scripts, folder: 'example', fileName: '01_example_report.sql' };
  assert.throws(() => lib.saveDraft({ ref: exampleRef, sql: 'select order_id from example.orders', target }), /link or junction; refused/);
  assert.deepEqual(fs.readdirSync(scripts, { recursive: true }), [], 'no script-root file is left behind');
  assert.deepEqual(fs.readdirSync(outsideDir), []);
});

// A file symlink on POSIX; on Windows (no symlink privilege) a directory
// junction at the file name, which lstat also reports as a link.
test('the viewer refuses an EXECUTE script whose file is a link', async t => {
  const { spawn } = await import('node:child_process');
  const http = await import('node:http');
  const net = await import('node:net');
  const home = tempDir(t);
  const outside = path.join(home, 'example-secret.txt');
  fs.writeFileSync(outside, 'example confidential data\n');
  const lib = new Library(path.join(home, 'library'));
  const file = `${lib.base('execute', exampleRef)}.sql`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === 'win32') {
    const outsideDir = path.join(home, 'outside');
    fs.mkdirSync(outsideDir);
    junction(outsideDir, file);
  } else {
    fs.symlinkSync(outside, file);
  }

  const port = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_VIEWER_PORT: String(port), AUSPEX_PROFILES_FILE: path.join(home, 'none.json'),
    AUSPEX_LIBRARY_DIR: lib.root, AUSPEX_LOG_DIR: path.join(home, 'logs'), AUSPEX_MEMORY_DIR: path.join(home, 'memory') };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/viewer.js', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes('Auspex viewer:')) resolve(); });
    child.once('exit', code => reject(new Error(`viewer exited with ${code}`)));
  });
  const get = (route, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { host: `127.0.0.1:${port}`, ...headers } }, r => {
      let text = '';
      r.on('data', c => { text += c; });
      r.on('end', () => resolve({ status: r.statusCode, text }));
    }).on('error', reject);
  });
  // Read routes need the per-process token from the page (as the page sends it).
  const token = (await get('/')).text.match(/<meta name="auspex-token" content="([0-9a-f]{64})">/)?.[1];
  assert.ok(token, 'token embedded in the page');
  const report = ref => get(`/api/report?${new URLSearchParams({ stage: 'execute', ...ref })}`, { 'x-auspex-token': token });

  const res = await report(exampleRef);
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.text).error, /^Library path .*example-orders\.sql is a link or junction; refused\.$/);
  assert.doesNotMatch(res.text, /example confidential data/);

  // Control: a normal EXECUTE file next to it is served.
  const normalRef = { ...exampleRef, name: 'example-normal' };
  fs.writeFileSync(`${lib.base('execute', normalRef)}.sql`, 'BEGIN;\nROLLBACK;\n');
  const normal = await report(normalRef);
  assert.equal(normal.status, 200);
  assert.deepEqual(JSON.parse(normal.text), { kind: 'sql', content: 'BEGIN;\nROLLBACK;\n' });
});
