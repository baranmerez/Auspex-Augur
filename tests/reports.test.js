import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizePlan, planDigest } from '../src/reports/planSummary.js';
import { isPersonalColumn, maskRows, maskValue } from '../src/reports/mask.js';
import { Library, LibraryError, slugify, validateSegment, lintExecuteScript, sqlHash } from '../src/reports/library.js';
import { renderReport } from '../src/reports/service.js';
import { SqlGuardError } from '../src/sqlGuard.js';

// Minimal EXPLAIN (ANALYZE, FORMAT JSON) shape: Sort <- Hash Join(orders o, customers c).
const scan = (rel, alias, rows, est, ms, extra = {}) => ({
  'Node Type': 'Seq Scan', 'Relation Name': rel, Schema: 'sales', Alias: alias,
  'Startup Cost': 0, 'Total Cost': est / 10, 'Plan Rows': est, 'Actual Total Time': ms, 'Actual Rows': rows, 'Actual Loops': 1, ...extra,
});
const analyzedPlan = [{
  Plan: {
    'Node Type': 'Sort', 'Sort Key': ['o.total DESC'], 'Sort Method': 'external merge', 'Sort Space Used': 9000, 'Sort Space Type': 'Disk',
    'Startup Cost': 900, 'Total Cost': 1000, 'Plan Rows': 200000, 'Actual Total Time': 100, 'Actual Rows': 200000, 'Actual Loops': 1,
    'Shared Hit Blocks': 300, 'Shared Read Blocks': 100, 'Temp Written Blocks': 50,
    Plans: [{
      'Node Type': 'Hash Join', 'Join Type': 'Inner', 'Hash Cond': '(o.customer_id = c.id)',
      'Startup Cost': 10, 'Total Cost': 800, 'Plan Rows': 200000, 'Actual Total Time': 70, 'Actual Rows': 200000, 'Actual Loops': 1,
      Plans: [
        scan('orders', 'o', 200000, 200000, 40),
        { 'Node Type': 'Hash', 'Startup Cost': 5, 'Total Cost': 5, 'Plan Rows': 10, 'Actual Total Time': 5, 'Actual Rows': 5000, 'Actual Loops': 1,
          Plans: [scan('customers', 'c', 5000, 10, 4)] },
      ],
    }],
  },
  'Planning Time': 1.5, 'Execution Time': 101,
}];

test('plan summary computes own time, joins, relations and buffers', () => {
  const s = summarizePlan(analyzedPlan);
  assert.equal(s.analyzed, true);
  assert.equal(s.rows, 200000);
  assert.equal(s.nodes.length, 5);
  const sort = s.nodes[0];
  assert.equal(sort.ownMs, 30);
  assert.ok(Math.abs(s.nodes.reduce((a, n) => a + n.share, 0) - 1) < 1e-9, 'shares add up to 1');
  assert.equal(s.joins.length, 1);
  assert.deepEqual(s.joins[0].outer, ['sales.orders']);
  assert.deepEqual(s.joins[0].inner, ['sales.customers']);
  assert.deepEqual(s.joins[0].columnPairs, [{ left: 'sales.orders.customer_id', right: 'sales.customers.id' }]);
  assert.deepEqual(s.relations.map(r => r.relation).sort(), ['sales.customers', 'sales.orders']);
  assert.equal(s.buffers.sharedHit, 300);
  assert.equal(s.buffers.tempWritten, 50);
});

test('plan warnings: big seq scan, disk sort, temp, misestimate only at its origin', () => {
  const kinds = summarizePlan(analyzedPlan).warnings.map(w => w.kind);
  assert.ok(kinds.includes('seq-scan'));
  assert.ok(kinds.includes('disk-sort'));
  assert.ok(kinds.includes('temp'));
  const mis = summarizePlan(analyzedPlan).warnings.filter(w => w.kind === 'misestimate');
  assert.equal(mis.length, 1, 'the Hash above the misestimated scan is not reported again');
  assert.match(mis[0].text, /sales\.customers.*under 500x.*ANALYZE/);
});

