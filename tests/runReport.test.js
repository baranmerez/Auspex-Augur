import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyDatabase } from '../src/db.js';

// A fake pg client that records every statement and answers just enough for
// runReport: EXPLAIN, cursor FETCH, the LIMIT 0 column probe and the lookups.
function fakeDb() {
  const sent = [];
  const fields = [{ name: 'id', dataTypeID: 23 }];
  const client = {
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      sent.push(text);
      if (text.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Total Cost': 0.01, 'Plan Rows': 1 } }] }] };
      if (text.startsWith('FETCH')) return { rows: [[1], [2]], fields };
      if (text.includes('auspex_columns LIMIT 0')) return { rows: [], fields };
      if (text.includes('pg_type')) return { rows: [{ oid: 23, name: 'integer' }] };
      if (text.includes('server_version')) return { rows: [{ v: '16.0' }] };
      return { rows: [] };
    },
    release() {},
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['local', 'postgresql://u@127.0.0.1:1/a']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500,
  });
  db.pool = () => ({ connect: async () => client });
  // The role check is covered in roleCheck.test.js; here the role is known good.
  db.roleChecks.set('local', { status: 'ok', blocking: [], warnings: [] });
  return { db, sent };
}

test('previewRows 0 without ANALYZE opens no cursor and fetches nothing', async () => {
  const { db, sent } = fakeDb();
  const r = await db._runReport('local', 'select id from t -- trailing comment', { analyze: false, previewRows: 0 });
  assert.ok(!sent.some(s => s.startsWith('DECLARE') || s.startsWith('FETCH')), sent.join(' | '));
  const probe = sent.find(s => s.includes('auspex_columns'));
  assert.equal(probe, 'SELECT * FROM (select id from t -- trailing comment\n) auspex_columns LIMIT 0');
  assert.equal(sent.find(s => s.startsWith('EXPLAIN')), 'EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) select id from t -- trailing comment');
  assert.equal(r.previewExecuted, false);
  assert.deepEqual(r.columns, [{ name: 'id', type: 'integer' }]);
  assert.deepEqual(r.rows, []);
});

test('a nonzero preview runs the query through a cursor and says so', async () => {
  const { db, sent } = fakeDb();
  const r = await db._runReport('local', 'select id from t', { analyze: false, previewRows: 1 });
  assert.ok(sent.some(s => s.startsWith('DECLARE')));
  assert.ok(sent.some(s => /^FETCH 2 FROM/.test(s)), 'previewRows + 1 rows are fetched to detect truncation');
  assert.equal(r.previewExecuted, true);
  assert.equal(r.truncated, true);
});
