// Integration test against the local test database created by
// scripts/local-test-setup.sql. Not part of `npm test`; run with:
//   npm run test:local
// Requires a "local" profile pointing at postgresql://Auspex@localhost:5432/postgres,
// either in the profiles file or as AUSPEX_DB_LOCAL (then the file is ignored
// here), and the Auspex password in pgpass.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { ReadOnlyDatabase } from '../src/db.js';
import { classifyError } from '../src/errors.js';
import { listSchemas, listTables, describeTable, describeTables, describeFunctions, profileTables, relationStats, search, summarizeDescribedTable, estimatedRowsSql } from '../src/catalog.js';
import { ReportService } from '../src/reports/service.js';
import { SchemaMemory } from '../src/memory/store.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-it-'));
// This file makes far more than the default 60 database calls per minute on
// one profile; the budget itself is tested below with its own instance.
const env = { ...process.env, AUSPEX_DATA_DIR: dataDir, AUSPEX_MAX_QUERIES_PER_MINUTE: '10000', AUSPEX_MAX_QUERIES_PER_MINUTE_LOCAL: '10000' };
if (env.AUSPEX_DB_LOCAL) env.AUSPEX_PROFILES_FILE = path.join(dataDir, 'no-profiles.json');
const config = loadConfig(env);
if (!config.profiles.has('local')) {
  console.error(`No "local" profile in ${config.profilesFile} or AUSPEX_DB_LOCAL; see the header of this file.`);
  process.exit(1);
}
const db = new ReadOnlyDatabase(config);
after(() => db.close());

// Runs SQL directly on the read-only connection, bypassing sqlGuard, to prove
// the database-side layers hold on their own.
const raw = sql => db.withReadOnly('local', client => client.query(sql));

test('connects as Auspex in a read-only transaction', async () => {
  const res = await raw("select current_user as u, current_setting('transaction_read_only') as ro");
  assert.equal(res.rows[0].u, 'Auspex');
  assert.equal(res.rows[0].ro, 'on');
});

test('list_schemas shows auspex_test', async () => {
  const { schemas } = await listSchemas(db, 'local');
  const s = schemas.find(x => x.schema === 'auspex_test');
  assert.ok(s, 'auspex_test missing');
  assert.equal(s.can_use, true);
});

test('list_tables reports privileges', async () => {
  const { tables } = await listTables(db, 'local', 'auspex_test');
  const byName = Object.fromEntries(tables.map(t => [t.name, t]));
  assert.equal(byName.worker.can_select, true);
  assert.equal(byName.secret_note.can_select, false);
  assert.equal(byName.v_worker_region.kind, 'view');
});

test('estimated_rows is reltuples, else the live row count, else 0 only after a vacuum or analyze, never a false 0', async () => {
  const stats = await raw(`select reltuples, pg_stat_get_live_tuples(oid) as live,
    coalesce(pg_stat_get_last_analyze_time(oid), pg_stat_get_last_autoanalyze_time(oid),
             pg_stat_get_last_vacuum_time(oid), pg_stat_get_last_autovacuum_time(oid)) is not null as analyzed
    from pg_class where oid = 'auspex_test.worker'::regclass`);
  const { reltuples, live, analyzed } = stats.rows[0];
  const expected = reltuples > 0 ? String(Math.round(reltuples)) : Number(live) > 0 ? String(live) : analyzed ? '0' : null;
  const { tables } = await listTables(db, 'local', 'auspex_test', 'worker');
  const worker = tables.find(t => t.name === 'worker');
  assert.equal(worker.estimated_rows, expected);
  assert.notEqual(worker.estimated_rows, '0', 'the fixture table has rows: never shown as empty');
  const found = await search(db, 'local', 'worker', 'auspex_test', false);
  assert.equal(found.relations.find(r => r.relation === 'worker').estimated_rows, worker.estimated_rows);
});

test('describe_table returns columns, FK and incoming references', async () => {
  const worker = await describeTable(db, 'local', 'auspex_test', 'worker');
  assert.deepEqual(worker.columns.map(c => c.column), ['id', 'region_id', 'full_name', 'daily_wage', 'started_on', 'note']);
  assert.ok(worker.constraints.some(c => c.type === 'foreign key'));
  const region = await describeTable(db, 'local', 'auspex_test', 'region');
  assert.ok(region.referencedBy.some(r => r.from_table === 'auspex_test.worker'));
  const view = await describeTable(db, 'local', 'auspex_test', 'v_worker_region');
  assert.match(view.viewDefinition, /join/i);
});

