import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportService } from '../src/reports/service.js';

// The query finishes after someone edits the report's masking policy.
// That newest policy must govern both the stored HTML and the MCP response.
test('an in-flight report run respects masking changes made before it finishes', async t => {
  const libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'example-report-mask-'));
  t.after(() => fs.rmSync(libraryDir, { recursive: true, force: true }));
  const reportRef = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'private-notes' };
  const sql = 'select private_note from example.orders';
  let signalStarted;
  let finishQuery;
  const queryStarted = new Promise(resolve => { signalStarted = resolve; });
  const queryAllowedToFinish = new Promise(resolve => { finishQuery = resolve; });
  const fakeDb = {
    resolveProfile: profile => profile,
    async runReport(profile) {
      signalStarted();
      await queryAllowedToFinish;
      return {
        profile, serverVersion: '16.0',
        plan: [{ Plan: { 'Node Type': 'Result', 'Startup Cost': 0, 'Total Cost': 1, 'Plan Rows': 1 } }],
        explainMs: 1, previewMs: 1, previewExecuted: true,
        columns: [{ name: 'private_note', type: 'text' }],
        rows: [['exampleconfidential']], truncated: false,
      };
    },
  };
  const service = new ReportService(fakeDb, libraryDir);
  service.save({ ...reportRef, sql });

  const inFlight = service.run(reportRef, { analyze: false });
  await queryStarted;
  service.save({ ...reportRef, sql, mask: ['private_note'] });
  finishQuery();

  const result = await inFlight;
  const saved = service.library.readMeta('draft', reportRef);
  const html = fs.readFileSync(service.library.paths('draft', reportRef).html, 'utf8');

  assert.deepEqual(result.maskedColumns, ['private_note']);
  assert.deepEqual(result.preview, [['e***']]);
  assert.deepEqual(saved.last.maskedColumns, ['private_note']);
  assert.deepEqual(saved.last.preview, [['e***']]);
  assert.ok(!html.includes('exampleconfidential'), 'report HTML must not contain the stale unmasked result');
});
