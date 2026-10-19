import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlyQuery, SqlGuardError } from '../src/sqlGuard.js';

// PostgreSQL consumes an SCONST after UESCAPE. Escape strings and newline
// continuations can produce that token too, not just a plain '!' literal.
const escapeClauses = [
  ["escape string", "E'!'"],
  ["lowercase escape prefix", "e'!'"],
  ["hex escape", String.raw`E'\x21'`],
  ["octal escape", String.raw`E'\041'`],
  ["newline continuation", "'!'\n''"],
  ["line-comment continuation", "'!' -- example\r\n''"],
  ["several continuations", "'!'\n''\n''"],
];

for (const [name, escapeClause] of escapeClauses) {
  test(`rejects a forbidden function hidden by a UESCAPE ${name}`, () => {
    const sql = `select pg_catalog.U&"pg!005fadvisory!005flock" UESCAPE ${escapeClause} (1)`;
    assert.throws(() => assertReadOnlyQuery(sql), SqlGuardError);
  });
}

test('rejects an escape-string UESCAPE even when the function name needs no decoding', () => {
  assert.throws(() => assertReadOnlyQuery(`select U&"pg_sleep" UESCAPE E'!' (1)`), SqlGuardError);
});

test('still rejects dollar-quoted and malformed UESCAPE literals', () => {
  for (const escapeClause of ['$$!$$', '$example$!$example$', "'!!'", "''"]) {
    assert.throws(() => assertReadOnlyQuery(`select U&"pg_sleep" UESCAPE ${escapeClause} (1)`), SqlGuardError);
  }
});

test('preserves ordinary UESCAPE identifiers and safe function calls', () => {
  for (const sql of [
    `select U&"example!005fid" UESCAPE '!' from example.orders`,
    `select U&"lo!0077er" UESCAPE /* example */ '!' ('EXAMPLE')`,
    `select U&"example!005fid" -- example\nUESCAPE '!' from example.orders`,
  ]) {
    assert.equal(assertReadOnlyQuery(sql), sql);
  }
});

test('still rejects a forbidden function with a plain UESCAPE literal', () => {
  assert.throws(() => assertReadOnlyQuery(`select U&"pg!005fsleep" UESCAPE '!' (1)`), SqlGuardError);
});