test('describe_table returns key columns and referenced tables explicitly, and memory records them', async () => {
  const worker = await describeTable(db, 'local', 'auspex_test', 'worker');
  assert.equal(worker.kind, 'table');
  assert.equal(typeof worker.oid, 'number');
  assert.deepEqual(worker.columns.map(c => c.attnum), [1, 2, 3, 4, 5, 6]);
  const fk = worker.constraints.find(c => c.type === 'foreign key');
  assert.deepEqual([fk.columns, fk.ref_schema, fk.ref_table, fk.ref_columns], [['region_id'], 'auspex_test', 'region', ['id']]);
  const region = await describeTable(db, 'local', 'auspex_test', 'region');
  const incoming = region.referencedBy.find(r => r.from_name === 'worker');
  assert.deepEqual([incoming.from_schema, incoming.columns, incoming.ref_columns], ['auspex_test', ['region_id'], ['id']]);

  const memory = new SchemaMemory(path.join(dataDir, 'memory'));
  assert.equal(memory.recordDescribe(worker).recorded, 'first time');
  assert.equal(memory.recordDescribe(await describeTable(db, 'local', 'auspex_test', 'worker')).changesSinceLast, undefined);
  assert.deepEqual(memory.knowledge('local', 'auspex_test', 'worker').relations.fk, ['region_id -> auspex_test.region(id)']);
});

test('query returns rows with Turkish text, dates as written, and params', async () => {
  const res = await db.query('local', 'select id, full_name, started_on, daily_wage from auspex_test.worker where region_id = $1 order by id', [3]);
  assert.deepEqual(res.columns, ['id', 'full_name', 'started_on', 'daily_wage']);
  assert.deepEqual(res.rows, [[4, 'Ali Öztürk', '2026-04-20', '980.75'], [5, 'Fatma Şahin', '2026-05-25', null]]);
  assert.equal(res.truncated, false);
});

test('query truncates at maxRows', async () => {
  const res = await db.query('local', 'select g from generate_series(1, 50) g', [], 10);
  assert.equal(res.rowCount, 10);
  assert.equal(res.truncated, true);
});

test('query on a table without grant is denied by the database', async () => {
  await assert.rejects(db.query('local', 'select * from auspex_test.secret_note'), err => /permission denied/.test(err.message) && classifyError(err).code === 'PERMISSION_DENIED');
});

test('direct writes are blocked by the database even without sqlGuard', async () => {
  await assert.rejects(raw("insert into auspex_test.region values (99, 'x')"), /read-only transaction|permission denied/);
  await assert.rejects(raw('update auspex_test.worker set daily_wage = 0'), /read-only transaction|permission denied/);
  await assert.rejects(raw('delete from auspex_test.worker'), /read-only transaction|permission denied/);
  await assert.rejects(raw('create table auspex_test.x (a int)'), /read-only transaction|permission denied/);
  await assert.rejects(raw('create temp table x (a int)'), /read-only transaction|permission denied/);
});

test('turning read-only off still leaves no write privilege', async () => {
  const attempt = db.withReadOnly('local', async client => {
    await client.query('rollback');
    await client.query('begin');
    await client.query('set transaction read write');
    return client.query("insert into auspex_test.region values (98, 'y')");
  });
  await assert.rejects(attempt, /permission denied/);
  const check = await raw('select count(*)::int as n from auspex_test.region');
  assert.equal(check.rows[0].n, 3);
});

test('DECLARE wrapper rejects a data-modifying CTE at the database', async () => {
  const attempt = db.withReadOnly('local', client =>
    db.declareCursor(client, 'with d as (delete from auspex_test.worker returning *) select * from d', []));
  await assert.rejects(attempt, /data-modifying|read-only transaction|permission denied/);
});

test('the local "Auspex" role passes the read-only role check against the real catalog', async () => {
  // Warnings depend on the server (an older cluster may still grant CREATE on
  // public to PUBLIC); what matters is that nothing blocks.
  const r = await db.checkProfile('local');
  assert.notEqual(r.status, 'blocked', JSON.stringify(r));
  assert.equal(r.role, 'Auspex');
  assert.deepEqual(r.blocking, []);
});

test('the query budget refuses the call over the limit without connecting', async () => {
  const audit = [];
  const limited = new ReadOnlyDatabase({ ...config, maxQueriesByProfile: new Map([['local', 2]]) }, { audit: e => audit.push(e) });
  try {
    await limited.query('local', 'select 1');
    await limited.query('local', 'select 2');
    const connects = limited.pool('local').totalCount;
    await assert.rejects(limited.query('local', 'select 3'), /Query budget exhausted for profile "local": 2 database operations in the last minute, limit 2/);
    assert.equal(limited.pool('local').totalCount, connects, 'no new connection');
    assert.match(audit.at(-1).error, /Query budget exhausted/);
  } finally {
    await limited.close();
  }
});

test('quoted and Unicode-escaped spellings of a forbidden function get the same guard decision', async () => {
  for (const sql of ['select pg_sleep(0)', 'select "pg_sleep"(0)', 'select pg_catalog."pg_sleep"(0)',
    String.raw`select U&"pg\005fsleep"(0)`]) {
    await assert.rejects(db.query('local', sql), /Function "pg_sleep" is not allowed/);
  }
  const ok = await db.query('local', 'select "lower"(\'A\') as v');
  assert.equal(ok.rows[0][0] ?? ok.rows[0].v, 'a');
});

