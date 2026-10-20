import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePrivateDir, appendPrivate, writePrivateAtomic, copyPrivate } from '../src/privateFiles.js';
import { createAuditLog } from '../src/auditLog.js';
import { ReadOnlyDatabase } from '../src/db.js';
import { Library, sqlHash } from '../src/reports/library.js';
import { ReportService } from '../src/reports/service.js';
import { recordResult, appendTrend, trendFile, readTrend } from '../src/schedule/store.js';
import { SchemaMemory } from '../src/memory/store.js';

const posixOnly = { skip: process.platform === 'win32' };
const modeOf = file => fs.statSync(file).mode & 0o777;
const isPrivate = file => (fs.statSync(file).mode & 0o077) === 0;

// A temporary HOME, so os.homedir() and the default ~/.auspex tree point into
// it; umask 022 makes files created without an explicit mode world-readable.
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'example-private-home-'));
  const oldHome = process.env.HOME;
  const oldUmask = process.umask(0o022);
  process.env.HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    process.umask(oldUmask);
    fs.rmSync(home, { recursive: true, force: true });
  });
  const tree = path.join(home, '.auspex');
  fs.mkdirSync(tree, { mode: 0o700 });
  return { home, tree };
}

// Replaces fs.fchmodSync for one test so every tightening fails like on a
// shared or mounted volume; collects stderr notes.
function failingChmod(t) {
  const original = fs.fchmodSync;
  const originalWrite = process.stderr.write;
  const notes = [];
  fs.fchmodSync = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
  process.stderr.write = text => { notes.push(String(text)); return true; };
  t.after(() => {
    fs.fchmodSync = original;
    process.stderr.write = originalWrite;
  });
  return notes;
}

test('private writes work on every platform', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'example-private-any-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nested = path.join(dir, 'example', 'reports');
  ensurePrivateDir(nested);
  ensurePrivateDir(nested); // an existing folder is fine
  appendPrivate(path.join(nested, 'example.jsonl'), 'one\n');
  appendPrivate(path.join(nested, 'example.jsonl'), 'two\n');
  writePrivateAtomic(path.join(nested, 'example.sql'), 'select 1 from example.orders\n');
  copyPrivate(path.join(nested, 'example.sql'), path.join(dir, 'copy', 'example.sql'));
  assert.equal(fs.readFileSync(path.join(nested, 'example.jsonl'), 'utf8'), 'one\ntwo\n');
  assert.equal(fs.readFileSync(path.join(dir, 'copy', 'example.sql'), 'utf8'), 'select 1 from example.orders\n');
  assert.deepEqual(fs.readdirSync(nested).sort(), ['example.jsonl', 'example.sql']);
});

