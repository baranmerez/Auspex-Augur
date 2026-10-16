import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library, sqlHash } from '../src/reports/library.js';

// src/stageCli.js as the desktop app runs it: a child process with a
// temporary AUSPEX_HOME, one JSON line on stdout, exit code 1 on errors.
const cli = fileURLToPath(new URL('../src/stageCli.js', import.meta.url));
let home, lib;

const ref = { db: 'exampledb', schema: 'example', category: 'Example Reports', name: 'example-report' };
const sql = 'select order_id, status_code from example.orders';
const label = 'exampledb/example/Example Reports/example-report';

function run(args) {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json') };
  for (const k of ['AUSPEX_LIBRARY_DIR', 'AUSPEX_LOG_DIR', 'AUSPEX_MEMORY_DIR', 'AUSPEX_DATA_DIR']) delete env[k];
  const res = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `one JSON line: ${res.stdout}${res.stderr}`);
  return { status: res.status, out: JSON.parse(lines[0]) };
}
const refArgs = (r = ref) => ['--db', r.db, '--schema', r.schema, '--category', r.category, '--name', r.name];

function auditEntries() {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)).map(l => JSON.parse(l));
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-stage-cli-'));
  lib = new Library(path.join(home, 'library'));
  lib.saveDraft({ ref, title: 'Example report', sql });
  lib.appendRun('draft', ref, { at: '2026-10-01T08:00:00.000Z', sqlHash: sqlHash(sql), durationMs: 9, rows: 2, warnings: [] }, null);
});

after(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('invalid actions and arguments are refused and change nothing', () => {
  for (const args of [[], ['publish', ...refArgs()], ['APPROVE', ...refArgs()], ['__proto__', ...refArgs()]]) {
    const { status, out } = run(args);
    assert.equal(status, 1, JSON.stringify(args));
    assert.deepEqual([out.ok, out.code], [false, 'INVALID_INPUT'], JSON.stringify(args));
  }
  const bad = [
    refArgs().slice(0, 6),
    [...refArgs(), '--extra', 'x'],
    [...refArgs(), '--db', ref.db],
    [...refArgs().slice(0, 7)],
    refArgs({ ...ref, category: '..' }),
    refArgs({ ...ref, schema: '../../SELECT' }),
    refArgs({ ...ref, category: 'Example Reports/../..' }),
    refArgs({ ...ref, category: 'Example Reports\\..\\..' }),
    refArgs({ ...ref, name: '../example-report' }),
    refArgs({ ...ref, name: 'Example Report' }),
    refArgs({ ...ref, db: 'ExampleDB' }),
    refArgs({ ...ref, schema: ' example' }),
    refArgs({ ...ref, name: 'a'.repeat(201) }),
    refArgs({ ...ref, db: '' }),
    ['--db', ref.db, 'positional', '--schema', ref.schema, '--category', ref.category, '--name', ref.name],
  ];
  for (const args of bad) {
    const { status, out } = run(['approve', ...args]);
    assert.equal(status, 1, JSON.stringify(args));
    assert.deepEqual([out.ok, out.code], [false, 'INVALID_INPUT'], `${JSON.stringify(args)} -> ${out.message}`);
  }
  assert.equal(lib.exists('draft', ref), true);
  assert.equal(fs.existsSync(path.join(home, 'library', 'SELECT', 'exampledb')), false);
});

test('approve and revoke move the report, refuse the wrong stage and unknown reports, and are audited as desktop', () => {
  const before = auditEntries().length;
  const missing = run(['approve', ...refArgs({ ...ref, name: 'missing-report' })]);
  assert.deepEqual([missing.status, missing.out.code], [1, 'NOT_FOUND']);
  const early = run(['revoke', ...refArgs()]);
  assert.deepEqual([early.status, early.out.code], [1, 'PRECONDITION_FAILED'], 'a draft cannot be revoked');

  const ok = run(['approve', `--db=${ref.db}`, `--schema=${ref.schema}`, `--category=${ref.category}`, `--name=${ref.name}`]);
  assert.equal(ok.status, 0, JSON.stringify(ok.out));
  assert.deepEqual([ok.out.ok, ok.out.stage, ok.out.version, ok.out.report], [true, 'approved', 1, label]);
  assert.equal(lib.exists('approved', ref), true);
  assert.equal(lib.exists('draft', ref), false);
  assert.ok(fs.existsSync(lib.paths('approved', ref).html), 'the report HTML is regenerated');
  assert.deepEqual(lib.readMeta('approved', ref).stageHistory.map(h => [h.from, h.to, h.version, h.by]), [['draft', 'approved', 1, 'desktop']]);
  const graph = path.join(home, 'memory', 'exampledb', 'graph.json');
  assert.ok(fs.existsSync(graph), 'the schema memory view is rebuilt');
  assert.equal(run(['approve', ...refArgs()]).out.code, 'PRECONDITION_FAILED', 'already approved');

  const back = run(['revoke', ...refArgs()]);
  assert.equal(back.status, 0, JSON.stringify(back.out));
  assert.deepEqual([back.out.stage, back.out.version], ['draft', 1]);
  assert.equal(lib.exists('draft', ref), true);

  const entries = auditEntries().slice(before);
  assert.ok(entries.every(e => e.source === 'desktop' && e.actor === 'desktop' && /^[0-9a-f-]{36}$/.test(e.correlationId)));
  const done = entries.filter(e => !e.error);
  assert.deepEqual(done.map(e => [e.tool, e.profile, e.report, e.fromStage, e.toStage, e.version]), [
    ['approve_report', 'exampledb', label, 'draft', 'approved', 1],
    ['revoke_report', 'exampledb', label, 'approved', 'draft', 1],
  ]);
  assert.equal(done[0].correlationId, ok.out.correlationId);
  assert.deepEqual(entries.filter(e => e.error).map(e => [e.tool, e.errorCode]), [
    ['approve_report', 'NOT_FOUND'], ['revoke_report', 'PRECONDITION_FAILED'], ['approve_report', 'PRECONDITION_FAILED'],
  ]);
  assert.ok(!JSON.stringify(entries).includes('status_code from'), 'no SQL in the audit log');
});

test('a missing library folder is reported as not found and is not created', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-stage-cli-empty-'));
  const saved = home;
  home = empty;
  try {
    const { status, out } = run(['approve', ...refArgs()]);
    assert.deepEqual([status, out.code], [1, 'NOT_FOUND']);
    assert.equal(fs.existsSync(path.join(empty, 'library')), false);
  } finally {
    home = saved;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