test('spellings the server reads as pg_sleep are all rejected by the guard', async () => {
  // EXPLAIN VERBOSE (without ANALYZE) shows what PostgreSQL resolves the call
  // to without running it; raw() bypasses the guard on purpose.
  for (const sql of [
    "select U&\"pg!005fsleep\" -- comment\nUESCAPE '!' (0)",
    "select U&\"pg!005fsleep\" /* comment */ UESCAPE '!' (0)",
    'select 1 --x\r, pg_sleep(0)',
  ]) {
    const plan = (await raw(`EXPLAIN (VERBOSE) ${sql}`)).rows.map(r => r['QUERY PLAN']).join('\n');
    assert.match(plan, /pg_sleep/, `server resolves: ${JSON.stringify(sql)}`);
    await assert.rejects(db.query('local', sql), /pg_sleep|not allowed/, `guard rejects: ${JSON.stringify(sql)}`);
  }
  await assert.rejects(db.query('local', "select query_to_xml('select 1', true, false, '')"), /query_to_xml/);
});

test('extended protocol rejects stacked statements', async () => {
  const attempt = db.withReadOnly('local', client =>
    db.declareCursor(client, 'select 1; delete from auspex_test.worker', []));
  await assert.rejects(attempt, /multiple commands|syntax error/);
});

test('statement timeout cancels long queries', async () => {
  const fast = new ReadOnlyDatabase({ ...config, statementTimeoutMs: 1000 });
  try {
    await assert.rejects(
      fast.query('local', 'select count(*) from generate_series(1, 100000000) a'),
      err => /statement timeout|canceling statement/.test(err.message) && classifyError(err).code === 'TIMEOUT' && classifyError(err).sqlState === '57014');
  } finally {
    await fast.close();
  }
});

test('a connection that drops mid-query is CONNECTION_FAILED and retryable', async () => {
  // Test-only: destroy the client socket while the server is still working,
  // as a network drop would. The pool discards the broken client. The server
  // query is short, so the orphaned backend ends and frees its connection slot.
  await assert.rejects(
    db.withReadOnly('local', client => {
      const pending = client.query('select pg_sleep(0.3)');
      setTimeout(() => client.connection.stream.destroy(), 50);
      return pending;
    }),
    err => /Connection terminated/.test(err.message) && classifyError(err).code === 'CONNECTION_FAILED' && classifyError(err).retryable === true);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await raw('select 1 as ok')).rows[0].ok, 1); // the next call gets a working connection
});

test('run report with previewRows 0 and no ANALYZE does not execute the query', async () => {
  // Executing this would hit the 1 s timeout; with previewRows 0 only the plan
  // and the LIMIT 0 column probe run, so it returns at once with the columns.
  const fast = new ReadOnlyDatabase({ ...config, statementTimeoutMs: 1000 });
  const heavy = 'select count(*) as n from generate_series(1, 100000000) a -- trailing comment';
  try {
    const r = await fast.runReport('local', heavy, { analyze: false, previewRows: 0 });
    assert.equal(r.previewExecuted, false);
    assert.deepEqual(r.columns.map(c => c.name), ['n']);
    assert.deepEqual(r.rows, []);
    await assert.rejects(fast.runReport('local', heavy, { analyze: false, previewRows: 1 }), /statement timeout|canceling statement/);
  } finally {
    await fast.close();
  }
});

test('export stops at the size budget with a complete last row', async () => {
  const small = new ReadOnlyDatabase({ ...config, exportMaxBytes: 4096 });
  try {
    const r = await small.exportCsv('local', "select g as n, 'satır ' || g as ad from generate_series(1, 100000) g", [], 'budget', ',');
    assert.equal(r.stopReason, 'bytes');
    assert.equal(r.truncated, true);
    const text = fs.readFileSync(r.file, 'utf8');
    assert.ok(Buffer.byteLength(text) <= 4096 && text.endsWith('\r\n'));
    assert.equal(text.trim().split('\r\n').length, r.rowCount + 1);
  } finally {
    await small.close();
  }
});

test('the export time budget cancels a slow FETCH on the server and leaves the connection clean', async () => {
  // Rows 1-1000 come at once; from row 1001 every row runs a multi-second
  // subquery, so the second FETCH is still running at the deadline.
  const quick = new ReadOnlyDatabase({ ...config, exportMaxMs: 1500 });
  const slowTail = 'select g, case when g > 1000 then (select count(*) from generate_series(1, 50000001 + g * 0)) end as slow from generate_series(1, 1005) g';
  try {
    const started = Date.now();
    const r = await quick.exportCsv('local', slowTail, [], 'slow_tail', ',');
    const elapsed = Date.now() - started;
    assert.deepEqual([r.rowCount, r.truncated, r.stopReason], [1000, true, 'time']);
    assert.ok(elapsed < 1500 + 2000, `returned after ${elapsed} ms`);
    assert.equal(fs.readFileSync(r.file, 'utf8').trim().split('\r\n').length, 1001);
    await assert.rejects(quick.exportCsv('local', 'select count(*) from generate_series(1, 100000003)', [], 'slow_first', ','),
      /time limit .* before the first rows arrived/);
    assert.deepEqual(fs.readdirSync(config.exportDir).filter(f => f.includes('slow_first')), []);
    // The cancelled FETCHes do not run on and the pooled connections are reusable.
    const active = await quick.query('local', "select count(*)::int as n from pg_stat_activity where state = 'active' and pid <> pg_backend_pid() and (position('5000000' || '1 + g' in query) > 0 or position('10000000' || '3)' in query) > 0)");
    assert.equal(active.rows[0][0], 0);
    const pool = quick.pools.get('local');
    assert.equal(pool.totalCount - pool.idleCount, 0, 'no client is still checked out');
  } finally {
    await quick.close();
  }
});

