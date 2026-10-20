import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlyQuery, SqlGuardError, stripLiteralsAndComments } from '../src/sqlGuard.js';

const separators = [
  ['LF', '\n'],
  ['CR', '\r'],
  ['CRLF', '\r\n'],
  ['horizontal whitespace', ' \t\n\f '],
  ['vertical tab after the newline', '\n\v'],
  ['vertical tab before the newline', '\v\n'],
  ['line comment', " -- example's note\n"],
  ['several line comments', " -- example\r\n-- ' another note\n\t"],
];

for (const [name, separator] of separators) {
  test(`rejects a side-effect function after an escape-string continuation with ${name}`, () => {
    const sql = "select E''" + separator + String.raw`'\'' as exampleText, pg_advisory_lock(1) -- '`;
    assert.throws(() => assertReadOnlyQuery(sql), SqlGuardError);
  });
}

test('rejects a second statement after a continued escape string', () => {
  const sql = String.raw`select E''
'\'' as exampleText; select 1 -- '`;
  assert.throws(() => assertReadOnlyQuery(sql), SqlGuardError);
});

test('retains escape mode through several continuations and a lowercase prefix', () => {
  const sql = String.raw`select e'example'
'orders'
'\'' as exampleText, pg_sleep(1) -- '`;
  assert.throws(() => assertReadOnlyQuery(sql), SqlGuardError);
});

test('allows forbidden-looking text that is actually inside the continued string', () => {
  const sql = String.raw`select E'example'
'\'pg_sleep(1); delete from example.orders' as exampleText`;
  assert.equal(assertReadOnlyQuery(sql), sql);
});

test('preserves input length and quoted-function offsets after a continued string', () => {
  const sql = String.raw`select E'example'
'\'' as exampleText, "pg_sleep" (1)`;
  const identifiers = [];
  const masked = stripLiteralsAndComments(sql, identifiers);
  assert.equal(masked.length, sql.length);
  const functionName = identifiers.find(identifier => identifier.name === 'pg_sleep');
  assert.equal(functionName?.end, sql.indexOf('"pg_sleep"') + '"pg_sleep"'.length);
  assert.throws(() => assertReadOnlyQuery(sql), SqlGuardError);
});

test('does not treat quotes inside an EOF line comment as continuations', () => {
  const sql = "select E'example'\n-- ' pg_sleep(1)";
  assert.equal(assertReadOnlyQuery(sql), sql);
  assert.equal(stripLiteralsAndComments(sql).length, sql.length);
});

test('skips whole line comments before the next continued fragment', () => {
  const sql = String.raw`select E'example' -- '
-- ' pg_sleep(1)
'\'' as exampleText`;
  assert.equal(assertReadOnlyQuery(sql), sql);
});

test('does not carry escape mode past another SQL token', () => {
  const sql = String.raw`select E'example'
|| '\' as exampleText`;
  assert.equal(assertReadOnlyQuery(sql), sql);
});

test('keeps plain string backslashes literal', () => {
  const sql = String.raw`select 'example'
'\' as exampleText`;
  assert.equal(assertReadOnlyQuery(sql), sql);
});

test('rejects an unterminated escaped continuation', () => {
  assert.throws(() => assertReadOnlyQuery("select E'example'\n'\\'"), SqlGuardError);
});
