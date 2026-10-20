import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportService } from '../src/reports/service.js';
import { sqlHash } from '../src/reports/library.js';

test('tightening a report mask scrubs an earlier preview from metadata and HTML', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-mask-save-example-'));
  try {
    const service = new ReportService({ resolveProfile: name => name }, root);
    const ref = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'example-orders' };
    const sql = 'select tracking_ref from example.orders';
    service.save({ ...ref, sql, unmask: ['tracking_ref'] });
    const rawText = 'synthetic-private-reference-735';
    service.library.appendRun('draft', ref,
      { at: '2026-10-01T12:00:00Z', sqlHash: sqlHash(sql), durationMs: 2, warnings: [] },
      { at: '2026-10-01T12:00:00Z', sqlHash: sqlHash(sql), columns: [{ name: 'tracking_ref', type: 'text' }],
        preview: [[rawText]], maskedColumns: [], summary: {} });
    service.save({ ...ref, sql, mask: ['tracking_ref'], unmask: [] });
    const meta = service.library.readMeta('draft', ref);
    assert.deepEqual(meta.last.preview, [['s***']]);
    assert.deepEqual(meta.last.maskedColumns, ['tracking_ref']);
    const html = fs.readFileSync(service.library.paths('draft', ref).html, 'utf8');
    assert.ok(!html.includes(rawText), 'an already stored result must be scrubbed from the regenerated HTML');

    // A later exemption cannot revive an already masked value.
    service.save({ ...ref, sql, mask: [], unmask: ['tracking_ref'] });
    assert.deepEqual(service.library.readMeta('draft', ref).last.preview, [['s***']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