test('audit files and directories are owner-only; older ones inside ~/.auspex are tightened', posixOnly, t => {
  const { tree } = tempHome(t);
  const logDir = path.join(tree, 'logs');
  const audit = createAuditLog(logDir);
  audit({ tool: 'query', profile: 'exampledb', sql: 'select * from example.orders where order_id = $1', params: ['exampleOnly'] });
  const [fileName] = fs.readdirSync(logDir);
  const file = path.join(logDir, fileName);
  assert.equal(modeOf(logDir), 0o700, 'directory must not be traversable by other users');
  assert.equal(modeOf(file), 0o600, 'SQL and params must not be readable by other users');

  // Files and folders from an older version may have been created under umask 022.
  fs.chmodSync(file, 0o644);
  fs.chmodSync(logDir, 0o755);
  fs.chmodSync(tree, 0o755);
  audit({ tool: 'query', profile: 'exampledb', sql: 'select 1 from example.orders' });
  assert.equal(modeOf(tree), 0o700);
  assert.equal(modeOf(logDir), 0o700);
  assert.equal(modeOf(file), 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('CSV exports containing row values are owner-private', posixOnly, async t => {
  const { tree } = tempHome(t);
  const exportDir = path.join(tree, 'exports');
  const db = new ReadOnlyDatabase({
    profiles: new Map([['exampledb', 'postgresql://report_reader@db.example.test:5432/exampledb']]),
    exportDir, exportMaxRows: 10, exportMaxBytes: 100000, exportMaxMs: 5000,
  }, { audit: () => {} });
  // Never connects to a database: the cursor and FETCH are test doubles.
  db.withReadOnly = async (profile, fn) => {
    assert.equal(profile, 'exampledb');
    return fn({
      async query(query) {
        const statement = typeof query === 'string' ? query : query.text;
        if (statement.startsWith('DECLARE')) return { rows: [] };
        if (statement.startsWith('FETCH')) {
          return { fields: [{ name: 'private_note', dataTypeID: 25 }], rows: [['exampleconfidential']] };
        }
        throw new Error('Unexpected query in fake cursor');
      },
    }, 'exampledb');
  };
  const exportOnce = () => db.exportCsv('exampledb', 'select private_note from example.orders', [], 'exampleOrders', ',');
  const first = await exportOnce();
  assert.equal(first.rowCount, 1);
  assert.match(fs.readFileSync(first.file, 'utf8'), /exampleconfidential/);
  assert.equal(modeOf(exportDir), 0o700, 'others must not traverse the export directory');
  assert.equal(modeOf(first.file), 0o600, 'others must not read exported table data');

  // A directory created by an older Auspex version inside ~/.auspex is secured too.
  fs.chmodSync(exportDir, 0o755);
  const second = await exportOnce();
  assert.equal(modeOf(exportDir), 0o700);
  assert.equal(modeOf(second.file), 0o600);
  assert.notEqual(second.file, first.file);
});

test('shared report copies hold preview rows and are owner-private', posixOnly, async t => {
  const { tree } = tempHome(t);
  const fake = {
    resolveProfile: name => String(name).toLowerCase(),
    async runReport(profile) {
      return { profile, serverVersion: '16.0', analyzed: false, plan: null, previewMs: 1, previewExecuted: true,
        columns: [{ name: 'private_note', type: 'text' }], rows: [['exampleconfidential']], rowCount: 1, truncated: false };
    },
  };
  const svc = new ReportService(fake, path.join(tree, 'library'));
  const reportRef = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'shared-notes' };
  svc.save({ ...reportRef, title: 'Example share', sql: 'select private_note from example.orders' });
  await svc.run(reportRef);
  const exportDir = path.join(tree, 'exports'); // not created yet: share_report may come before any CSV export
  const shared = svc.share(reportRef, exportDir);
  assert.equal(modeOf(exportDir), 0o700, 'others must not traverse the export directory');
  assert.equal(modeOf(shared.file), 0o600, 'others must not read the shared preview rows');
});

test('private report SQL, metadata and HTML are owner-only, approved copies included', posixOnly, t => {
  const { tree } = tempHome(t);
  const library = new Library(path.join(tree, 'library'));
  const reportRef = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'private-notes' };
  const sql = 'select private_note from example.orders';
  library.saveDraft({ ref: reportRef, sql });
  library.writeHtml('draft', reportRef, 'exampleconfidential');
  const draft = library.paths('draft', reportRef);
  assert.equal(modeOf(library.root), 0o700, 'other accounts cannot traverse private report storage');
  for (const file of Object.values(draft)) assert.ok(isPrivate(file), `private report file: ${file}`);

  // Tighten an older permissive library directory when writing a report.
  fs.chmodSync(library.root, 0o755);
  library.saveDraft({ ref: reportRef, sql });
  assert.equal(modeOf(library.root), 0o700);

  // Approval copies the SQL and HTML; the copies are private even when the
  // drafts were left readable by an older version.
  library.appendRun('draft', reportRef, { at: '2026-10-20T00:00:00Z', sqlHash: sqlHash(sql), warnings: [] }, null);
  fs.chmodSync(draft.sql, 0o644);
  fs.chmodSync(draft.html, 0o644);
  library.approve(reportRef);
  const approved = library.paths('approved', reportRef);
  for (const file of Object.values(approved)) assert.equal(modeOf(file), 0o600, `approved private report file: ${file}`);
  assert.equal(fs.readFileSync(approved.html, 'utf8'), 'exampleconfidential');

  fs.chmodSync(approved.sql, 0o644);
  library.revoke(reportRef);
  for (const file of Object.values(library.paths('draft', reportRef))) assert.equal(modeOf(file), 0o600, `revoked private report file: ${file}`);
});

test('scheduled result and trend files keep preset parameters owner-private', posixOnly, t => {
  const { tree } = tempHome(t);
  const statePath = path.join(tree, 'schedule-state.json');
  const trendsRoot = path.join(tree, 'trends');
  const reportRef = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'weekly-report' };
  const trend = { v: 1, scheduleId: 'exampleSchedule', slot: '2026-10-20', params: ['exampleCustomerId'], rows: 1 };
  recordResult(statePath, trend.scheduleId, { status: 'ok', slot: trend.slot, at: '2026-10-20T00:00:00Z' });
  appendTrend(trendsRoot, reportRef, trend);

  const trendPath = trendFile(trendsRoot, reportRef);
  assert.equal(modeOf(statePath), 0o600, 'state file must not be readable by others');
  assert.equal(modeOf(trendPath), 0o600, 'trend parameters must not be readable by others');
  assert.equal(modeOf(path.dirname(trendPath)), 0o700, 'trend directory must not be traversable by others');
  assert.deepEqual(readTrend(trendPath)[0].params, ['exampleCustomerId']);

  // Older files written with umask-controlled permissions are replaced or tightened.
  fs.chmodSync(statePath, 0o644);
  fs.chmodSync(trendPath, 0o644);
  fs.chmodSync(path.dirname(trendPath), 0o755);
  recordResult(statePath, trend.scheduleId, { status: 'ok', slot: '2026-10-21', at: '2026-10-21T00:00:00Z' });
  appendTrend(trendsRoot, reportRef, { ...trend, slot: '2026-10-21' });
  assert.equal(modeOf(statePath), 0o600);
  assert.equal(modeOf(trendPath), 0o600);
  assert.equal(modeOf(path.dirname(trendPath)), 0o700);
  assert.equal(readTrend(trendPath).length, 2);
});

