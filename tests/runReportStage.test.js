import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportService } from '../src/reports/service.js';

// #138: an approved copy and a newer draft at the same location. run_report's
// stage picks the copy, version pins its SQL version, and presets resolve
// against the chosen copy. A fake database records the SQL and params.
function setup() {
  const calls = [];
  const fake = {
    resolveProfile: name => String(name).toLowerCase(),
    async runReport(profile, sql, options) {
      calls.push({ sql: sql.trim(), params: options.params });
      return { profile, serverVersion: '16.0', plan: [{ Plan: { 'Node Type': 'Result', 'Total Cost': 0.01, 'Plan Rows': 1 } }], explainMs: 1, previewMs: 1,
        columns: [{ name: 'amount', type: 'integer' }], rows: [[1]], rowCount: 1, truncated: false, previewExecuted: true };
    },
  };
  const svc = new ReportService(fake, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-run-stage-')));
  return { svc, calls };
}
const ref = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'order-total' };
const approvedSql = 'SELECT $1::int AS amount';
const draftSql = 'SELECT $1::int + 1 AS amount';

async function approvedAndDraft() {
  const s = setup();
  s.svc.save({ ...ref, sql: approvedSql, presets: [{ name: 'Example', params: [100] }, { name: 'Approved only', params: [300] }] });
  await s.svc.run(ref, { preset: 'Example' });
  s.svc.approve(ref);
  s.svc.save({ ...ref, sql: draftSql, presets: [{ name: 'Example', params: [200] }] });
  s.calls.length = 0;
  return s;
}

test('stage "approved" runs the approved copy and its preset while a newer draft exists', async () => {
  const { svc, calls } = await approvedAndDraft();
  const r = await svc.run(ref, { preset: 'Example', stage: 'approved' });
  assert.deepEqual(calls, [{ sql: approvedSql, params: [100] }]);
  assert.equal(r.stage, 'approved');
  await svc.run(ref, { preset: 'Approved only', stage: 'approved' });
  assert.deepEqual(calls[1], { sql: approvedSql, params: [300] }, 'a preset only the approved copy has');
});

test('without stage the draft runs as before; stage "draft" picks it explicitly', async () => {
  const { svc, calls } = await approvedAndDraft();
  await svc.run(ref, { preset: 'Example' });
  await svc.run(ref, { preset: 'Example', stage: 'draft' });
  assert.deepEqual(calls, [{ sql: draftSql, params: [200] }, { sql: draftSql, params: [200] }]);
  await assert.rejects(svc.run(ref, { preset: 'Approved only', stage: 'draft' }), /Unknown preset/);
});

test('a missing copy is refused before any database call', async () => {
  const { svc, calls } = setup();
  svc.save({ ...ref, sql: approvedSql });
  await assert.rejects(svc.run(ref, { stage: 'approved' }), err => err.errorCode === 'PRECONDITION_FAILED' && /no approved copy/.test(err.message));
  assert.equal(calls.length, 0);
});

test('version pins the SQL version of the chosen copy', async () => {
  const { svc, calls } = await approvedAndDraft();
  const approvedVersion = svc.library.readMeta('approved', ref).activeVersion;
  const draftVersion = svc.library.readMeta('draft', ref).activeVersion;
  assert.notEqual(approvedVersion, draftVersion);
  await svc.run(ref, { stage: 'approved', version: approvedVersion, params: [1] });
  assert.equal(calls.at(-1).sql, approvedSql);
  await assert.rejects(svc.run(ref, { stage: 'approved', version: draftVersion, params: [1] }),
    err => err.errorCode === 'STALE_VERSION' && new RegExp(`at SQL version ${approvedVersion}, not ${draftVersion}`).test(err.message));
  await assert.rejects(svc.run(ref, { version: approvedVersion, params: [1] }), err => err.errorCode === 'STALE_VERSION', 'the default copy is the draft');
  assert.equal(calls.length, 1);
});

test('list_reports gives each copy its activeVersion, the value run_report version must match', async () => {
  const { svc, calls } = await approvedAndDraft();
  const entries = svc.list().filter(e => e.name === ref.name);
  const byStage = Object.fromEntries(entries.map(e => [e.stage, e]));
  assert.deepEqual(Object.keys(byStage).sort(), ['approved', 'draft']);
  assert.notEqual(byStage.approved.activeVersion, byStage.draft.activeVersion);
  assert.equal(byStage.draft.approvedVersion, byStage.approved.activeVersion, 'the draft inherits approvedVersion, so it is not the draft version');
  await svc.run(ref, { stage: 'approved', version: byStage.approved.activeVersion, params: [1] });
  await svc.run(ref, { stage: 'draft', version: byStage.draft.activeVersion, params: [1] });
  assert.deepEqual(calls.map(c => c.sql), [approvedSql, draftSql]);
});
