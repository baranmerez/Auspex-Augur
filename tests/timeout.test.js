import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyDatabase } from '../src/db.js';
import { toIlikePattern } from '../src/catalog.js';

const db = new ReadOnlyDatabase({
  profiles: new Map([['local', 'postgresql://u@127.0.0.1:1/a'], ['prod', 'postgresql://u@127.0.0.1:1/b']]),
  statementTimeoutMs: 30000,
  maxStatementTimeoutMs: 300000,
  maxTimeoutByProfile: new Map([['prod', 120000]]),
});

test('default timeout is used when none is given', () => {
  assert.equal(db.timeoutMs('local', undefined), 30000);
});

test('per-call timeout up to the global ceiling', () => {
  assert.equal(db.timeoutMs('local', 180), 180000);
  assert.equal(db.timeoutMs('local', 300), 300000);
  assert.throws(() => db.timeoutMs('local', 301), /exceeds the 300 s limit for profile "local"/);
});

test('per-profile ceiling overrides the global one', () => {
  assert.equal(db.timeoutMs('prod', 120), 120000);
  assert.throws(() => db.timeoutMs('prod', 180), /exceeds the 120 s limit for profile "prod"/);
});

test('invalid timeouts are rejected', () => {
  assert.throws(() => db.timeoutMs('local', 0), /at least 1/);
  assert.throws(() => db.timeoutMs('local', Number.NaN), /at least 1/);
});

test('timeout over the ceiling is rejected before connecting', async () => {
  await assert.rejects(db.query('prod', 'select 1', [], 10, 600), /exceeds the 120 s limit/);
});

test('search text becomes a contains pattern unless it has wildcards', () => {
  assert.equal(toIlikePattern('invoice'), '%invoice%');
  assert.equal(toIlikePattern('  invoice  '), '%invoice%');
  assert.equal(toIlikePattern('invoice%'), 'invoice%');
  assert.equal(toIlikePattern('a_b'), 'a_b');
  assert.throws(() => toIlikePattern('  '), /empty/);
});
