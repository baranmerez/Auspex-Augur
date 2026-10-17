import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, LibraryError, normalizeRef, validateCategory, refLabel, sqlHash } from '../src/reports/library.js';
import { ReportService } from '../src/reports/service.js';
import { validateRefInput, StageError } from '../src/reports/stageChange.js';

// Nested report categories: a category is 1 to 3 folder levels joined by "/"
// (topic/subtopic), stored as real nested folders below <db>/<schema>.
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-nested-'));
const sql = 'select order_id, status_code from example.orders';
const at = '2026-10-01T08:00:00.000Z';
const refs = [
  { db: 'exampledb', schema: 'example', category: 'Orders', name: 'order-totals' },
  { db: 'exampledb', schema: 'example', category: 'Orders/Delivery', name: 'late-deliveries' },
  { db: 'exampledb', schema: 'example', category: 'Orders/Delivery/Weekly', name: 'weekly-deliveries' },
];

function draftWithRun(lib, ref) {
  lib.saveDraft({ ref, title: ref.name, sql });
  lib.appendRun('draft', ref, { at, sqlHash: sqlHash(sql), durationMs: 5, rows: 1, warnings: [] }, null);
}

test('a category of 1 to 3 levels is accepted and keeps its canonical form', () => {
  assert.equal(validateCategory('Orders'), 'Orders');
  assert.equal(validateCategory(' Orders '), 'Orders', 'the whole value is trimmed as before');
  assert.equal(validateCategory('Orders/Delivery performance'), 'Orders/Delivery performance');
  assert.equal(validateCategory('Örnek/Çalışma/Haftalık'), 'Örnek/Çalışma/Haftalık');
  assert.equal(validateCategory(['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)].join('/')).length, 242);
  assert.equal(normalizeRef({ ...refs[1], name: 'Late Deliveries' }).category, 'Orders/Delivery');
  assert.equal(refLabel(normalizeRef(refs[2])), 'exampledb/example/Orders/Delivery/Weekly/weekly-deliveries');
});

test('four levels, empty levels, traversal and padded levels are refused', () => {
  for (const bad of ['a/b/c/d', 'a/../b', '../a', 'a/..', '/a', 'a/', 'a//b', 'a/ b', 'a /b', 'a/.b', 'a/b.', 'a\\b', 'a/b:c', 'a/' + 'x'.repeat(81), '', '/']) {
    assert.throws(() => validateCategory(bad), LibraryError, JSON.stringify(bad));
  }
});

test('save, list, approve and revoke work with 1-, 2- and 3-level categories', () => {
  const lib = new Library(tempRoot());
  for (const ref of refs) draftWithRun(lib, ref);
  assert.ok(lib.paths('draft', refs[2]).sql.endsWith(path.join('_drafts', 'exampledb', 'example', 'Orders', 'Delivery', 'Weekly', 'weekly-deliveries.sql')));
  const listed = lib.list().map(r => [r.stage, r.category, r.categoryPath.join('>'), r.name]).sort();
  assert.deepEqual(listed, [
    ['draft', 'Orders', 'Orders', 'order-totals'],
    ['draft', 'Orders/Delivery', 'Orders>Delivery', 'late-deliveries'],
    ['draft', 'Orders/Delivery/Weekly', 'Orders>Delivery>Weekly', 'weekly-deliveries'],
  ]);
  for (const ref of refs) assert.equal(lib.approve(ref).meta.approvedVersion, 1);
  assert.equal(fs.existsSync(path.join(lib.root, '_drafts', 'exampledb')), false, 'every empty nested draft folder is pruned');
  assert.deepEqual(lib.list().map(r => r.stage), ['approved', 'approved', 'approved']);

  lib.revoke(refs[2]);
  assert.equal(fs.existsSync(path.join(lib.root, 'SELECT', 'exampledb', 'example', 'Orders', 'Delivery', 'Weekly')), false, 'the emptied level is pruned');
  assert.equal(fs.existsSync(path.join(lib.root, 'SELECT', 'exampledb', 'example', 'Orders', 'Delivery')), true, 'a level that still holds a report stays');
  assert.equal(lib.exists('draft', refs[2]), true);
});

test('list skips levels below the third and folders that are not category names', () => {
  const lib = new Library(tempRoot());
  const schemaDir = path.join(lib.root, 'SELECT', 'exampledb', 'example');
  const put = (rel, text = 'select 1') => {
    fs.mkdirSync(path.dirname(path.join(schemaDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(schemaDir, rel), text);
  };
  put('Orders/top.sql');
  put('Orders/A/B/C/too-deep.sql');
  put('.hidden/skipped.sql');
  put('Orders/A/B/kept.sql');
  fs.mkdirSync(path.join(schemaDir, 'Orders', 'folder.sql'));
  assert.deepEqual(lib.list().map(r => `${r.category}|${r.name}`).sort(), ['Orders/A/B|kept', 'Orders|top']);
});

test('existing single-level files keep working unchanged', () => {
  const lib = new Library(tempRoot());
  const old = { db: 'exampledb', schema: 'example', category: 'Example Reports', name: 'example-report' };
  draftWithRun(lib, old);
  const [item] = lib.list();
  assert.equal(item.category, 'Example Reports');
  assert.deepEqual(item.categoryPath, ['Example Reports']);
  assert.equal(lib.approve(old).meta.approvedVersion, 1);
});

test('run_report runs and records a report in a nested category', async () => {
  const root = tempRoot();
  const db = {
    resolveProfile() {},
    async runReport() {
      return {
        profile: 'exampledb', serverVersion: '16.0', plan: [{ Plan: { 'Node Type': 'Result', 'Total Cost': 0.01, 'Plan Rows': 1 } }],
        columns: [{ name: 'order_id', type: 'integer' }], rows: [[1]], truncated: false, explainMs: 1, previewMs: 1, previewExecuted: true,
      };
    },
  };
  const service = new ReportService(db, root);
  service.save({ ...refs[2], sql, title: 'Weekly deliveries' });
  const res = await service.run(refs[2], { analyze: 'never' });
  assert.equal(res.report, 'exampledb/example/Orders/Delivery/Weekly/weekly-deliveries');
  assert.equal(res.stage, 'draft');
  assert.ok(fs.existsSync(res.htmlFile));
  assert.equal(service.library.readMeta('draft', refs[2]).runs.length, 1);
  assert.equal(service.approve(refs[2]).version, 1);
  assert.deepEqual(service.list({ stage: 'approved' }).map(r => r.category), ['Orders/Delivery/Weekly']);
});

test('save_execute_script stores change scripts in nested categories', () => {
  const lib = new Library(tempRoot());
  const ref = { db: 'exampledb', schema: 'example', category: 'Orders/Fixes', name: 'fix-status' };
  const res = lib.saveExecuteScript({ ref, sql: 'BEGIN;\nUPDATE example.orders SET status_code = 1 WHERE order_id = 1;\nROLLBACK;' });
  assert.ok(res.file.endsWith(path.join('EXECUTE', 'exampledb', 'example', 'Orders', 'Fixes', 'fix-status.sql')));
  assert.match(fs.readFileSync(res.file, 'utf8'), /Category: Orders\/Fixes/);
  assert.deepEqual(lib.list().map(r => [r.stage, r.category]), [['execute', 'Orders/Fixes']]);
});

test('stage requests accept a nested category only in its canonical form', () => {
  assert.equal(validateRefInput({ ...refs[2] }).category, 'Orders/Delivery/Weekly');
  for (const category of ['Orders/../Orders', 'Orders//Delivery', '/Orders', 'Orders/ Delivery', ' Orders/Delivery', 'a/b/c/d']) {
    assert.throws(() => validateRefInput({ ...refs[1], category }), StageError, category);
  }
  const long = ['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)].join('/');
  assert.equal(validateRefInput({ ...refs[1], category: long }).category, long);
});

test('Windows device names are refused on every category level and skipped when listing', () => {
  for (const bad of ['CON', 'nul', 'Orders/PRN', 'Orders/Delivery/aux.txt', 'com1', 'LPT9/x', 'Orders/com¹']) {
    assert.throws(() => validateCategory(bad), /reserved device name/, bad);
  }
  for (const ok of ['Console', 'Orders/Nullable', 'COM10', 'Orders/LPT', 'auxiliary']) assert.equal(validateCategory(ok), ok);
  const lib = new Library(tempRoot());
  const schemaDir = path.join(lib.root, 'SELECT', 'exampledb', 'example');
  // Windows cannot create a device-name folder; elsewhere it exists and is skipped.
  const rels = ['Orders/top.sql', 'Orders/con1/kept.sql', ...(process.platform === 'win32' ? [] : ['Orders/NUL/skipped.sql', 'aux/skipped.sql'])];
  for (const rel of rels) {
    fs.mkdirSync(path.dirname(path.join(schemaDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(schemaDir, rel), 'select 1');
  }
  assert.deepEqual(lib.list().map(r => `${r.category}|${r.name}`).sort(), ['Orders/con1|kept', 'Orders|top']);
});
