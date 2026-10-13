import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlyQuery, SqlGuardError } from '../src/sqlGuard.js';

const allowed = [
  ['plain select', 'select 1', 'select 1'],
  ['trailing semicolon', 'select 1;', 'select 1'],
  ['semicolon then comment', 'select 1; -- done', 'select 1'],
  ['cte', 'with x as (select 1 a) select a from x', null],
  ['values', 'values (1), (2)', null],
  ['table', 'table public.foo', null],
  ['case end', "select case when a > 0 then 'p' else 'n' end from t", null],
  ['fetch first', 'select * from t order by id fetch first 10 rows only', null],
  ['keyword inside string', "select 'delete from x; drop table y' as txt", null],
  ['keyword inside quoted identifier', 'select "update" from t', null],
  ['keyword inside comment', 'select 1 /* insert into x */', null],
  ['nested comment', 'select 1 /* a /* insert */ b */', null],
  ['dollar quoted', 'select $$drop table x; $$ as s', null],
  ['tagged dollar quote', 'select $t$ delete $t$', null],
  ['escape string', "select E'it\\'s; delete'", null],
  ['doubled quote', "select 'it''s; drop'", null],
  ['placeholder', 'select * from t where id = $1', null],
  ['jsonb_set is not set', "select jsonb_set('{}'::jsonb, '{a}', '1')", null],
  ['created_at column', 'select created_at, updated_by from t', null],
  ['leading comment', '-- note\nselect 1', null],
];

for (const [name, sql, expected] of allowed) {
  test(`allows ${name}`, () => {
    const out = assertReadOnlyQuery(sql);
    if (expected !== null) assert.equal(out, expected);
  });
}

const rejected = [
  ['empty', '   '],
  ['two statements', 'select 1; select 2'],
  ['stacked drop', 'select 1; drop table t'],
  ['insert', 'insert into t values (1)'],
  ['update', 'update t set a = 1'],
  ['delete', 'delete from t'],
  ['data-modifying cte', 'with d as (delete from t returning *) select * from d'],
  ['select into', 'select * into new_t from t'],
  ['set', 'set role postgres'],
  ['begin', 'begin'],
  ['copy', "copy t to 'c:/x.csv'"],
  ['explain analyze', 'explain analyze delete from t'],
  ['call', 'call do_it()'],
  ['do block', "do $$ begin delete from t; end $$"],
  ['set_config', "select set_config('role', 'postgres', false)"],
  ['terminate backend', 'select pg_terminate_backend(123)'],
  ['sleep', 'select pg_sleep(100)'],
  ['nextval', "select nextval('seq')"],
  ['read file', "select pg_read_file('postgresql.conf')"],
  ['advisory lock', 'select pg_advisory_lock(1)'],
  ['lo_import', "select lo_import('c:/x')"],
  ['dblink', "select * from dblink('host=x', 'delete from t') as r(a int)"],
  ['for update', 'select * from t for update'],
  ['unterminated string', "select 'abc"],
  ['unterminated comment', 'select 1 /* x'],
  ['comment hides second statement start', 'select 1 /* */; delete from t'],
];

for (const [name, sql] of rejected) {
  test(`rejects ${name}`, () => {
    assert.throws(() => assertReadOnlyQuery(sql), SqlGuardError);
  });
}
