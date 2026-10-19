import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlyQuery, stripLiteralsAndComments } from '../src/sqlGuard.js';

// PostgreSQL retains the initial E prefix across newline-separated literals.
// The lock is outside the literal on the server, not a harmless string value.
for (const gap of ['\n', '\r', '\r\n', ' -- example\n', '\n-- example\n\t']) {
  test(`rejects a forbidden call after a continued escape string (${JSON.stringify(gap)})`, () => {
    const sql = `SELECT E''${gap}` + String.raw`'\' || ', pg_advisory_lock(1) --'`;
    assert.throws(() => assertReadOnlyQuery(sql), {
      errorCode: 'SQL_REJECTED',
      message: 'Function "pg_advisory_lock" is not allowed.',
    });
  });
}

test('keeps the escape mode across more than two string fragments', () => {
  const sql = String.raw`SELECT e'example'
' more'
'\' || ', pg_advisory_lock(1) --'`;
  assert.throws(() => assertReadOnlyQuery(sql), /pg_advisory_lock/);
});

test('allows forbidden-looking text inside a continued escape string', () => {
  const sql = String.raw`SELECT E'example'
'\' pg_advisory_lock(1); DELETE FROM example.orders' AS message`;
  assert.equal(assertReadOnlyQuery(sql), sql);
  const masked = stripLiteralsAndComments(sql);
  assert.equal(masked.length, sql.length);
  assert.equal(masked.indexOf(' AS message'), sql.indexOf(' AS message'));
  assert.ok(!masked.includes('pg_advisory_lock'));
});

test('preserves ordinary string continuation without enabling escapes', () => {
  const sql = String.raw`SELECT 'example'
'\', pg_advisory_lock(1) --'`;
  assert.throws(() => assertReadOnlyQuery(sql), /pg_advisory_lock/);
});

test('does not carry escape mode across a comma', () => {
  const sql = String.raw`SELECT E'example',
'\', pg_advisory_lock(1) --'`;
  assert.throws(() => assertReadOnlyQuery(sql), /pg_advisory_lock/);
});

test('does not treat block comments as escape-string continuation', () => {
  // PostgreSQL quotecontinue accepts line comments, not block comments.
  const sql = String.raw`SELECT E'example' /* example */
'\', pg_advisory_lock(1) --'`;
  assert.throws(() => assertReadOnlyQuery(sql), /pg_advisory_lock/);
});

test('rejects an unterminated continued escape string', () => {
  assert.throws(() => assertReadOnlyQuery(String.raw`SELECT E'example'
'\'`), /Unterminated string literal/);
});