test('schema memory files and parent directories stay private', posixOnly, t => {
  const { tree } = tempHome(t);
  const root = path.join(tree, 'memory');
  const memory = new SchemaMemory(root);
  const tableFile = memory.tablePath('exampledb', 'example', 'orders');
  const notesFile = path.join(memory.profileDir('exampledb'), 'notes.json');
  const logFile = path.join(memory.profileDir('exampledb'), 'changelog.jsonl');
  const dirs = [root, memory.profileDir('exampledb'), path.join(memory.profileDir('exampledb'), 'tables'), path.dirname(tableFile)];

  memory.writeJson(tableFile, { schema: 'example', table: 'orders', description: 'synthetic' });
  memory.writeNotes('exampledb', { nextId: 1, notes: [] });
  memory.appendChangelog('exampledb', { event: 'synthetic', table: 'example.orders' });
  for (const dir of dirs) assert.equal(modeOf(dir), 0o700, `private directory: ${dir}`);
  for (const file of [tableFile, notesFile, logFile]) assert.equal(modeOf(file), 0o600, `private file: ${file}`);

  // A later write repairs older permissive memory folders and files.
  for (const dir of dirs) fs.chmodSync(dir, 0o755);
  fs.chmodSync(tableFile, 0o644);
  fs.chmodSync(logFile, 0o644);
  memory.writeJson(tableFile, { schema: 'example', table: 'orders', description: 'updated' });
  memory.appendChangelog('exampledb', { event: 'updated' });
  for (const dir of dirs) assert.equal(modeOf(dir), 0o700, `repaired directory: ${dir}`);
  assert.equal(modeOf(tableFile), 0o600);
  assert.equal(modeOf(logFile), 0o600);
  assert.deepEqual(memory.readChangelog('exampledb').map(item => item.event), ['synthetic', 'updated']);
});

