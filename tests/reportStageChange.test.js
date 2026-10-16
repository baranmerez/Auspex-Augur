import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, sqlHash } from '../src/reports/library.js';
import { approveInLibrary, revokeInLibrary } from '../src/reports/service.js';

// Approve and revoke in the library, as the viewer and approve_report use them.
const ref = { db: 'exampledb', schema: 'example', category: 'Example Reports', name: 'example-report' };
const sql = 'select order_id, customer_id, status_code from example.orders';

function draftWithRun() {
  const lib = new Library(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-stage-')));
  lib.saveDraft({ ref, title: 'Example report', sql });
  lib.appendRun('draft', ref, { at: '2026-10-01T08:00:00.000Z', sqlHash: sqlHash(sql), durationMs: 12, rows: 3, warnings: [] }, null);
  return lib;
}

test('approve then revoke moves the files between stages and keeps versions and runs', () => {
  const lib = draftWithRun();
  const approved = approveInLibrary(lib, ref, { by: 'viewer' });
  assert.equal(approved.meta.approvedVersion, 1);
  assert.equal(lib.exists('draft', ref), false);
  assert.ok(fs.existsSync(lib.paths('approved', ref).html), 'approved HTML is regenerated');

  const revoked = revokeInLibrary(lib, ref, { by: 'viewer' });
  assert.equal(revoked.stage, 'draft');
  assert.equal(revoked.version, 1);
  assert.equal(lib.exists('approved', ref), false);
  assert.equal(lib.exists('draft', ref), true);
  assert.ok(fs.existsSync(lib.paths('draft', ref).html), 'draft HTML is regenerated');
  assert.equal(fs.existsSync(path.join(lib.root, 'SELECT', 'exampledb')), false, 'empty SELECT folders are pruned');

  const meta = lib.readMeta('draft', ref);
  assert.equal(meta.status, 'draft');
  assert.equal(meta.approvedVersion, undefined);
  assert.equal(meta.approvedAt, undefined);
  assert.equal(meta.revokedVersion, 1);
  assert.equal(meta.sqlVersions.length, 1);
  assert.equal(meta.runs.length, 1);
  assert.deepEqual(meta.stageHistory.map(h => [h.from, h.to, h.version, h.by]), [['draft', 'approved', 1, 'viewer'], ['approved', 'draft', 1, 'viewer']]);
  assert.equal(lib.readSql('draft', ref).trim(), sql);

  // The revoked draft can be approved again: its run of the same SQL still counts.
  assert.equal(approveInLibrary(lib, ref).meta.approvedVersion, 1);
  assert.equal(lib.readMeta('approved', ref).stageHistory.length, 3);
});

test('repeating a stage change is refused and changes nothing', () => {
  const lib = draftWithRun();
  lib.approve(ref);
  const before = fs.readFileSync(lib.paths('approved', ref).meta, 'utf8');
  assert.throws(() => lib.approve(ref), err => err.errorCode === 'NOT_FOUND' && /No draft/.test(err.message));
  lib.revoke(ref);
  assert.throws(() => lib.revoke(ref), err => err.errorCode === 'NOT_FOUND' && /No approved report/.test(err.message));
  assert.ok(before.includes('"status": "approved"'));
  assert.deepEqual(lib.list().map(i => i.stage), ['draft']);
});

test('revoke is refused while a draft of the same report exists', () => {
  const lib = draftWithRun();
  lib.approve(ref);
  lib.saveDraft({ ref, sql: `${sql} where status_code = 'A'` });
  assert.throws(() => lib.revoke(ref), err => err.errorCode === 'PRECONDITION_FAILED');
  assert.equal(lib.exists('approved', ref), true);
  assert.equal(lib.readSql('draft', ref).includes("status_code = 'A'"), true, 'the open draft is untouched');
});

test('missing reports and path tricks are refused', () => {
  const lib = draftWithRun();
  assert.throws(() => lib.revoke({ ...ref, name: 'missing-report' }), err => err.errorCode === 'NOT_FOUND');
  assert.throws(() => lib.approve({ ...ref, name: 'missing-report' }), err => err.errorCode === 'NOT_FOUND');
  assert.throws(() => lib.revoke({ ...ref, category: '..' }), err => err.errorCode === 'INVALID_INPUT');
  assert.throws(() => lib.approve({ ...ref, schema: 'example/../../x' }), err => err.errorCode === 'INVALID_INPUT');
});