test('plan summary without ANALYZE falls back to cost', () => {
  const plan = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 't', Schema: 'public', Alias: 't', 'Startup Cost': 0, 'Total Cost': 50, 'Plan Rows': 1000 } }];
  const s = summarizePlan(plan);
  assert.equal(s.analyzed, false);
  assert.equal(s.nodes[0].ownCost, 50);
  assert.equal(s.nodes[0].ownMs, null);
  assert.equal(planDigest(s).hotspots[0], 'Seq Scan public.t 100%');
});

test('plan summary rejects non-plan input', () => {
  assert.throws(() => summarizePlan({}), /EXPLAIN/);
});

test('personal columns are detected in English, Turkish and compound names', () => {
  for (const c of ['email', 'phone', 'full_name', 'customerName', 'tc_kimlik_no', 'aliciadi', 'gonderenunvan', 'alicitelefon', 'iban', 'alicivdno', 'adres'])
    assert.equal(isPersonalColumn(c), true, c);
  for (const c of ['id', 'region', 'workers', 'avg_wage', 'created_at', 'status', 'total'])
    assert.equal(isPersonalColumn(c), false, c);
});

test('masking keeps shape, honours mask and unmask lists', () => {
  assert.equal(maskValue('Ayşe Yılmaz'), 'A*** Y***');
  assert.equal(maskValue(null), null);
  const r = maskRows(['id', 'full_name', 'note', 'email'], [[1, 'Ali Veli', 'secret', 'a@b.c']], { mask: ['note'], unmask: ['email'] });
  assert.deepEqual(r.maskedColumns, ['full_name', 'note']);
  assert.deepEqual(r.rows[0], [1, 'A*** V***', 's***', 'a@b.c']);
});

test('slugs are ASCII kebab-case; segments allow Turkish but no path tricks', () => {
  assert.equal(slugify('Günlük Satış Özeti!'), 'gunluk-satis-ozeti');
  assert.equal(slugify('İŞLEM Çıktısı v2'), 'islem-ciktisi-v2');
  assert.throws(() => slugify('---'), LibraryError);
  assert.equal(validateSegment(' Aylık Raporlar ', 'Category'), 'Aylık Raporlar');
  for (const bad of ['../x', 'a/b', 'a\\b', '.hidden', 'x.', 'a:b', ''])
    assert.throws(() => validateSegment(bad, 'Category'), LibraryError, bad);
});