test('a failed chmod never fails the write; the audit entry is kept', posixOnly, t => {
  const { tree } = tempHome(t);
  const logDir = path.join(tree, 'logs');
  fs.mkdirSync(logDir, { mode: 0o755 });
  fs.chmodSync(logDir, 0o755);
  const notes = failingChmod(t);
  const audit = createAuditLog(logDir);
  audit({ tool: 'query', profile: 'exampledb', sql: 'select 1 from example.orders' });
  audit({ tool: 'query', profile: 'exampledb', sql: 'select 2 from example.orders' });
  const [fileName] = fs.readdirSync(logDir);
  assert.equal(fs.readFileSync(path.join(logDir, fileName), 'utf8').trim().split('\n').length, 2, 'both audit entries are written');
  assert.equal(modeOf(logDir), 0o755);
  assert.ok(!notes.some(n => n.includes('audit log write failed')), 'the audit write itself did not fail');
  assert.equal(notes.filter(n => n.includes(`${path.sep}logs (EPERM)`)).length, 1, 'at most one note per path');

  writePrivateAtomic(path.join(logDir, 'example.json'), '{}\n');
  ensurePrivateDir(logDir);
  assert.equal(fs.readFileSync(path.join(logDir, 'example.json'), 'utf8'), '{}\n');
});

test('a configured folder outside ~/.auspex keeps its mode; new files in it are private', posixOnly, t => {
  const { home } = tempHome(t);
  const custom = path.join(home, 'example', 'logs'); // e.g. AUSPEX_LOG_DIR or a custom AUSPEX_HOME
  fs.mkdirSync(custom, { recursive: true });
  fs.chmodSync(custom, 0o755);
  const existing = path.join(custom, 'existing.jsonl');
  fs.writeFileSync(existing, 'old\n', { mode: 0o644 });

  ensurePrivateDir(custom);
  appendPrivate(existing, 'new\n');
  appendPrivate(path.join(custom, 'fresh.jsonl'), 'new\n');
  writePrivateAtomic(path.join(custom, 'fresh.json'), '{}\n');
  createAuditLog(custom)({ tool: 'query', profile: 'exampledb' });

  assert.equal(modeOf(custom), 0o755, 'configured folder is not narrowed');
  assert.equal(modeOf(existing), 0o644, 'existing file outside ~/.auspex is not changed');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'old\nnew\n');
  assert.equal(modeOf(path.join(custom, 'fresh.jsonl')), 0o600);
  assert.equal(modeOf(path.join(custom, 'fresh.json')), 0o600);
  const day = fs.readdirSync(custom).find(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  assert.equal(modeOf(path.join(custom, day)), 0o600);

  // New folders Auspex creates there (the lock folder comes first) are 0700.
  const library = new Library(path.join(home, 'example', 'library'));
  library.saveDraft({ ref: { db: 'exampledb', schema: 'example', category: 'Orders', name: 'custom' }, sql: 'select order_id from example.orders' });
  assert.equal(modeOf(library.root), 0o700);
  assert.equal(modeOf(path.join(home, 'example')), 0o755, 'an existing parent folder is not changed');
});

test('a link inside ~/.auspex that points outside is not followed for tightening', posixOnly, t => {
  const { home, tree } = tempHome(t);
  const outside = path.join(home, 'example-shared');
  fs.mkdirSync(outside);
  fs.chmodSync(outside, 0o755);
  const existing = path.join(outside, 'existing.jsonl');
  fs.writeFileSync(existing, 'old\n', { mode: 0o644 });
  fs.symlinkSync(outside, path.join(tree, 'logs'), 'dir');

  ensurePrivateDir(path.join(tree, 'logs'));
  appendPrivate(path.join(tree, 'logs', 'existing.jsonl'), 'new\n');
  appendPrivate(path.join(tree, 'logs', 'fresh.jsonl'), 'new\n');

  assert.equal(modeOf(outside), 0o755, 'link target folder is not narrowed');
  assert.equal(modeOf(existing), 0o644, 'link target file is not changed');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'old\nnew\n');
  assert.equal(modeOf(path.join(outside, 'fresh.jsonl')), 0o600, 'new files are still created private');
});
