import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { estimatedRowsSql } from '../src/catalog.js';

// Row estimates must not call a never-analyzed or later-filled table empty.
// Before PostgreSQL 14 a never vacuumed or analyzed relation has reltuples = 0
// (14+: -1), so 0 alone is no evidence of an empty table.

test('the estimate prefers reltuples, then the live row count, then 0 only after a vacuum or analyze', () => {
  const sql = estimatedRowsSql('c');
  const order = [
    'when c.reltuples > 0 then c.reltuples::bigint',
    'when pg_stat_get_live_tuples(c.oid) > 0 then pg_stat_get_live_tuples(c.oid)',
    'when c.reltuples = 0 and coalesce(pg_stat_get_last_analyze_time(c.oid)',
  ];
  let at = -1;
  for (const part of order) {
    const i = sql.indexOf(part);
    assert.ok(i > at, `${part} comes after the previous branch`);
    at = i;
  }
  for (const fn of ['pg_stat_get_last_autoanalyze_time', 'pg_stat_get_last_vacuum_time', 'pg_stat_get_last_autovacuum_time']) {
    assert.match(sql, new RegExp(`${fn}\\(c\\.oid\\)`), fn);
  }
  assert.match(sql, /is not null then 0 end$/, 'anything else is unknown (null)');
  assert.doesNotMatch(sql, /else/, 'no branch falls back to a bare reltuples');
  assert.match(estimatedRowsSql('oc'), /oc\.reltuples > 0 then oc\.reltuples::bigint/);
});

test('every catalog query reads the row estimate through estimatedRowsSql', () => {
  const source = fs.readFileSync(new URL('../src/catalog.js', import.meta.url), 'utf8');
  const helper = source.indexOf('export const estimatedRowsSql');
  const helperEnd = source.indexOf(';', source.indexOf('is not null then 0 end', helper));
  const outside = source.slice(0, helper) + source.slice(helperEnd);
  const code = outside.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('+ \'')).join('\n');
  assert.doesNotMatch(code, /\.reltuples/, 'no query reads reltuples directly');
  assert.ok((source.match(/\$\{estimatedRowsSql\('(c|oc)'\)\}/g) || []).length >= 6, 'list, describe, search, profile and relation_stats use it');
});