function tempLibrary() {
  return new Library(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-lib-test-')));
}
const ref = { db: 'Local', schema: 'sales', category: 'Genel Çalışma', name: 'Order Totals' };

test('drafts are stored under _drafts/<db>/<schema>/<category> and versioned by SQL hash', () => {
  const lib = tempLibrary();
  const a = lib.saveDraft({ ref, title: 'Order totals', sql: 'select 1' });
  assert.equal(a.version, 1);
  assert.ok(a.paths.sql.endsWith(path.join('_drafts', 'local', 'sales', 'Genel Çalışma', 'order-totals.sql')));
  assert.equal(lib.saveDraft({ ref, sql: 'select 1' }).version, 1, 'same SQL, same version');
  assert.equal(lib.saveDraft({ ref, sql: 'select 2', note: 'changed' }).version, 2);
  const meta = lib.readMeta('draft', ref);
  assert.deepEqual(meta.sqlVersions.map(v => v.version), [1, 2]);
  assert.equal(meta.sqlVersions[1].hash, sqlHash('select 2'));
  assert.equal(lib.locate(ref), 'draft');
});

test('drafts must be read-only SQL', () => {
  assert.throws(() => tempLibrary().saveDraft({ ref, sql: 'delete from t' }), SqlGuardError);
});

test('approve moves the draft into SELECT and prunes empty draft folders', () => {
  const lib = tempLibrary();
  lib.saveDraft({ ref, sql: 'select 1' });
  lib.appendRun('draft', ref, { at: new Date().toISOString(), durationMs: 5, rows: 1, warnings: [] }, null);
  const res = lib.approve(ref);
  assert.equal(res.meta.status, 'approved');
  assert.equal(res.meta.approvedVersion, 1);
  assert.equal(lib.exists('draft', ref), false);
  assert.equal(lib.exists('approved', ref), true);
  assert.equal(fs.existsSync(path.join(lib.root, '_drafts', 'local')), false);
  assert.equal(lib.locate(ref), 'approved');
  assert.throws(() => lib.approve(ref), /No draft/);
  assert.deepEqual(lib.list().map(i => `${i.stage}:${i.db}/${i.schema}/${i.category}/${i.name}`), ['approved:local/sales/Genel Çalışma/order-totals']);
});

test('run history keeps the last 100 runs', () => {
  const lib = tempLibrary();
  lib.saveDraft({ ref, sql: 'select 1' });
  for (let i = 0; i < 105; i++) lib.appendRun('draft', ref, { at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, n: i, warnings: [] }, null);
  const runs = lib.readMeta('draft', ref).runs;
  assert.equal(runs.length, 100);
  assert.equal(runs[0].n, 5);
});

test('EXECUTE lint: BEGIN first, ROLLBACK last, no COMMIT, WHERE on UPDATE/DELETE', () => {
  assert.deepEqual(lintExecuteScript('BEGIN;\nUPDATE t SET a = 1 WHERE id = 2;\nROLLBACK;').errors, []);
  const bad = lintExecuteScript('UPDATE t SET a = 1;\nDELETE FROM t;\nCOMMIT;').errors.join(' | ');
  assert.match(bad, /first statement must be BEGIN/);
  assert.match(bad, /last statement must be ROLLBACK/);
  assert.match(bad, /UPDATE without WHERE/);
  assert.match(bad, /DELETE without WHERE/);
  assert.match(bad, /COMMIT is never written/);
  // comments, strings and DO blocks do not confuse the checks
  assert.deepEqual(lintExecuteScript("BEGIN; -- commit later\nDO $$ BEGIN UPDATE t SET a = 1; END $$;\nSELECT 'commit; delete from t';\nROLLBACK;").errors, []);
  assert.match(lintExecuteScript('BEGIN; TRUNCATE t; ROLLBACK;').warnings[0], /TRUNCATE/);
});

test('EXECUTE scripts get a header and are not overwritten by accident', () => {
  const lib = tempLibrary();
  const r = lib.saveExecuteScript({ ref, purpose: 'fix totals', sql: 'BEGIN;\nUPDATE t SET a = 1 WHERE id = 2;\nROLLBACK;' });
  const text = fs.readFileSync(r.file, 'utf8');
  assert.ok(r.file.includes(path.join('EXECUTE', 'local', 'sales', 'Genel Çalışma')));
  assert.match(text, /NOT executed by Auspex/);
  assert.match(text, /Purpose {8}: fix totals/);
  assert.throws(() => lib.saveExecuteScript({ ref, sql: 'BEGIN; SELECT 1; ROLLBACK;' }), /already exists/);
  assert.doesNotThrow(() => lib.saveExecuteScript({ ref, sql: 'BEGIN; SELECT 1; ROLLBACK;', replace: true }));
  assert.throws(() => lib.saveExecuteScript({ ref, name: 'x', sql: 'UPDATE t SET a = 1;' }), /rejected/);
});

test('rendered HTML embeds the report safely', () => {
  const html = renderReport({ title: 'A <b>&</b> "report"', name: 'x', sqlVersions: [{ version: 1, sql: "select '</script><script>alert(1)</script>'" }], runs: [], last: null });
  assert.ok(!html.includes('"__AUSPEX_DATA__"'));
  assert.ok(!html.includes('</script><script>alert(1)'), 'closing script tags in data are escaped');
  assert.match(html, /<title>A &lt;b&gt;&amp;&lt;\/b&gt; &quot;report&quot; · Auspex Augur<\/title>/);
  const json = html.match(/<script id="auspex-report" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).report.sqlVersions[0].sql, "select '</script><script>alert(1)</script>'");
});
