import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyDatabase } from '../src/db.js';
import { SqlGuardError } from '../src/sqlGuard.js';

// Unreachable port: if the guard did not reject first, these would fail with a
// connection error instead of SqlGuardError.
const db = new ReadOnlyDatabase({ profiles: new Map([['local', 'postgresql://u@127.0.0.1:1/none']]), statementTimeoutMs: 1000 });

for (const [name, sql] of [
  ['delete', 'delete from t'],
  ['data-modifying cte', 'with d as (delete from t returning *) select * from d'],
  ['nested explain analyze', 'explain analyze delete from t'],
  ['stacked statement', 'select 1; update t set a = 1'],
  ['side-effect function', 'select pg_terminate_backend(1)'],
]) {
  test(`explain analyze rejects ${name} before connecting`, async () => {
    await assert.rejects(db.explain('local', sql, [], true), SqlGuardError);
  });
}
