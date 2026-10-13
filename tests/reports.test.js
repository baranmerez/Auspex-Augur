import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizePlan, planDigest } from '../src/reports/planSummary.js';
import { isPersonalColumn, maskRows, maskValue } from '../src/reports/mask.js';
import { Library, LibraryError, slugify, validateSegment, lintExecuteScript, sqlHash } from '../src/reports/library.js';
import { renderReport, ReportService } from '../src/reports/service.js';
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
  // comments and strings do not confuse the checks
  assert.deepEqual(lintExecuteScript("BEGIN; -- commit later\n/* delete from t; */ SELECT 'commit; delete from t', $$ rollback; $$;\nROLLBACK;").errors, []);
  assert.match(lintExecuteScript('BEGIN; TRUNCATE t; ROLLBACK;').warnings[0], /TRUNCATE/);
});

const validScripts = [
  ['subquery in WHERE', 'BEGIN;\nDELETE FROM t WHERE id IN (SELECT id FROM u WHERE flag);\nROLLBACK;'],
  ['UPDATE with FROM and WHERE', 'BEGIN;\nUPDATE t SET a = u.a FROM u WHERE u.id = t.id;\nROLLBACK;'],
  ['UPDATE with scalar subquery and WHERE', 'BEGIN;\nUPDATE t SET a = (SELECT max(b) FROM u WHERE u.k = t.k) WHERE t.id = 1;\nROLLBACK;'],
  ['data-modifying CTE with WHERE', 'BEGIN;\nWITH d AS (DELETE FROM t WHERE id = 1 RETURNING *) INSERT INTO arch SELECT * FROM d;\nROLLBACK;'],
  ['upsert', 'BEGIN;\nINSERT INTO t (id, a) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET a = excluded.a;\nROLLBACK;'],
  ['locking read', 'BEGIN;\nSELECT * FROM t WHERE id = 1 FOR NO KEY UPDATE;\nSELECT * FROM t WHERE id = 1 FOR UPDATE;\nROLLBACK;'],
  ['savepoints', 'BEGIN;\nSAVEPOINT a;\nUPDATE t SET a = 1 WHERE id = 1;\nROLLBACK TO SAVEPOINT a;\nRELEASE SAVEPOINT a;\nROLLBACK;'],
  ['rollback variants and start transaction', 'START TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nUPDATE t SET a = 1 WHERE id = 1;\nROLLBACK WORK;'],
  ['comments and dollar quoting', "BEGIN;\n-- ROLLBACK; DELETE FROM t;\nUPDATE t SET note = $x$ DELETE FROM t; COMMIT; $x$ WHERE id = 1;\nROLLBACK TRANSACTION;"],
];

for (const [name, sql] of validScripts) {
  test(`EXECUTE lint accepts ${name}`, () => {
    assert.deepEqual(lintExecuteScript(sql).errors, []);
  });
}

const invalidScripts = [
  ['early ROLLBACK then a write (issue #4)', 'BEGIN; ROLLBACK; DELETE FROM reviewFixture WHERE id = 1; ROLLBACK;', /only one BEGIN \.\.\. ROLLBACK envelope/],
  ['WHERE only inside a USING subquery (issue #4)', 'BEGIN; DELETE FROM reviewFixture USING (SELECT 1 WHERE true) AS helper; ROLLBACK;', /a DELETE without WHERE/],
  ['UPDATE whose only WHERE is in a subquery', 'BEGIN; UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1); ROLLBACK;', /an UPDATE without WHERE/],
  ['data-modifying CTE without WHERE', 'BEGIN; WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d WHERE true; ROLLBACK;', /a DELETE without WHERE/],
  ['second BEGIN', 'BEGIN; BEGIN; UPDATE t SET a = 1 WHERE id = 1; ROLLBACK;', /only one BEGIN/],
  ['ABORT in the middle', 'BEGIN; ABORT; UPDATE t SET a = 1 WHERE id = 1; ROLLBACK;', /only one BEGIN/],
  ['END in the middle', 'BEGIN; END; ROLLBACK;', /COMMIT is never written/],
  ['PREPARE TRANSACTION', "BEGIN; PREPARE TRANSACTION 'x'; ROLLBACK;", /only one BEGIN/],
  ['ROLLBACK TO as the last statement', 'BEGIN; SAVEPOINT a; ROLLBACK TO a;', /last statement must be ROLLBACK/],
  ['DO block', 'BEGIN; DO $$ BEGIN DELETE FROM t; END $$; ROLLBACK;', /DO block/],
  ['CALL', 'BEGIN; CALL purge(); ROLLBACK;', /CALL/],
  ['CREATE FUNCTION', 'BEGIN; CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ DELETE FROM t $$ LANGUAGE sql; ROLLBACK;', /function or procedure/],
  ['psql meta command', 'BEGIN;\nUPDATE t SET a = 1 WHERE id = 1;\n\\commit\nROLLBACK;', /backslash command/],
];

for (const [name, sql, message] of invalidScripts) {
  test(`EXECUTE lint rejects ${name}`, () => {
    assert.match(lintExecuteScript(sql).errors.join(' | '), message);
  });
}

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

