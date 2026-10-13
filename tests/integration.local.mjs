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
import { listSchemas, listTables, describeTable, search } from '../src/catalog.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-it-'));
const env = { ...process.env, AUSPEX_DATA_DIR: dataDir };
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

test('estimated_rows is null when the table was never analyzed, never a false 0', async () => {
  const stats = await raw("select reltuples from pg_class where oid = 'auspex_test.worker'::regclass");
  const { tables } = await listTables(db, 'local', 'auspex_test', 'worker');
  const worker = tables.find(t => t.name === 'worker');
  if (stats.rows[0].reltuples < 0) assert.equal(worker.estimated_rows, null);
  else assert.equal(worker.estimated_rows, String(Math.round(stats.rows[0].reltuples)));
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
  await assert.rejects(db.query('local', 'select * from auspex_test.secret_note'), /permission denied/);
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
      /statement timeout|canceling statement/);
  } finally {
    await fast.close();
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
