import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizePlan, planDigest } from '../src/reports/planSummary.js';
import { isPersonalColumn, maskRows, maskValue } from '../src/reports/mask.js';
import { Library, LibraryError, slugify, validateSegment, validateScriptName, lintExecuteScript, sqlHash } from '../src/reports/library.js';
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

// A scalar subquery in WHERE becomes an InitPlan child placed before the
// join's real inputs; the inputs are named by "Parent Relationship".
test('join inputs follow Parent Relationship, not position, so an InitPlan is skipped', () => {
  const rel = (relationship, node) => ({ ...node, 'Parent Relationship': relationship });
  const exampleScan = (table, alias) => ({ 'Node Type': 'Seq Scan', 'Relation Name': table, Schema: 'example', Alias: alias, 'Startup Cost': 0, 'Total Cost': 10, 'Plan Rows': 100 });
  const join = (children, nodeType = 'Hash Join', extra = { 'Hash Cond': '(o.customer_id = c.customer_id)' }) => [{ Plan: {
    'Node Type': nodeType, 'Join Type': 'Inner', ...extra, 'Startup Cost': 1, 'Total Cost': 50, 'Plan Rows': 100, Plans: children,
  } }];
  const initPlan = rel('InitPlan', { 'Node Type': 'Aggregate', 'Subplan Name': 'InitPlan 1', 'Startup Cost': 0, 'Total Cost': 5, 'Plan Rows': 1,
    Plans: [rel('Outer', exampleScan('limits', 'l'))] });
  const outer = rel('Outer', exampleScan('orders', 'o'));
  const inner = rel('Inner', { 'Node Type': 'Hash', 'Startup Cost': 1, 'Total Cost': 2, 'Plan Rows': 10, Plans: [rel('Outer', exampleScan('customers', 'c'))] });
  const hashJoin = summarizePlan(join([initPlan, outer, inner])).joins[0];
  assert.deepEqual([hashJoin.outer, hashJoin.inner], [['example.orders'], ['example.customers']]);
  // Nested loop: the join key comes from the inner index scan, not the InitPlan.
  const innerIndex = rel('Inner', { ...exampleScan('customers', 'c'), 'Node Type': 'Index Scan', 'Index Name': 'customers_pkey', 'Index Cond': '(customer_id = o.customer_id)' });
  const initFilter = rel('InitPlan', { ...exampleScan('limits', 'l'), Filter: '(order_id = 1)' });
  const loop = summarizePlan(join([initFilter, outer, innerIndex], 'Nested Loop', {})).joins[0];
  assert.deepEqual([loop.outer, loop.inner, loop.condition], [['example.orders'], ['example.customers'], '(customer_id = o.customer_id)']);
  // Plans without the field (older or hand-written ones) keep the positional reading.
  const strip = node => { const { 'Parent Relationship': _drop, ...rest } = node; return { ...rest, ...(rest.Plans ? { Plans: rest.Plans.map(strip) } : {}) }; };
  const plain = summarizePlan(join([outer, inner].map(strip))).joins[0];
  assert.deepEqual([plain.outer, plain.inner], [['example.orders'], ['example.customers']]);
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
const ref = { db: 'Local', schema: 'sales', category: 'Örnek Çalışma', name: 'Order Totals' };

test('drafts are stored under _drafts/<db>/<schema>/<category> and versioned by SQL hash', () => {
  const lib = tempLibrary();
  const a = lib.saveDraft({ ref, title: 'Order totals', sql: 'select 1' });
  assert.equal(a.version, 1);
  assert.ok(a.paths.sql.endsWith(path.join('_drafts', 'local', 'sales', 'Örnek Çalışma', 'order-totals.sql')));
  assert.equal(lib.saveDraft({ ref, sql: 'select 1' }).version, 1, 'same SQL, same version');
  assert.equal(lib.saveDraft({ ref, sql: 'select 2', note: 'changed' }).version, 2);
  const meta = lib.readMeta('draft', ref);
  assert.deepEqual(meta.sqlVersions.map(v => v.version), [1, 2]);
  assert.equal(meta.sqlVersions[1].hash, sqlHash('select 2'));
  assert.equal(lib.locate(ref), 'draft');
});

// The normalization every release before this one used: kept here so the
// tests can prove ordinary SQL still saves and hashes exactly the same.
const previousNormalize = sql => String(sql).replace(/\r\n/g, '\n').trim();
const previousHash = sql => crypto.createHash('sha256').update(previousNormalize(sql)).digest('hex').slice(0, 12);

test('saving keeps CRLF inside literals, quoted identifiers and dollar bodies, and the hash tells them apart', () => {
  const lib = tempLibrary();
  const cases = [
    ["SELECT 'left\r\nright' AS value\r\nFROM example.orders", "SELECT 'left\r\nright' AS value\nFROM example.orders"],
    ["SELECT E'left\r\nright'\r\n'more' AS value", "SELECT E'left\r\nright'\n'more' AS value"],
    ['SELECT 1 AS "left\r\nright"\r\nFROM example.orders', 'SELECT 1 AS "left\r\nright"\nFROM example.orders'],
    ['SELECT $x$left\r\nright$x$ AS value\r\n', 'SELECT $x$left\r\nright$x$ AS value'],
  ];
  for (const [sql, stored] of cases) {
    const saved = lib.saveDraft({ ref: { ...ref, name: 'example-newlines' }, sql });
    assert.equal(fs.readFileSync(saved.paths.sql, 'utf8'), stored + '\n', JSON.stringify(sql));
    assert.equal(saved.hash, sqlHash(stored), 'the stored text hashes like the input');
    assert.notEqual(sqlHash(sql), sqlHash(sql.replace(/\r\n/g, '\n')), `different literal values, different hash: ${JSON.stringify(sql)}`);
  }
});

test('ordinary SQL with CRLF outside literals saves and hashes exactly as before', () => {
  // Hashes pinned from the previous release: stored approvals keep matching.
  const pinned = {
    "SELECT order_id,\r\n  customer_id -- note\r\nFROM example.orders /* first\r\n second */\r\nWHERE status_code = 'A'\r\n": '09c501bd8e1f',
    "SELECT E'a'\r\n'b', 'c'\r\n'd' AS \"value\", $x$ body $x$\r\nFROM example.orders\r\n": 'bcc9802c461b',
  };
  for (const [sql, hash] of Object.entries(pinned)) assert.equal(sqlHash(sql), hash, JSON.stringify(sql));
  const ordinary = [
    ...Object.keys(pinned),
    'select 1',
    '\r\n  SELECT customer_id, count(*)\r\n  FROM example.orders\r\n  GROUP BY customer_id\r\n\r\n',
    "SELECT 'no newline here', \"customerId\", $$plain$$\r\nFROM example.orders o\r\nJOIN example.customers c ON c.customer_id = o.customer_id",
    '/* block\r\ncomment */ SELECT 1 -- trailing\r\n',
    "SELECT E'a'\r\n-- a comment between fragments\r\n'b'",
    'SELECT 1\rFROM example.orders\n',
    "SELECT 'unterminated\r\nliteral",
    'SELECT \'it\'\'s\', E\'a\\\'b\'\r\nFROM example.orders',
  ];
  const lib = tempLibrary();
  for (const sql of ordinary) {
    assert.equal(sqlHash(sql), previousHash(sql), JSON.stringify(sql));
    assert.equal(sqlHash(sql.replace(/\r\n/g, '\n')), sqlHash(sql), `LF and CRLF line ends hash alike: ${JSON.stringify(sql)}`);
    if (sql.includes('unterminated')) continue; // the guard refuses it before saving
    const saved = lib.saveDraft({ ref: { ...ref, name: 'example-ordinary' }, sql });
    assert.equal(fs.readFileSync(saved.paths.sql, 'utf8'), previousNormalize(sql) + '\n', JSON.stringify(sql));
  }
});

test('drafts must be read-only SQL', () => {
  assert.throws(() => tempLibrary().saveDraft({ ref, sql: 'delete from t' }), SqlGuardError);
});

test('approve moves the draft into SELECT and prunes empty draft folders', () => {
  const lib = tempLibrary();
  lib.saveDraft({ ref, sql: 'select 1' });
  lib.appendRun('draft', ref, { at: new Date().toISOString(), sqlHash: sqlHash('select 1'), durationMs: 5, rows: 1, warnings: [] }, null);
  const res = lib.approve(ref);
  assert.equal(res.meta.status, 'approved');
  assert.equal(res.meta.approvedVersion, 1);
  assert.equal(lib.exists('draft', ref), false);
  assert.equal(lib.exists('approved', ref), true);
  assert.equal(fs.existsSync(path.join(lib.root, '_drafts', 'local')), false);
  assert.equal(lib.locate(ref), 'approved');
  assert.throws(() => lib.approve(ref), /No draft/);
  assert.deepEqual(lib.list().map(i => `${i.stage}:${i.db}/${i.schema}/${i.category}/${i.name}`), ['approved:local/sales/Örnek Çalışma/order-totals']);
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
  ['psql text inside quotes and comments', String.raw`BEGIN; SELECT '\gexec', E'\\gexec', $$\gexec$$, $x$\i file.sql$x$ AS "\gexec"; /* \i file.sql */ -- \gexec
ROLLBACK;`],
  ['psql text inside a non-ASCII dollar quote', String.raw`BEGIN; SELECT $Türk$\gexec$Türk$; ROLLBACK;`],
  ['an UPDATE without WHERE inside a function body', 'BEGIN;\nCREATE OR REPLACE FUNCTION s.f() RETURNS void LANGUAGE sql AS $$ UPDATE t SET a = 1; DELETE FROM t; COMMIT; $$;\nROLLBACK;'],
  ['a plpgsql trigger function with nested dollar tags', `BEGIN;
CREATE OR REPLACE FUNCTION s.t_log() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = s, pg_temp
AS $fn$
BEGIN
  PERFORM $$ ROLLBACK; $$;
  EXECUTE $q$UPDATE s.t SET a = 1$q$;
  UPDATE s.t SET a = 1;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER t_log_trg BEFORE INSERT OR UPDATE OF a ON s.t FOR EACH ROW EXECUTE FUNCTION s.t_log();
CREATE OR REPLACE TRIGGER t_upd AFTER UPDATE ON s.t FOR EACH ROW WHEN (OLD.a IS DISTINCT FROM NEW.a) EXECUTE FUNCTION s.t_log();
CREATE CONSTRAINT TRIGGER t_chk AFTER DELETE OR UPDATE ON s.t DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION s.t_log();
ROLLBACK;`],
  ['odd dollar tags', 'BEGIN; CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $_$ SELECT 1 $_$; CREATE FUNCTION g() RETURNS text LANGUAGE sql\nAS -- body\n$Türk_1$ SELECT $x$;$x$ $Türk_1$; ROLLBACK;'],
];

test('function bodies are counted and the saved file says they are not linted', () => {
  const sql = 'BEGIN;\nCREATE FUNCTION s.f() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE t SET a = 1; END $fn$;\nROLLBACK;';
  const lint = lintExecuteScript(sql);
  assert.equal(lint.functionBodies, 1);
  assert.deepEqual(lint.warnings, []);
  const called = lintExecuteScript(sql.replace('ROLLBACK;', 'SELECT s.F ();\nROLLBACK;'));
  assert.deepEqual(called.errors, []);
  assert.match(called.warnings.join(' '), /Statement 3 calls f\(\), created in this script; its body was not linted/);
  assert.equal(lintExecuteScript(validScripts.at(-2)[1]).functionBodies, 1);
  assert.match(lintExecuteScript(validScripts.at(-2)[1]).warnings.join(' '), /SECURITY DEFINER/);
  const lib = tempLibrary();
  const text = fs.readFileSync(lib.saveExecuteScript({ ref, sql }).file, 'utf8');
  assert.ok(text.split('\n').includes('-- NOTE: function bodies are not linted by Auspex; review them before COMMIT'));
  const plain = fs.readFileSync(lib.saveExecuteScript({ ref: { ...ref, name: 'plain' }, sql: 'BEGIN; SELECT 1; ROLLBACK;' }).file, 'utf8');
  assert.ok(!plain.includes('function bodies'));
});

test('calls of quoted function names created in the script are warned about', () => {
  const quoted = lintExecuteScript('BEGIN;\nCREATE FUNCTION "wipe"() RETURNS void LANGUAGE sql AS $$ DELETE FROM t $$;\nSELECT "wipe"();\nSELECT s.wipe ();\nROLLBACK;');
  assert.deepEqual(quoted.errors, []);
  assert.match(quoted.warnings.join(' | '), /Statement 3 calls wipe\(\)/);
  assert.match(quoted.warnings.join(' | '), /Statement 4 calls wipe\(\)/);
  const mixed = lintExecuteScript('BEGIN;\nCREATE FUNCTION s."Wipe"() RETURNS void LANGUAGE sql AS $$ DELETE FROM t $$;\nSELECT s."Wipe"();\nSELECT wipe();\nROLLBACK;');
  assert.match(mixed.warnings.join(' | '), /Statement 3 calls Wipe\(\)/);
  assert.ok(!mixed.warnings.some(x => x.startsWith('Statement 4')), 'wipe() is another function than "Wipe"()');
});

test('writes after triggers or trigger functions are created warn that trigger bodies run', () => {
  const fn = 'CREATE FUNCTION s.t_log() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN DELETE FROM s.log; RETURN NEW; END $fn$;';
  const trg = 'CREATE TRIGGER t_log_trg AFTER INSERT ON s.t FOR EACH ROW EXECUTE FUNCTION s.t_log();';
  const runs = /trigger bodies were not linted and run during the dry run/;
  for (const [name, created] of [['trigger', `${fn}\n${trg}`], ['trigger function only', fn]]) {
    const lint = lintExecuteScript(`BEGIN;\nINSERT INTO s.t (a) VALUES (0);\n${created}\nSELECT * FROM s.t WHERE a = 1 FOR UPDATE;\nINSERT INTO s.t (a) VALUES (1);\nUPDATE s.t SET a = 2 WHERE a = 1;\nWITH d AS (DELETE FROM s.t WHERE a = 2 RETURNING a) SELECT count(*) FROM d;\nROLLBACK;`);
    assert.deepEqual(lint.errors, [], name);
    const warned = lint.warnings.filter(x => runs.test(x)).map(x => Number(/^Statement (\d+)/.exec(x)[1]));
    const first = created.split('\n').length + 3; // BEGIN, INSERT before, created..., SELECT FOR UPDATE
    assert.deepEqual(warned, [first + 1, first + 2, first + 3], `${name}: only writes after the creation`);
  }
  const plainFunction = lintExecuteScript('BEGIN;\nCREATE FUNCTION s.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nINSERT INTO s.t (a) VALUES (1);\nROLLBACK;');
  assert.ok(!plainFunction.warnings.some(x => runs.test(x)), 'a function that is not a trigger function does not warn');
});

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
  ['CREATE PROCEDURE', 'BEGIN; CREATE OR REPLACE PROCEDURE p() LANGUAGE sql AS $$ DELETE FROM t $$; ROLLBACK;', /creates a procedure/],
  ['a function in another language', 'BEGIN; CREATE FUNCTION f() RETURNS void LANGUAGE plpython3u AS $$ pass $$; ROLLBACK;', /LANGUAGE plpgsql or LANGUAGE sql/],
  ['a function in C', "BEGIN; CREATE FUNCTION f() RETURNS void AS 'lib', 'f' LANGUAGE c; ROLLBACK;", /LANGUAGE plpgsql or LANGUAGE sql/],
  ['a function with a quoted language', "BEGIN; CREATE FUNCTION f() RETURNS void LANGUAGE 'plpgsql' AS $$ BEGIN END $$; ROLLBACK;", /LANGUAGE plpgsql or LANGUAGE sql/],
  ['a function without a language', 'BEGIN; CREATE FUNCTION f() RETURNS void AS $$ SELECT 1 $$; ROLLBACK;', /LANGUAGE plpgsql or LANGUAGE sql/],
  ['a function with a single-quoted body', "BEGIN; CREATE FUNCTION f() RETURNS void LANGUAGE sql AS 'DELETE FROM t'; ROLLBACK;", /dollar-quoted body/],
  ['a function with a SQL-standard RETURN body', 'BEGIN; CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql RETURN a + 1; ROLLBACK;', /dollar-quoted body/],
  ['a write after a function body in the same script', 'BEGIN; CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $a$ SELECT 1 $a$; UPDATE t SET a = 1; ROLLBACK;', /Statement 3 has an UPDATE without WHERE/],
  ['the same UPDATE outside a function body', 'BEGIN;\nUPDATE t SET a = 1;\nROLLBACK;', /an UPDATE without WHERE/],
  ['DO block with a dollar tag', 'BEGIN; DO $body$ BEGIN UPDATE t SET a = 1 WHERE id = 1; END $body$; ROLLBACK;', /DO block/],
  ['COMMIT after a function', 'BEGIN; CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$; COMMIT;', /COMMIT is never written/],
  ['an unterminated function body', 'BEGIN; CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $fn$ SELECT 1 $f$; ROLLBACK;', /Unterminated dollar-quoted string/],
  ['psql after a function body', 'BEGIN; CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$ \\gexec\nROLLBACK;', /backslash command/],
  ['psql meta command', 'BEGIN;\nUPDATE t SET a = 1 WHERE id = 1;\n\\commit\nROLLBACK;', /backslash command/],
  ['inline psql gexec with LF', "BEGIN;\nSELECT 'COMMIT' \\gexec\nUPDATE t SET a = 1 WHERE id = 1;\nROLLBACK;", /backslash command/],
  ['adjacent psql gexec with CRLF', "BEGIN;\r\nSELECT 'COMMIT'\\gexec\r\nUPDATE t SET a = 1 WHERE id = 1;\r\nROLLBACK;", /backslash command/],
  ['inline psql gexec with lone CR', "BEGIN;\rSELECT 'COMMIT' \\gexec\rUPDATE t SET a = 1 WHERE id = 1;\rROLLBACK;", /backslash command/],
  ['inline psql include', 'BEGIN; SELECT 1 \\i file.sql\nSELECT 1; ROLLBACK;', /backslash command/],
  ['psql after a non-ASCII dollar quote', 'BEGIN; SELECT $Türk$COMMIT$Türk$ \\gexec\nSELECT 1; ROLLBACK;', /backslash command/],
  ['COMMIT hidden after a comment ended by a lone CR', 'BEGIN;\nUPDATE t SET a = 1 WHERE id = 1; -- note\rCOMMIT;\nROLLBACK;', /COMMIT is never written/],
  ['MERGE with THEN DELETE', 'BEGIN;\nMERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE;\nROLLBACK;', /MERGE/],
  ['MERGE with THEN UPDATE', 'BEGIN;\nMERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a;\nROLLBACK;', /MERGE/],
];

for (const [name, sql, message] of invalidScripts) {
  test(`EXECUTE lint rejects ${name}`, () => {
    assert.match(lintExecuteScript(sql).errors.join(' | '), message);
  });
}

test('EXECUTE scripts reject inline psql before creating or replacing a file', () => {
  const lib = tempLibrary();
  const sql = "BEGIN;\nSELECT 'COMMIT' \\gexec\nUPDATE t SET a = 1 WHERE id = 1;\nROLLBACK;";
  const file = lib.paths('execute', ref).sql;
  assert.throws(() => lib.saveExecuteScript({ ref, sql }), /psql backslash command/);
  assert.equal(fs.existsSync(file), false);

  lib.saveExecuteScript({ ref, sql: 'BEGIN; SELECT 1; ROLLBACK;' });
  const original = fs.readFileSync(file, 'utf8');
  assert.throws(() => lib.saveExecuteScript({ ref, sql, replace: true }), /psql backslash command/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('EXECUTE scripts get a header and are not overwritten by accident', () => {
  const lib = tempLibrary();
  const r = lib.saveExecuteScript({ ref, purpose: 'fix totals', sql: 'BEGIN;\nUPDATE t SET a = 1 WHERE id = 2;\nROLLBACK;' });
  const text = fs.readFileSync(r.file, 'utf8');
  assert.ok(r.file.includes(path.join('EXECUTE', 'local', 'sales', 'Örnek Çalışma')));
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

// ---------- script roots (temporary folders only) ----------
const fixSql = 'BEGIN;\nUPDATE t SET a = 1 WHERE id = 2;\nROLLBACK;';
function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-root-test-'));
  return { root: 'scripts', dir, real: fs.realpathSync.native(dir) };
}
const target = (r, folder, fileName) => ({ root: r.root, dir: r.dir, folder, fileName });

test('a script saved into a script root is a new file there and keeps its library record', () => {
  const lib = tempLibrary();
  const r = tempRoot();
  const res = lib.saveExecuteScript({ ref, sql: fixSql, target: target(r, 'example_scripts', '00_orders_preflight.sql') });
  const expected = path.join(r.real, 'example_scripts', '00_orders_preflight.sql');
  assert.equal(res.file, expected);
  assert.equal(res.externalFile, expected);
  assert.equal(res.libraryFile, lib.paths('execute', ref).sql);
  const text = fs.readFileSync(expected, 'utf8');
  assert.equal(fs.readFileSync(res.libraryFile, 'utf8'), text, 'the library copy is the same script');
  assert.ok(text.includes(`-- Script file    : ${expected}`));
  assert.deepEqual(lintExecuteScript(text).errors, []);
  const [item] = lib.list();
  assert.equal(item.stage, 'execute');
  assert.equal(item.externalFile, expected);
  assert.equal(lib.executeInfo(ref).folder, 'example_scripts');
});

test('a script root file is never overwritten; the error offers the next number', () => {
  const lib = tempLibrary();
  const r = tempRoot();
  lib.saveExecuteScript({ ref, sql: fixSql, target: target(r, 'Topic_V1', '02_fix_preview.sql') });
  const file = path.join(r.real, 'Topic_V1', '02_fix_preview.sql');
  const before = fs.readFileSync(file, 'utf8');
  const other = { ...ref, name: 'other' };
  assert.throws(() => lib.saveExecuteScript({ ref: other, sql: fixSql, target: target(r, 'Topic_V1', '02_fix_preview.sql') }), /already exists.*never overwrites it; choose a new file name, for example starting with 03_./s);
  assert.throws(() => lib.saveExecuteScript({ ref: other, sql: fixSql, replace: true, target: target(r, 'Topic_V1', '02_fix_preview.sql') }), /never overwrites/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(lib.exists('execute', other), false, 'nothing is written to the library either');
});

test('without numbered files in the folder the error suggests no number', () => {
  const lib = tempLibrary();
  const r = tempRoot();
  lib.saveExecuteScript({ ref, sql: fixSql, target: target(r, 'example', 'fix_orders.sql') });
  const other = { ...ref, name: 'other' };
  assert.throws(() => lib.saveExecuteScript({ ref: other, sql: fixSql, target: target(r, 'example', 'fix_orders.sql') }),
    err => /already exists.*never overwrites it; choose a new file name\.$/s.test(err.message) && !/starting with/.test(err.message));
});

test('script root checks run before anything is written', () => {
  const lib = tempLibrary();
  const r = tempRoot();
  assert.throws(() => lib.saveExecuteScript({ ref, sql: 'UPDATE t SET a = 1;', target: target(r, 'New_V1', '00_x.sql') }), /rejected/);
  assert.deepEqual(fs.readdirSync(r.dir), [], 'lint failed: no folder created');
  const missing = { ...target(r, 'New_V1', '00_x.sql'), dir: path.join(r.dir, 'missing') };
  assert.throws(() => lib.saveExecuteScript({ ref, sql: fixSql, target: missing }), err => err.errorCode === 'NOT_FOUND' && /does not exist/.test(err.message));
  assert.equal(fs.existsSync(missing.dir), false, 'the root itself is never created');
  lib.saveExecuteScript({ ref, sql: fixSql });
  assert.throws(() => lib.saveExecuteScript({ ref, sql: fixSql, target: target(r, 'New_V1', '00_x.sql') }), /Pass replace=true/);
  assert.deepEqual(fs.readdirSync(r.dir), [], 'library name taken: no folder created');
});

const badScriptNames = [
  ['parent reference', '..', '00_x.sql'],
  ['double dot inside', 'a..b', '00_x.sql'],
  ['three folder levels', 'a/b/c', '00_x.sql'],
  ['a parent reference between levels', 'a/../b', '00_x.sql'],
  ['a parent reference as second level', 'a/..', '00_x.sql'],
  ['an empty level', 'a//b', '00_x.sql'],
  ['a trailing slash', 'a/', '00_x.sql'],
  ['an absolute folder', '/a', '00_x.sql'],
  ['backslash', 'a\\b', '00_x.sql'],
  ['drive', 'C:', '00_x.sql'],
  ['drive path', 'C:/a', '00_x.sql'],
  ['space', 'a b', '00_x.sql'],
  ['leading dot', '.hidden', '00_x.sql'],
  ['trailing dot', 'x.', '00_x.sql'],
  ['reserved device name', 'CON', '00_x.sql'],
  ['too long', 'a'.repeat(81), '00_x.sql'],
  ['file not .sql', 'Topic', '00_x.txt'],
  ['file with separator', 'Topic', '../00_x.sql'],
  ['empty file name', 'Topic', ''],
];

for (const [name, folder, fileName] of badScriptNames) {
  test(`script root names reject ${name}`, () => {
    const lib = tempLibrary();
    const r = tempRoot();
    assert.throws(() => lib.saveExecuteScript({ ref, sql: fixSql, target: target(r, folder, fileName) }), LibraryError);
    assert.deepEqual(fs.readdirSync(r.dir), []);
  });
}

test('a folder may have two levels; both are created and checked', () => {
  const lib = tempLibrary();
  const r = tempRoot();
  const res = lib.saveExecuteScript({ ref, sql: fixSql, target: target(r, 'example/reports', '01_x.sql') });
  assert.equal(res.externalFile, path.join(r.real, 'example', 'reports', '01_x.sql'));
  assert.equal(lib.executeInfo(ref).folder, 'example/reports');
  // the first level exists now, the second is new
  const again = lib.saveExecuteScript({ ref: { ...ref, name: 'second' }, sql: fixSql, target: target(r, 'example/checks', '03_y.sql') });
  assert.equal(again.externalFile, path.join(r.real, 'example', 'checks', '03_y.sql'));
  assert.throws(() => lib.saveExecuteScript({ ref: { ...ref, name: 'third' }, sql: fixSql, target: target(r, 'example/reports', '01_x.sql') }), /already exists.*choose a new file name, for example starting with 02_./s);
});

test('a second folder level that links outside the root is refused', t => {
  const lib = tempLibrary();
  const r = tempRoot();
  fs.mkdirSync(path.join(r.dir, 'Topic'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-outside-test-'));
  try {
    fs.symlinkSync(outside, path.join(r.dir, 'Topic', 'Escape'), 'junction');
  } catch (err) {
    t.skip(`cannot create a link here: ${err.code}`);
    return;
  }
  assert.throws(() => lib.saveExecuteScript({ ref, sql: fixSql, target: target(r, 'Topic/Escape', '00_x.sql') }), /resolves outside the root/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a report query can be saved as a new file into a script root; drafts stay read-only', () => {
  const lib = tempLibrary();
  const r = tempRoot();
  const sql = 'select region, count(*) from sales.orders group by region';
  const res = lib.saveDraft({ ref, title: 'Orders by region', sql, target: target(r, 'Topic_V1/reports', '05_orders_by_region.sql') });
  const file = path.join(r.real, 'Topic_V1', 'reports', '05_orders_by_region.sql');
  assert.equal(res.externalFile, file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith(`${sql}\n`));
  assert.ok(text.split('\n').filter(l => l.trim() && !l.startsWith('--')).length === 1, 'header lines are comments');
  assert.match(text, /-- Report {9}: local\/sales\/Örnek Çalışma\/order-totals/);
  assert.deepEqual(lib.readMeta('draft', ref).externalFiles.map(e => [e.file, e.version]), [[file, 1]]);
  assert.throws(() => lib.saveDraft({ ref, sql, target: target(r, 'Topic_V1/reports', '05_orders_by_region.sql') }), /already exists.*choose a new file name, for example starting with 06_./s);
  assert.throws(() => lib.saveDraft({ ref, sql: 'delete from t', target: target(r, 'Topic_V1', '06_x.sql') }), SqlGuardError);
  assert.equal(fs.existsSync(path.join(r.real, 'Topic_V1', '06_x.sql')), false, 'guard runs before any write');
});

test('script root names allow Turkish letters, digits, _ - and .', () => {
  assert.equal(validateScriptName('example_scripts_v1.2', 'Folder'), 'example_scripts_v1.2');
  assert.equal(validateScriptName('03_örnek_kontrol.sql', 'File name', { sqlFile: true }), '03_örnek_kontrol.sql');
  assert.equal(validateScriptName('İşlem-ÇĞÖŞÜ', 'Folder'), 'İşlem-ÇĞÖŞÜ');
});

test('a folder link or junction that leaves the script root is refused', t => {
  const lib = tempLibrary();
  const r = tempRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-outside-test-'));
  try {
    fs.symlinkSync(outside, path.join(r.dir, 'Escape'), 'junction');
  } catch (err) {
    t.skip(`cannot create a link here: ${err.code}`);
    return;
  }
  assert.throws(() => lib.saveExecuteScript({ ref, sql: fixSql, target: target(r, 'Escape', '00_x.sql') }), /resolves outside the root/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a dangling link at the target file name is never followed', t => {
  const lib = tempLibrary();
  const r = tempRoot();
  fs.mkdirSync(path.join(r.dir, 'Topic'));
  const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-outside-test-')), 'victim.sql');
  try {
    fs.symlinkSync(outsideFile, path.join(r.dir, 'Topic', '00_x.sql'), 'file');
  } catch (err) {
    t.skip(`cannot create a file link here: ${err.code}`);
    return;
  }
  assert.throws(() => lib.saveExecuteScript({ ref, sql: fixSql, target: target(r, 'Topic', '00_x.sql') }), /already exists/);
  assert.equal(fs.existsSync(outsideFile), false);
});

test('replacing a script without a root drops the old external path', () => {
  const lib = tempLibrary();
  const r = tempRoot();
  lib.saveExecuteScript({ ref, sql: fixSql, target: target(r, 'Topic', '00_x.sql') });
  lib.saveExecuteScript({ ref, sql: fixSql, replace: true });
  assert.equal(lib.executeInfo(ref), null);
  assert.equal(lib.list()[0].externalFile, undefined);
  assert.ok(fs.existsSync(path.join(r.real, 'Topic', '00_x.sql')), 'the external file itself is left alone');
});

test('the report service resolves script root names and needs root, folder and fileName together', () => {
  const r = tempRoot();
  const fakeDb = { resolveProfile: name => name };
  const svc = new ReportService(fakeDb, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-lib-test-')), null, { scriptRoots: new Map([['scripts', { dir: r.dir }]]) });
  const args = { ...ref, sql: fixSql };
  const res = svc.saveExecute({ ...args, root: 'Scripts', folder: 'Topic', fileName: '00_x.sql' });
  assert.equal(res.externalFile, path.join(r.real, 'Topic', '00_x.sql'));
  assert.throws(() => svc.saveExecute({ ...args, name: 'b', root: 'other', folder: 'Topic', fileName: '01_x.sql' }), /Unknown script root "other"\. Configured: scripts/);
  assert.throws(() => svc.saveExecute({ ...args, name: 'c', root: 'scripts', folder: 'Topic' }), /go together/);
  assert.throws(() => svc.saveExecute({ ...args, name: 'd', fileName: '01_x.sql' }), /go together/);
  const plain = svc.saveExecute({ ...args, name: 'e' });
  assert.equal(plain.externalFile, null);
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

  assert.throws(() => svc.approve(ref), /no successful run/);
  await svc.run(ref);
  svc.approve(ref);
  assert.equal(svc.approvedJoinPairs('local').length, 1, 'a run of v2 makes it count');
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

test('approval needs a successful run of the current SQL', async () => {
  const { svc, fake } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  assert.throws(() => svc.approve(ref), /Version 1 .*run_report/);
  fake.failNext = true;
  await assert.rejects(svc.run(ref), /statement timeout/);
  assert.throws(() => svc.approve(ref), /no successful run/, 'a failed run does not count');
  await svc.run(ref);
  svc.save({ ...ref, sql: 'select 2' });
  assert.throws(() => svc.approve(ref), /Version 2 .*run_report/, 'a run of v1 does not count for v2');
  svc.save({ ...ref, sql: 'select 1' });
  assert.equal(svc.approve(ref).version, 1, 'reverting to a run revision is accepted');
});

test('approval refuses draft SQL that matches no saved version', () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  fs.writeFileSync(svc.library.paths('draft', ref).sql, 'select 99\n');
  assert.throws(() => svc.approve(ref), /matches no saved version/);
});

test('the slow-report fallback says whether the preview still executed the query', async () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  svc.library.appendRun('draft', ref, { at: '2026-01-01T00:00:00Z', durationMs: 45000, warnings: [] }, null);
  const withPreview = await svc.run(ref, { previewRows: 10 });
  assert.match(withPreview.note, /skipped EXPLAIN ANALYZE/);
  assert.match(withPreview.note, /still ran once to fetch 10 preview rows/);
  svc.library.appendRun('draft', ref, { at: '2026-01-01T00:00:01Z', durationMs: 45000, warnings: [] }, null);
  const noPreview = await svc.run(ref, { previewRows: 0 });
  assert.match(noPreview.note, /nothing was executed/);
});

test('a shared copy leaves out SQL, parameters, plan expressions, history and database names', async () => {
  const markers = ['SQLMARK', 'PARAMMARK', 'PLANMARK', 'MAILMARK'];
  const plan = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'customers', Schema: 'example_secret', Alias: 'c', Filter: "(note = 'PLANMARK'::text)",
    'Startup Cost': 0, 'Total Cost': 10, 'Plan Rows': 1, 'Actual Total Time': 1, 'Actual Rows': 1, 'Actual Loops': 1 }, 'Planning Time': 0.1, 'Execution Time': 1 }];
  const fake = {
    resolveProfile: n => String(n).toLowerCase(),
    async runReport(profile) {
      return { profile, serverVersion: '16.0-SRVMARK', analyzed: true, plan, explainMs: 1, previewMs: 1, previewExecuted: true,
        columns: [{ name: 'id', type: 'integer' }, { name: 'email', type: 'text' }], rows: [[1, 'MAILMARK@example.com']], rowCount: 1, truncated: false };
    },
  };
  const svc = new ReportService(fake, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-share-test-')));
  const r = { db: 'prodexample', schema: 'example_secret', category: 'Shared', name: 'customers' };
  svc.save({ ...r, title: 'Customer check', sql: "select id, email from example_secret.customers where note = 'SQLMARK' and id = $1" });
  await svc.run(r, { params: ['PARAMMARK'] });
  await svc.run(r, { params: ['PARAMMARK'] });

  const privateHtml = fs.readFileSync(svc.library.paths('draft', r).html, 'utf8');
  for (const m of ['SQLMARK', 'PARAMMARK', 'PLANMARK']) assert.ok(privateHtml.includes(m), `private copy keeps ${m}`);
  assert.equal(embedded(privateHtml).shareable, undefined, 'the report itself is the private copy (banner shown)');

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-share-out-'));
  const shared = svc.share(r, outDir);
  assert.match(path.basename(shared.file), /_customers\.share\.html$/);
  const html = fs.readFileSync(shared.file, 'utf8');
  for (const m of [...markers, 'prodexample', 'example_secret', 'SRVMARK']) assert.ok(!html.includes(m), `${m} is not in the shared copy`);
  const report = embedded(html);
  assert.equal(report.shareable, true);
  assert.deepEqual(report.runs, []);
  assert.deepEqual(report.sqlVersions, []);
  assert.deepEqual(report.last.columns.map(c => c.name), ['id', 'email']);
  assert.deepEqual(report.last.maskedColumns, ['email']);
  assert.equal(report.last.preview.length, 1);
  assert.equal(svc.share(r, outDir).file === shared.file, false, 'every share is a new file');
});

test('sharing needs a run first', () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  assert.throws(() => svc.share(ref, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-share-out-'))), /has not been run yet/);
});

test('sharing refuses results of an older SQL revision and shows the result version when current', async () => {
  const { svc } = tempService();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-share-out-'));
  svc.save({ ...ref, sql: 'select 1' });
  await svc.run(ref);
  svc.save({ ...ref, sql: 'select 2', description: 'now about v2' });
  assert.throws(() => svc.share(ref, outDir), /come from SQL v1, not the current v2; run the current version/);
  assert.deepEqual(fs.readdirSync(outDir), [], 'nothing was written');

  await svc.run(ref);
  const shared = svc.share(ref, outDir);
  assert.equal(shared.version, 2);
  const html = fs.readFileSync(shared.file, 'utf8');
  const report = embedded(html);
  assert.equal(report.last.version, 2);
  assert.ok(report.last.at);
  assert.equal(report.last.sqlHash, undefined, 'no SQL hash in the shared copy');
  assert.ok(!html.includes('select 2'), 'no SQL in the shared copy');
  assert.match(html, /Results of SQL v\{v\}, run \{at\}/, 'the shared header renders the version');

  // Back to v1 (same hash as v1): the active revision decides, the v2 result is stale.
  svc.save({ ...ref, sql: 'select 1' });
  assert.throws(() => svc.share(ref, outDir), /come from SQL v2, not the current v1/);
  await svc.run(ref);
  assert.equal(svc.share(ref, outDir).version, 1);
});

test('reverting to the SQL of the last result makes it shareable again (v1 run, v2 saved, v1 saved)', async () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  await svc.run(ref);
  svc.save({ ...ref, sql: 'select 2' });
  svc.save({ ...ref, sql: 'select 1' });
  const shared = svc.share(ref, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-share-out-')));
  assert.equal(shared.version, 1);
  assert.equal(embedded(fs.readFileSync(shared.file, 'utf8')).last.version, 1);
});

test('sharing reads the report under the library lock', async () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  await svc.run(ref);
  const lib = svc.library;
  let depth = 0;
  const reads = [];
  const locked = lib.locked.bind(lib);
  const readMeta = lib.readMeta.bind(lib);
  lib.locked = fn => locked(() => { depth++; try { return fn(); } finally { depth--; } });
  lib.readMeta = (...a) => { reads.push(depth > 0); return readMeta(...a); };
  svc.share(ref, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-share-out-')));
  assert.ok(reads.length > 0 && reads.every(Boolean), 'every metadata read happened while holding the lock');
});

// External review, package A: masking tightened after a run, and SQL files
// changed outside save_report.
function personService(columns, rows) {
  const fake = {
    calls: 0,
    resolveProfile: name => String(name).toLowerCase(),
    async runReport(profile) {
      fake.calls++;
      return { profile, serverVersion: '16.0', analyzed: true, plan: analyzedPlan, explainMs: 1, previewMs: 1, previewExecuted: true, columns, rows, rowCount: rows.length, truncated: false };
    },
  };
  return { svc: new ReportService(fake, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-mask-test-'))), fake };
}

test('a share after tightening mask/unmask never contains the value the old run left unmasked', async () => {
  const value = 'synthetic@example.invalid';
  const { svc } = personService([{ name: 'id', type: 'integer' }, { name: 'email', type: 'text' }, { name: 'note_text', type: 'text' }], [[1, value, 'NOTEMARK visible']]);
  svc.save({ ...ref, sql: 'select id, email, note_text from example.customers', unmask: ['email'] });
  await svc.run(ref);
  assert.equal(svc.library.readMeta('draft', ref).last.preview[0][1], value, 'the run kept email unmasked as asked');

  svc.save({ ...ref, sql: 'select id, email, note_text from example.customers', unmask: [], mask: ['email', 'note_text'] });
  const html = fs.readFileSync(svc.share(ref, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-share-out-'))).file, 'utf8');
  assert.ok(!html.includes(value), 'the old unmasked email is not shared');
  assert.ok(!html.includes('NOTEMARK'), 'a column masked after the run is masked in the share');
  assert.deepEqual(embedded(html).last.maskedColumns.sort(), ['email', 'note_text']);
});

test('a column masked at run time stays masked in a share after it is unmasked', async () => {
  const { svc } = personService([{ name: 'email', type: 'text' }], [['synthetic@example.invalid']]);
  svc.save({ ...ref, sql: 'select email from example.customers' });
  await svc.run(ref);
  svc.save({ ...ref, sql: 'select email from example.customers', unmask: ['email'] });
  const html = fs.readFileSync(svc.share(ref, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-share-out-'))).file, 'utf8');
  assert.ok(!html.includes('synthetic@example.invalid'), 'unmasking later cannot reveal what the run masked');
  assert.deepEqual(embedded(html).last.maskedColumns, ['email']);
});

test('an approved report whose SQL file was edited outside save_report is refused before any database call', async () => {
  const { svc, fake } = tempService();
  let calls = 0;
  const runReport = fake.runReport.bind(fake);
  fake.runReport = (...a) => { calls++; return runReport(...a); };
  svc.save({ ...ref, sql: 'select 1 as email' });
  await svc.run(ref);
  svc.approve(ref);
  calls = 0;
  fs.writeFileSync(svc.library.paths('approved', ref).sql, 'select 999 as email\n');
  await assert.rejects(svc.run(ref, { stage: 'approved' }), err => err.errorCode === 'PRECONDITION_FAILED' && /changed outside save_report.*approved again/.test(err.message));
  await assert.rejects(svc.run(ref), /changed outside save_report/, 'the default lookup refuses it too');
  assert.equal(calls, 0, 'nothing reached the database');
});

test('a draft whose SQL file was edited outside save_report is refused; saving it makes it runnable', async () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  fs.writeFileSync(svc.library.paths('draft', ref).sql, 'select 1 /* edited */\n');
  await assert.rejects(svc.run(ref), /not its saved active revision/);
  svc.save({ ...ref, sql: 'select 1 /* edited */' });
  assert.equal((await svc.run(ref)).version, 2);
});

test('an approved report runs only its approved revision, even when the file holds another saved one', async () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  await svc.run(ref);
  svc.approve(ref);
  const p = svc.library.paths('approved', ref);
  const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
  meta.sqlVersions.push({ version: 2, hash: sqlHash('select 2'), savedAt: meta.approvedAt, note: null, sql: 'select 2' });
  meta.activeHash = sqlHash('select 2');
  meta.activeVersion = 2;
  fs.writeFileSync(p.meta, JSON.stringify(meta));
  fs.writeFileSync(p.sql, 'select 2\n');
  await assert.rejects(svc.run(ref, { stage: 'approved' }), /holds v2, but v1 was approved/);
});

test('a report saved before activeHash existed still runs any saved revision', async () => {
  const { svc } = tempService();
  svc.save({ ...ref, sql: 'select 1' });
  const p = svc.library.paths('draft', ref);
  const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
  delete meta.activeHash;
  delete meta.activeVersion;
  fs.writeFileSync(p.meta, JSON.stringify(meta));
  assert.equal((await svc.run(ref)).version, 1);
  fs.writeFileSync(p.sql, 'select 3\n');
  await assert.rejects(svc.run(ref), /not its saved active revision/, 'unknown SQL is refused without activeHash too');
});
