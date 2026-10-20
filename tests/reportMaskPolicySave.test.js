import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportService, renderReport } from '../src/reports/service.js';
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

test('tightening the mask while only an approved copy exists also scrubs that copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-mask-save-approved-'));
  try {
    const service = new ReportService({ resolveProfile: name => name }, root);
    const lib = service.library;
    const ref = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'example-approved' };
    const sql = 'select tracking_ref from example.orders';
    service.save({ ...ref, sql, unmask: ['tracking_ref'] });
    const rawText = 'synthetic-approved-reference-913';
    const updated = lib.appendRun('draft', ref,
      { at: '2026-10-01T12:00:00Z', sqlHash: sqlHash(sql), durationMs: 2, warnings: [] },
      { at: '2026-10-01T12:00:00Z', sqlHash: sqlHash(sql), columns: [{ name: 'tracking_ref', type: 'text' }],
        preview: [[rawText]], maskedColumns: [], summary: {} });
    lib.writeHtml('draft', ref, renderReport(updated));
    lib.approve(ref);
    assert.ok(fs.readFileSync(lib.paths('approved', ref).html, 'utf8').includes(rawText), 'the approved HTML starts with the raw value');

    service.save({ ...ref, sql, mask: ['tracking_ref'], unmask: [] });
    const approved = lib.readMeta('approved', ref);
    assert.deepEqual(approved.last.preview, [['s***']]);
    assert.deepEqual(approved.last.maskedColumns, ['tracking_ref']);
    assert.ok(!fs.readFileSync(lib.paths('approved', ref).html, 'utf8').includes(rawText), 'the approved HTML is regenerated without it');
    assert.ok(!fs.readFileSync(lib.paths('approved', ref).meta, 'utf8').includes(rawText));
    assert.deepEqual(approved.unmask, ['tracking_ref'], 'the approved policy itself changes only on approval');

    // A looser policy on the draft never revives the approved copy's value.
    service.save({ ...ref, sql, mask: [], unmask: ['tracking_ref'] });
    assert.deepEqual(lib.readMeta('approved', ref).last.preview, [['s***']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