test('explain returns a plan with params and does not execute', async () => {
  const res = await db.explain('local', 'select * from auspex_test.worker where id = $1', [1]);
  assert.match(res.plan, /Scan/);
});

test('search finds relations and columns by name and comment across schemas', async () => {
  const byName = await search(db, 'local', 'WORK');
  assert.ok(byName.relations.some(r => r.schema === 'auspex_test' && r.relation === 'worker' && r.can_select === true));
  assert.ok(byName.relations.some(r => r.relation === 'v_worker_region' && r.kind === 'view'));
  const byColumn = await search(db, 'local', 'wage');
  assert.ok(byColumn.columns.some(c => c.relation === 'worker' && c.column === 'daily_wage' && c.type === 'numeric(12,2)'));
  const byComment = await search(db, 'local', 'test regions');
  assert.ok(byComment.relations.some(r => r.relation === 'region'));
  const secret = await search(db, 'local', 'secret');
  assert.ok(secret.relations.some(r => r.relation === 'secret_note' && r.can_select === false));
});

test('search can skip columns and limit to one schema', async () => {
  const res = await search(db, 'local', 'wage', 'auspex_test', false);
  assert.deepEqual(res.columns, []);
  const none = await search(db, 'local', 'worker', 'public');
  assert.ok(!none.relations.some(r => r.relation === 'worker'));
});

test('a longer per-call timeout lets a query finish that the default would cancel', async () => {
  const fast = new ReadOnlyDatabase({ ...config, statementTimeoutMs: 1000, maxStatementTimeoutMs: 60000, maxTimeoutByProfile: new Map() });
  const heavy = 'select count(*) as n from generate_series(1, 30000000) a';
  try {
    await assert.rejects(fast.query('local', heavy), /statement timeout|canceling statement/);
    const res = await fast.query('local', heavy, [], 1, 60);
    assert.equal(res.rows[0][0], '30000000');
  } finally {
    await fast.close();
  }
});

test('explain analyze executes and reports actual timings and buffers', async () => {
  const res = await db.explain('local', 'select count(*) from auspex_test.worker where region_id = $1', [1], true);
  assert.equal(res.analyzed, true);
  assert.match(res.plan, /actual time=/);
  assert.match(res.plan, /Buffers:/);
  assert.match(res.plan, /Execution Time:/);
});

test('explain analyze is still bound by the statement timeout', async () => {
  const fast = new ReadOnlyDatabase({ ...config, statementTimeoutMs: 1000 });
  try {
    await assert.rejects(
      fast.explain('local', 'select count(*) from generate_series(1, 100000000) a', [], true),
      /statement timeout|canceling statement/);
  } finally {
    await fast.close();
  }
});

test('explain analyze cannot read a table without grant', async () => {
  await assert.rejects(db.explain('local', 'select * from auspex_test.secret_note', [], true), /permission denied/);
});

test('export_csv writes UTF-8 CSV with quoting and returns no rows', async () => {
  const res = await db.exportCsv('local', 'select id, full_name, note from auspex_test.worker order by id', [], 'workers', ';');
  assert.equal(res.rowCount, 5);
  assert.equal(res.rows, undefined);
  const text = fs.readFileSync(res.file, 'utf8');
  assert.ok(text.startsWith('﻿id;full_name;note\r\n'));
  assert.match(text, /1;Ayşe Yılmaz;"ilk; kayıt"/);
  assert.match(text, /2;Mehmet Kaya;"tırnak ""test"""/);
  assert.match(text, /4;Ali Öztürk;"satır\r?\nsonu"/); // CRLF when the setup script ran on Windows
});

test('export_csv removes the partial file when the query fails', async () => {
  await assert.rejects(db.exportCsv('local', 'select * from auspex_test.secret_note', [], 'denied', ','), /permission denied/);
  assert.deepEqual(fs.existsSync(config.exportDir) ? fs.readdirSync(config.exportDir).filter(f => f.includes('denied')) : [], []);
});

