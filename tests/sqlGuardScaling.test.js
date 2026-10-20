import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlyQuery, SqlGuardError, maxSqlLength } from '../src/sqlGuard.js';
import { ReadOnlyDatabase } from '../src/db.js';

// The guard runs before any database call, so its own work must stay linear
// in the SQL length and long input must be refused up front. Nothing here
// connects to a database.

const manyCalls = n => 'SELECT ' + Array(n).fill("length('example')").join(' + ');

test('many function calls are scanned in linear time', () => {
  const sql = manyCalls(10000); // about 200 KB; the old scan needed many seconds
  assert.ok(sql.length < maxSqlLength);
  const started = performance.now();
  assertReadOnlyQuery(sql);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 3000, `guard took ${Math.round(elapsed)} ms for ${sql.length} characters`);
});

test('a forbidden function after many allowed calls is still found', () => {
  assert.throws(() => assertReadOnlyQuery(manyCalls(5000) + ' + pg_sleep(1)'), /Function "pg_sleep" is not allowed/);
});

test('function names keep the old rules: case folding, quoting, digits and $ inside the name', () => {
  assert.throws(() => assertReadOnlyQuery('select PG_SLEEP (1)'), /pg_sleep/);
  assert.throws(() => assertReadOnlyQuery('select pg_catalog."pg_sleep"(1)'), /pg_sleep/);
  // A run that starts with digits: the name starts at its first letter, as before.
  assert.throws(() => assertReadOnlyQuery('select 1pg_sleep(1)'), /pg_sleep/);
  assert.doesNotThrow(() => assertReadOnlyQuery('select example$fn(order_id) from example.orders'));
});

test('SQL longer than the limit is refused before it is scanned', () => {
  const sql = 'select ' + 'x'.repeat(maxSqlLength);
  assert.throws(() => assertReadOnlyQuery(sql), err => err instanceof SqlGuardError && /too long/.test(err.message));
  assert.doesNotThrow(() => assertReadOnlyQuery('select 1' + ' '.repeat(maxSqlLength - 8)));
});

test('SQL that Auspex generates itself (profile_tables batches) is not held to the caller limit', async () => {
  const db = new ReadOnlyDatabase({ profiles: new Map(), maxRows: 10 }, { audit: () => {} });
  // 30 tables with 100 columns each come to about 264,000 characters.
  const sql = 'select ' + Array(12000).fill('count("example_column_x")').join(', ') + ' from example.orders';
  assert.ok(sql.length > maxSqlLength);
  const sent = [];
  await db.guardedQuery({ query: async q => { sent.push(q.text); return { rows: [] }; } }, sql, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], sql);
});

test('a run_report phase keeps an oversized saved SQL out of its audit entry too', async () => {
  const entries = [];
  const db = new ReadOnlyDatabase({ profiles: new Map(), maxRows: 10 }, { audit: entry => entries.push(entry) });
  const sql = 'select ' + 'x'.repeat(maxSqlLength);
  await assert.rejects(db.audited('run_report', { profile: 'exampledb' }, () =>
    db.auditedPhase('run_report', 'database', { sql }, async () => assertReadOnlyQuery(sql))), /too long/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sql.length, 2000);
  assert.equal(entries[0].sqlLength, sql.length);
  assert.equal(entries[0].sqlTruncated, true);
});

test('a refused oversized query is audited with its length, not its whole text', async () => {
  const entries = [];
  const db = new ReadOnlyDatabase({
    profiles: new Map([['exampledb', 'postgresql://report_reader@db.example.test:5432/exampledb']]),
    maxRows: 10,
  }, { audit: entry => entries.push(entry) });
  db.withReadOnly = async () => { throw new Error('must not reach the database'); };
  const sql = 'select ' + 'x'.repeat(maxSqlLength);
  await assert.rejects(db.query('exampledb', sql), /too long/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sql.length, 2000);
  assert.equal(entries[0].sqlLength, sql.length);
  assert.equal(entries[0].sqlTruncated, true);
  assert.equal(entries[0].errorCode, 'SQL_REJECTED');
});