test('EXECUTE script metadata stays inside comments for LF, CRLF and lone CR', () => {
  const lib = tempLibrary();
  const r = lib.saveExecuteScript({
    ref: { ...ref, name: 'multiline header' },
    title: 'Fix\nSELECT 42 AS marker_title;',
    purpose: 'one\r\nSELECT 43 AS marker_purpose;',
    relatedReport: 'rep\rSELECT 44 AS marker_related;',
    expectedRows: '5\nSELECT 45 AS marker_rows;',
    sql: 'BEGIN;\nUPDATE t SET a = 1 WHERE id = 2;\nROLLBACK;',
  });
  const lines = fs.readFileSync(r.file, 'utf8').split('\n');
  assert.ok(!lines.some(l => l.includes('\r')), 'no carriage returns survive');
  for (const marker of ['marker_title', 'marker_purpose', 'marker_related', 'marker_rows']) {
    const line = lines.find(l => l.includes(marker));
    assert.ok(line.startsWith('-- '), `${marker} is commented`);
  }
  const firstSql = lines.find(l => l.trim() && !l.startsWith('--'));
  assert.equal(firstSql, 'BEGIN;');
  assert.match(lines.join('\n'), /-- Purpose {8}: one\n-- {18}SELECT 43/);
});

test('rendered HTML embeds the report safely', () => {
  const html = renderReport({ title: 'A <b>&</b> "report"', name: 'x', sqlVersions: [{ version: 1, sql: "select '</script><script>alert(1)</script>'" }], runs: [], last: null });
  assert.ok(!html.includes('"__AUSPEX_DATA__"'));
  assert.ok(!html.includes('</script><script>alert(1)'), 'closing script tags in data are escaped');
  assert.match(html, /<title>A &lt;b&gt;&amp;&lt;\/b&gt; &quot;report&quot; · Auspex Augur<\/title>/);
  const json = html.match(/<script id="auspex-report" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).report.sqlVersions[0].sql, "select '</script><script>alert(1)</script>'");
});

// A ReportService over a temp library and a fake database: runReport returns
// the analyzed plan above, or throws when failNext is set.
function tempService() {
  const fake = {
    failNext: false,
    resolveProfile: name => String(name).toLowerCase(),
    async runReport(profile) {
      if (fake.failNext) { fake.failNext = false; throw new Error('canceling statement due to statement timeout'); }
      return { profile, serverVersion: '16.0', analyzed: true, plan: analyzedPlan, explainMs: 1, previewMs: 1,
        columns: [{ name: 'id', type: 'integer' }], rows: [[1]], rowCount: 1, truncated: false };
    },
  };
  const svc = new ReportService(fake, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-svc-test-')));
  return { svc, fake };
}
const embedded = html => JSON.parse(html.match(/<script id="auspex-report" type="application\/json">([\s\S]*?)<\/script>/)[1]).report;

test('reverting to an earlier SQL approves that version, not the newest entry', async () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  svc.save({ ...ref, sql: 'select 2' });
  assert.equal(svc.save({ ...ref, sql: 'select 1' }).version, 1);
  await svc.run(ref);
  const res = svc.approve(ref);
  assert.equal(res.version, 1);
  const meta = svc.library.readMeta('approved', ref);
  assert.equal(meta.approvedVersion, 1);
  assert.equal(meta.activeVersion, 1);
  assert.equal(svc.library.readSql('approved', ref).trim(), 'select 1');
});

test('editing without running labels the old result as stale and drops its joins', async () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  await svc.run(ref);
  svc.approve(ref);
  assert.equal(svc.approvedJoinPairs('local').length, 1, 'matching approved run teaches its join');

  svc.save({ ...ref, sql: 'select 2' });
  const draft = svc.library.readMeta('draft', ref);
  assert.equal(draft.activeVersion, 2);
  assert.equal(draft.last.version, 1, 'previous result is kept, labelled by its own version');
  const report = embedded(fs.readFileSync(svc.library.paths('draft', ref).html, 'utf8'));
  assert.equal(report.activeHash, sqlHash('select 2'));
  assert.notEqual(report.last.sqlHash, report.activeHash);

  svc.approve(ref);
  assert.deepEqual(svc.approvedJoinPairs('local'), [], 'stale result from v1 does not count for approved v2');
  await svc.run(ref);
  assert.equal(svc.approvedJoinPairs('local').length, 1, 'a run of v2 makes it count again');
});

test('a failed run leaves the previous result and its revision untouched', async () => {
  const { svc, fake } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  await svc.run(ref);
  fake.failNext = true;
  await assert.rejects(svc.run(ref), /statement timeout/);
  const meta = svc.library.readMeta('draft', ref);
  assert.equal(meta.runs.length, 1);
  assert.equal(meta.last.sqlHash, meta.activeHash);
});

test('approval refuses draft SQL that matches no saved version', () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  fs.writeFileSync(svc.library.paths('draft', ref).sql, 'select 99\n');
  assert.throws(() => svc.approve(ref), /matches no saved version/);
});
