import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, sqlHash } from '../src/reports/library.js';
import { approveInLibrary, revokeInLibrary, approvedJoinPairs, ReportService } from '../src/reports/service.js';
import { SchemaMemory } from '../src/memory/store.js';

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

test('approve and revoke rebuild the schema memory view: the joins are "used" relations only while approved', () => {
  const lib = new Library(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-stage-mem-')));
  const joinSql = 'select o.order_id from example.orders o join example.customers c on c.customer_id = o.customer_id';
  lib.saveDraft({ ref, sql: joinSql });
  const last = { sqlHash: sqlHash(joinSql), summary: { joins: [{ columnPairs: [{ left: 'example.orders.customer_id', right: 'example.customers.customer_id' }] }] } };
  lib.appendRun('draft', ref, { at: '2026-10-01T08:00:00.000Z', sqlHash: sqlHash(joinSql), durationMs: 5, rows: 1, warnings: [] }, last);
  const memory = new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-stage-memdir-')), { approvedJoins: p => approvedJoinPairs(lib, p) });
  const usedEdges = () => JSON.parse(fs.readFileSync(path.join(memory.root, 'exampledb', 'graph.json'), 'utf8')).edges.filter(e => e.level === 'used');

  approveInLibrary(lib, ref, { by: 'viewer', memory });
  assert.deepEqual(usedEdges().map(e => [e.from, e.to, e.columns]), [['example.orders', 'example.customers', ['customer_id']]]);
  revokeInLibrary(lib, ref, { by: 'viewer', memory });
  assert.deepEqual(usedEdges(), []);
});

test('a run whose report was approved meanwhile is saved to the stage it lives in now', async () => {
  const lib = draftWithRun();
  const plan = [{ Plan: { 'Node Type': 'Result', 'Total Cost': 0.01, 'Plan Rows': 1 } }];
  let move = () => {};
  const db = {
    source: 'test',
    resolveProfile: name => name,
    async runReport(profile) {
      move(); // the viewer changes the stage while the query runs
      return { profile, plan, columns: [{ name: 'order_id', type: 'integer' }], rows: [[1]], explainMs: 1, previewMs: 1, previewExecuted: true, truncated: false, serverVersion: '16' };
    },
  };
  const service = new ReportService(db, lib.root);

  move = () => approveInLibrary(lib, ref);
  const approvedRun = await service.run(ref, { analyze: false });
  assert.equal(approvedRun.stage, 'approved');
  assert.equal(lib.readMeta('approved', ref).runs.length, 2);
  assert.ok(approvedRun.htmlFile.includes(`${path.sep}SELECT${path.sep}`));

  move = () => revokeInLibrary(lib, ref);
  const revokedRun = await service.run(ref, { analyze: false });
  assert.equal(revokedRun.stage, 'draft');
  assert.equal(lib.readMeta('draft', ref).runs.length, 3);

  move = () => { for (const f of Object.values(lib.paths('draft', ref))) fs.rmSync(f, { force: true }); };
  await assert.rejects(service.run(ref, { analyze: false }), err => err.errorCode === 'NOT_FOUND' && /stage changed during run/.test(err.message));
});

test('approve and revoke are bound to the version the person reviewed', () => {
  const lib = draftWithRun();
  const v1 = sqlHash(sql);
  // v2 is saved and run while the confirm dialog still shows v1.
  const sqlV2 = `${sql} where status_code = 'A'`;
  const v2 = lib.saveDraft({ ref, sql: sqlV2 }).hash;
  assert.equal(v2, sqlHash(sqlV2));
  lib.appendRun('draft', ref, { at: '2026-10-01T09:00:00.000Z', sqlHash: v2, durationMs: 8, rows: 1, warnings: [] }, null);
  const draftMeta = fs.readFileSync(lib.paths('draft', ref).meta, 'utf8');

  assert.throws(() => approveInLibrary(lib, ref, { by: 'viewer', expectedHash: v1 }),
    err => err.errorCode === 'STALE_VERSION' && err.message === 'The report changed since you opened it (now version 2); reload and review again.');
  assert.equal(lib.exists('approved', ref), false, 'nothing moved');
  assert.equal(fs.readFileSync(lib.paths('draft', ref).meta, 'utf8'), draftMeta, 'the draft is untouched');

  assert.equal(approveInLibrary(lib, ref, { by: 'viewer', expectedHash: v2 }).meta.approvedVersion, 2);
  const approvedMeta = fs.readFileSync(lib.paths('approved', ref).meta, 'utf8');
  assert.throws(() => revokeInLibrary(lib, ref, { by: 'viewer', expectedHash: v1 }), err => err.errorCode === 'STALE_VERSION' && /now version 2/.test(err.message));
  assert.equal(fs.readFileSync(lib.paths('approved', ref).meta, 'utf8'), approvedMeta, 'still approved, unchanged');
  assert.equal(revokeInLibrary(lib, ref, { by: 'viewer', expectedHash: v2 }).version, 2);
  // Without expectedHash (approve_report without the optional field) the current SQL is approved.
  assert.equal(approveInLibrary(lib, ref).meta.approvedVersion, 2);
});