test('report library: save, run with ANALYZE, mask, render HTML, version and approve', async () => {
  const svc = new ReportService(db, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-it-lib-')));
  const ref = { db: 'local', schema: 'auspex_test', category: 'Örnek Çalışma', name: 'Workers by region' };
  svc.save({ ...ref, title: 'Workers by region', sql: 'select r.name as region, w.full_name from auspex_test.worker w join auspex_test.region r on r.id = w.region_id order by w.id' });
  const run = await svc.run(ref);
  assert.equal(run.analyzed, true);
  assert.equal(run.rows, 5);
  assert.ok(run.joins.some(j => /region_id = r\.id|r\.id = w\.region_id/.test(j)), run.joins.join());
  assert.deepEqual(run.maskedColumns, ['full_name']);
  assert.match(run.preview[0][1], /^\S\*\*\*/);
  assert.ok(fs.existsSync(run.htmlFile));
  assert.match(fs.readFileSync(run.htmlFile, 'utf8'), /"Workers by region"/);

  svc.save({ ...ref, sql: 'select count(*) as n from auspex_test.worker where region_id = $1', note: 'count only' });
  const second = await svc.run(ref, { params: [1], analyze: false });
  assert.equal(second.version, 2);
  assert.equal(second.analyzed, false);

  const approved = svc.approve(ref);
  assert.equal(approved.stage, 'approved');
  assert.ok(fs.existsSync(approved.htmlFile));
  assert.deepEqual(svc.list().map(i => i.stage), ['approved']);
});

test('report runs teach the schema memory which tables and columns were used', async () => {
  const memory = new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-it-mem-')));
  const svc = new ReportService(db, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-it-lib-')), memory);
  const ref = { db: 'local', schema: 'auspex_test', category: 'General', name: 'Wages by region' };
  svc.save({ ...ref, sql: 'select r.name, avg(w.daily_wage) from auspex_test.worker w join auspex_test.region r on r.id = w.region_id group by r.name' });
  const run = await svc.run(ref);
  assert.equal(run.memoryError, undefined);
  const worker = memory.readTable('local', 'auspex_test', 'worker');
  assert.equal(worker.describedAt, null, 'seen, not described');
  assert.deepEqual(Object.keys(worker.usedColumns).sort(), ['daily_wage', 'region_id']);
  assert.ok(memory.readTable('local', 'auspex_test', 'region').usedColumns.name);
  svc.approve(ref);
  assert.deepEqual(svc.approvedJoinPairs('local').map(p => [p.left, p.right].sort().join(' = ')), ['auspex_test.region.id = auspex_test.worker.region_id']);
});

test('report library refuses unknown databases and non-SELECT drafts', async () => {
  const svc = new ReportService(db, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-it-lib-')));
  assert.throws(() => svc.save({ db: 'nope', schema: 's', category: 'c', name: 'n', sql: 'select 1' }), /Unknown profile/);
  assert.throws(() => svc.save({ db: 'local', schema: 's', category: 'c', name: 'n', sql: 'update t set a = 1' }));
});

test('describe_tables describes region, worker and a view with a constant number of statements and records them', async () => {
  const r = await describeTables(db, 'local', ['auspex_test.region', 'auspex_test.worker', 'auspex_test.nope']);
  assert.equal(r.statements, 6);
  assert.deepEqual([r.found, r.notFound], [2, 1]);
  const [region, worker, missing] = r.tables;
  assert.match(missing.error, /auspex_test\.nope not found/);
  assert.deepEqual(worker.columns.map(c => c.column), ['id', 'region_id', 'full_name', 'daily_wage', 'started_on', 'note']);
  const fk = worker.constraints.find(c => c.type === 'foreign key');
  assert.deepEqual([fk.columns, fk.ref_schema, fk.ref_table, fk.ref_columns], [['region_id'], 'auspex_test', 'region', ['id']]);
  assert.ok(worker.indexes.some(i => i.name === 'worker_region_idx'));
  const incoming = region.referencedBy.find(x => x.from_name === 'worker');
  assert.deepEqual([incoming.from_schema, incoming.columns, incoming.ref_columns], ['auspex_test', ['region_id'], ['id']]);

  // Same structure as describe_table.
  const single = await describeTable(db, 'local', 'auspex_test', 'worker');
  assert.deepEqual(worker, single);

  const withView = await describeTables(db, 'local', ['auspex_test.worker', 'auspex_test.v_worker_region']);
  assert.equal(withView.statements, 7);
  assert.match(withView.tables[1].viewDefinition, /join/i);

  // detail "summary" is built from the same data, without more statements.
  const sWorker = summarizeDescribedTable(worker);
  assert.deepEqual(sWorker.columns, [
    'id integer not null PK', 'region_id integer not null FK -> auspex_test.region(id)', 'full_name text not null',
    'daily_wage numeric(12,2)', 'started_on date not null', 'note text',
  ]);
  assert.deepEqual(sWorker.indexes.sort(), ['worker_pkey unique (id)', 'worker_region_idx (region_id)']);
  assert.deepEqual(sWorker.constraints, ['worker_pkey PRIMARY KEY (id)']);
  const sRegion = summarizeDescribedTable(region);
  assert.deepEqual([sRegion.comment, sRegion.referencedBy.count >= 1, sRegion.referencedBy.tables.includes('auspex_test.worker(region_id)')], ['Test regions', true, true]);
  assert.ok(sRegion.constraints.includes('region_name_key UNIQUE (name)'));
  const sView = summarizeDescribedTable(withView.tables[1]);
  assert.deepEqual([sView.kind, sView.viewDefinitionOmitted, sView.viewDefinition], ['view', true, undefined]);
  const all = [region, worker, withView.tables[1]];
  const fullChars = JSON.stringify(all.map(({ profile, oid, columns, ...rest }) => ({ ...rest, columns: columns.map(({ attnum, ...c }) => c) }))).length;
  const summaryChars = JSON.stringify(all.map(summarizeDescribedTable)).length;
  console.log(`# describe_tables region, worker, v_worker_region: full ${fullChars} characters, summary ${summaryChars}`);
  assert.ok(summaryChars < fullChars);

  const memory = new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-it-batch-mem-')));
  const recorded = memory.recordDescribeMany('local', r.tables.filter(t => !t.error));
  assert.deepEqual(recorded.map(x => x.recorded), ['first time', 'first time']);
  assert.deepEqual(memory.knowledge('local', 'auspex_test', 'worker').relations.fk, ['region_id -> auspex_test.region(id)']);
});

test('profile_tables measures fill rates, distinct counts and region -> worker fan-out in 3 statements', async () => {
  const r = await profileTables(db, 'local', {
    tables: ['auspex_test.worker', 'auspex_test.secret_note', 'auspex_test.region'],
    parent: { table: 'auspex_test.region', key: 'id' },
  });
  assert.equal(r.statements, 3);
  const [worker, secret, region] = r.tables;
  assert.match(secret.error, /No SELECT privilege/);
  assert.deepEqual(worker.sample, { method: 'limit', rows: 5 });
  const byName = Object.fromEntries(worker.columns.map(c => [c.column, c]));
  assert.equal(byName.full_name.fillRate, 1);
  assert.equal(byName.daily_wage.fillRate, 0.8);
  assert.equal(byName.note.fillRate, 0.8);
  assert.equal(byName.region_id.distinctInSample, 3);
  assert.equal(byName.id.distinctInSample, 5);
  assert.deepEqual(worker.fanOut, {
    column: 'region_id', via: 'foreign key worker_region_id_fkey', parentRows: 3, parentRowsCapped: false,
    parentsWithChildren: 3, childRows: 5, avgPerParent: 1.6667, avgPerParentWithChildren: 1.6667, maxPerParent: 2,
  });
  assert.deepEqual(region.fanOut, { skipped: 'this is the parent table' });
  assert.equal(region.sample.rows, 3);
  assert.ok(!JSON.stringify(r).includes('Ayşe'), 'no row values');
});

test('profile_tables applies the parent window and the timeout', async () => {
  const r = await profileTables(db, 'local', {
    tables: ['auspex_test.worker'],
    parent: { table: 'auspex_test.region', key: 'id' },
    window: { column: 'id', from: '2', to: '4' },
    sampleRows: 100,
    timeoutSeconds: 5,
  });
  assert.deepEqual(r.tables[0].fanOut, {
    column: 'region_id', via: 'foreign key worker_region_id_fkey', parentRows: 2, parentRowsCapped: false,
    parentsWithChildren: 2, childRows: 3, avgPerParent: 1.5, avgPerParentWithChildren: 1.5, maxPerParent: 2,
  });
  const capped = await profileTables(db, 'local', { tables: ['auspex_test.worker'], parent: { table: 'auspex_test.region', key: 'id' }, sampleRows: 2 });
  assert.equal(capped.tables[0].sample.rows, 2);
  assert.equal(capped.tables[0].fanOut.parentRows, 2);
  assert.equal(capped.tables[0].fanOut.parentRowsCapped, true);
  await assert.rejects(profileTables(db, 'local', { tables: ['auspex_test.worker";select 1'] }), /Invalid table/);
});

test('profile_tables parentFilter narrows the parent rows with bound values, ANDed with the window, in 3 statements', async () => {
  const fanOut = async (parentFilter, window) => {
    const r = await profileTables(db, 'local', { tables: ['auspex_test.worker'], parent: { table: 'auspex_test.region', key: 'id' }, window, parentFilter });
    assert.equal(r.statements, 3);
    const { parentRows, childRows, maxPerParent } = r.tables[0].fanOut;
    return [parentRows, childRows, maxPerParent];
  };
  // Regions: 1 Ege (2 workers), 2 Akdeniz (1), 3 İç Anadolu (2).
  assert.deepEqual(await fanOut([{ column: 'name', op: 'in', values: ['Ege', 'Akdeniz'] }]), [2, 3, 2]);
  assert.deepEqual(await fanOut([{ column: 'id', op: '>', value: 1 }]), [2, 3, 2]);
  assert.deepEqual(await fanOut([{ column: 'id', op: 'not in', values: [1, 2] }]), [1, 2, 2]);
  assert.deepEqual(await fanOut([{ column: 'name', op: '=', value: 'İç Anadolu' }, { column: 'id', op: 'is not null' }]), [1, 2, 2]);
  assert.deepEqual(await fanOut([{ column: 'name', op: '<>', value: 'Akdeniz' }], { column: 'id', from: '2', to: '4' }), [1, 2, 2]);
  assert.deepEqual(await fanOut([{ column: 'name', op: 'is null' }]), [0, 0, 0]);
  assert.deepEqual(await fanOut([{ column: 'name', op: '=', value: "Ege' or '1'='1" }]), [0, 0, 0], 'a quote in a value is data, not SQL');
  await assert.rejects(fanOut([{ column: 'nope', op: 'is null' }]), err => err.errorCode === 'INVALID_INPUT' && /column nope not found/.test(err.message));
  await assert.rejects(fanOut([{ column: 'id', op: 'in', value: 1 }]), err => err.errorCode === 'INVALID_INPUT');
});

test('relation_stats links region and worker from planner statistics in at most 2 statements and records them', async () => {
  const r = await relationStats(db, 'local', ['auspex_test.region', 'auspex_test.worker', 'auspex_test.secret_note']);
  assert.ok(r.statements <= 2);
  const [region, worker, secret] = r.tables;
  assert.match(secret.error, /No SELECT privilege/);
  const dependent = region.dependent.find(d => d.relation === 'auspex_test.worker');
  const instance = worker.instance.find(d => d.relation === 'auspex_test.region');
  assert.deepEqual([dependent.constraint, dependent.columns, dependent.refColumns], ['worker_region_id_fkey', ['region_id'], ['id']]);
  assert.equal(instance.constraint, 'worker_region_id_fkey');
  // The setup may or may not have analyzed the tables: either way the figure
  // must match the statistics, and unknown stays null.
  const stats = (await raw(`select ${estimatedRowsSql('c')} as est, s.null_frac from pg_class c
    left join pg_stats s on s.schemaname = 'auspex_test' and s.tablename = 'worker' and s.attname = 'region_id' and not s.inherited
    where c.oid = 'auspex_test.worker'::regclass`)).rows[0];
  const expected = stats.est === null || stats.null_frac === null ? null : Math.round(Number(stats.est) * (1 - stats.null_frac));
  assert.equal(dependent.linkedRows, expected);
  assert.equal(instance.linkedRows, expected);
  assert.equal(dependent.stats, expected === null ? 'missing' : 'ok');
  // With scripts/local-test-ddl.sql, region also has import_job (analyzed) as a dependent.
  assert.equal(region.dependent[0].rank, 1);
  assert.ok(region.dependent.every((d, i) => i === 0 || d.rank >= region.dependent[i - 1].rank));
  assert.ok(region.dependent.findIndex(d => d.linkedRows === null) === -1
    || region.dependent.slice(region.dependent.findIndex(d => d.linkedRows === null)).every(d => d.linkedRows === null), 'missing figures rank last');

  const memory = new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-it-relstats-')));
  memory.recordRelationStats('local', r.tables.filter(t => !t.error));
  const edge = memory.graph('local').edges.find(e => e.from === 'auspex_test.worker' && e.to === 'auspex_test.region');
  assert.deepEqual([edge.linkedRows, edge.estimated], [expected, true]);
});

// Objects from scripts/local-test-ddl.sql. CI always applies it; on a local
// database set up before it existed these tests are skipped with a hint.
const ddlApplied = (await raw("select to_regclass('auspex_test.import_job') is not null as ok")).rows[0].ok;
const ddlTest = (name, fn) => test(name, { skip: !ddlApplied && !process.env.CI ? 'run scripts/local-test-ddl.sql once to enable' : false }, fn);

ddlTest('describe_tables shows triggers, checks, identity/serial/generated columns, partitioning and RLS in 6 statements', async () => {
  const r = await describeTables(db, 'local', ['auspex_test.import_job', 'auspex_test.import_log', 'auspex_test.import_log_2026_01', 'auspex_test.import_secret']);
  assert.equal(r.statements, 6);
  const [job, log, part, secret] = r.tables;
  assert.equal(job.comment, 'Test import staging with a before-validate trigger');
  assert.deepEqual(job.triggers.map(({ definition, ...t }) => t), [{
    name: 'import_job_validate', timing: 'BEFORE', events: ['INSERT', 'UPDATE'], level: 'ROW', enabled: 'enabled',
    function: 'auspex_test.import_job_before_validate', whenCondition: '(new.payload IS NOT NULL)',
  }]);
  assert.match(job.triggers[0].definition, /UPDATE OF payload ON auspex_test\.import_job FOR EACH ROW/);
  const cols = Object.fromEntries(job.columns.map(c => [c.column, c]));
  assert.deepEqual([cols.id.identity, cols.id.sequence, cols.id.generated], ['always', 'auspex_test.import_job_id_seq', undefined]);
  assert.deepEqual([cols.batch_no.identity, cols.batch_no.sequence], [undefined, 'auspex_test.import_job_batch_no_seq']);
  assert.equal(cols.payload_b64_length.generated, 'stored');
  assert.equal(cols.payload.type, 'jsonb');
  assert.ok(!('sequence' in cols.payload) && !('identity' in cols.payload), 'unset fields are left out');
  assert.match(job.constraints.find(c => c.name === 'import_job_status_check').definition, /CHECK .*status.*'new'/);
  assert.deepEqual(job.rowLevelSecurity, { enabled: false, forced: false });
  assert.equal(job.partitioning, undefined);
  assert.deepEqual(log.partitioning, { key: 'RANGE (logged_on)', partitions: 2 });
  assert.deepEqual(part.partitionOf, { parent: 'auspex_test.import_log', bound: "FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')" });
  assert.deepEqual(secret.rowLevelSecurity, { enabled: true, forced: false });

  const sJob = summarizeDescribedTable(job);
  assert.deepEqual(sJob.triggers, ['import_job_validate BEFORE INSERT OR UPDATE']);
  assert.ok(sJob.columns.includes('id bigint not null PK identity'), JSON.stringify(sJob.columns));
  assert.ok(sJob.columns.some(c => /^payload_b64_length \S+ generated/.test(c)));
  assert.ok(sJob.constraints.some(c => c.startsWith('import_job_status_check CHECK')));
  assert.ok(!JSON.stringify(sJob).includes('CREATE TRIGGER'), 'no trigger definitions in the summary');
  assert.deepEqual(summarizeDescribedTable(secret).rowLevelSecurity, { enabled: true, forced: false });
  assert.deepEqual(summarizeDescribedTable(log).partitioning, { key: 'RANGE (logged_on)', partitions: 2 });
});

ddlTest('describe_functions returns signature, properties, calling triggers and the capped definition in 1 statement', async () => {
  const r = await describeFunctions(db, 'local', { functions: ['auspex_test.import_job_before_validate', 'auspex_test.import_job_count', 'auspex_test.nope'] });
  assert.equal(r.statements, 1);
  assert.deepEqual([r.found, r.notFound], [2, 1]);
  const [validate, count, missing] = r.functions;
  assert.deepEqual([validate.returns, validate.language, validate.volatility, validate.kind, validate.securityDefiner, validate.truncated],
    ['trigger', 'plpgsql', 'volatile', 'function', false, false]);
  assert.deepEqual(validate.usedByTriggers, [{ table: 'auspex_test.import_job', trigger: 'import_job_validate' }]);
  assert.equal(validate.comment, 'Validates the payload before insert or update');
  assert.match(validate.definition, /NEW\.status := 'error'/);
  assert.deepEqual([count.function, count.returns, count.language, count.volatility], ['auspex_test.import_job_count(p_region integer)', 'bigint', 'sql', 'stable']);
  assert.match(missing.error, /not found/);

  const capped = await describeFunctions(db, 'local', { functions: ['auspex_test.import_job_count'], maxChars: 20 });
  assert.deepEqual([capped.functions[0].definition.length, capped.functions[0].truncated], [20, true]);
  assert.ok(capped.functions[0].definitionLength > 20);
  const byPattern = await describeFunctions(db, 'local', { pattern: 'import_job%', schema: 'auspex_test' });
  assert.deepEqual(byPattern.functions.map(f => f.name), ['import_job_before_validate', 'import_job_count']);
  assert.equal(byPattern.truncated, false);
});

ddlTest('search finds functions and triggers by name, and function source only with searchSource', async () => {
  // Text with _ or % is used as an ILIKE pattern as given, so add the %.
  const r = await search(db, 'local', 'import_job%', 'auspex_test');
  assert.ok(r.relations.some(x => x.relation === 'import_job'));
  assert.deepEqual(r.functions.map(f => [f.function, f.matchedIn]), [['import_job_before_validate', 'name'], ['import_job_count', 'name']]);
  assert.deepEqual(r.triggers, [{ schema: 'auspex_test', relation: 'import_job', trigger: 'import_job_validate', function: 'auspex_test.import_job_before_validate' }]);
  const plain = await search(db, 'local', '%jsonb_typeof%', 'auspex_test');
  assert.deepEqual(plain.functions, []);
  const source = await search(db, 'local', '%jsonb_typeof%', 'auspex_test', true, { searchSource: true });
  assert.deepEqual(source.functions.map(f => [f.function, f.matchedIn]), [['import_job_before_validate', 'source']]);
  assert.ok(!JSON.stringify(source).includes('NEW.status'), 'source text is never returned');
});

ddlTest('relation_stats on import_job: analyzed figures, partitioned dependent, hidden table', async () => {
  const r = await relationStats(db, 'local', ['auspex_test.import_job']);
  assert.equal(r.statements, 2);
  const [job] = r.tables;
  const stat = async (table, column, inherited) => (await raw(`select ${estimatedRowsSql('c')} as est, s.null_frac from pg_class c
    left join pg_stats s on s.schemaname = 'auspex_test' and s.tablename = c.relname and s.attname = '${column}' and s.inherited = ${inherited}
    where c.oid = 'auspex_test.${table}'::regclass`)).rows[0];
  const expect = s => (s.est === null || s.null_frac === null ? null : Math.round(Number(s.est) * (1 - s.null_frac)));
  const region = job.instance.find(i => i.relation === 'auspex_test.region');
  assert.equal(region.linkedRows, expect(await stat('import_job', 'region_id', false)));
  assert.equal(region.linkedRows, 3, 'the script analyzed import_job: 4 rows, one without region');
  assert.deepEqual(job.dependent.map(d => d.relation), ['auspex_test.import_log'], 'partitions and unreadable tables are not listed');
  assert.equal(job.dependent[0].linkedRows, expect(await stat('import_log', 'job_id', true)));
  assert.deepEqual(job.hidden, { instance: 0, dependent: 1 });
});
