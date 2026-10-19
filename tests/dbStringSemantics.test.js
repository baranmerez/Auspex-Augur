import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyDatabase } from '../src/db.js';
import { roleCheckQueries } from '../src/roleCheck.js';

// A reused connection starts with the legacy server/role default. SET LOCAL
// changes only the transaction and ROLLBACK restores that default. No network.
function createFakeDatabase({ cachedRole = true, pinError, statementError, exportDir } = {}) {
  const statements = [];
  const reads = [];
  const auditEntries = [];
  const releases = [];
  const state = { standardStrings: 'off', readOnly: false };
  const resultFields = [{ name: 'exampleValue', dataTypeID: 23 }];
  const client = {
    async query(query) {
      const text = typeof query === 'string' ? query : query.text;
      statements.push(text);
      if (text.startsWith('BEGIN')) {
        state.readOnly = /READ ONLY$/.test(text);
        return { rows: [] };
      }
      if (/^SET LOCAL standard_conforming_strings\s*=\s*on$/i.test(text)) {
        assert.equal(state.readOnly, true);
        if (pinError) throw pinError;
        state.standardStrings = 'on';
        return { rows: [] };
      }
      if (text.startsWith('SET LOCAL')) return { rows: [] };
      if (text === 'ROLLBACK') {
        state.standardStrings = 'off';
        state.readOnly = false;
        return { rows: [] };
      }
      reads.push({ text, ...state });
      if (text === roleCheckQueries.role) return { rows: [{ rolname: 'exampleReader', default_read_only: 'on' }] };
      if (text === roleCheckQueries.database) return { rows: [{ can_create: false }] };
      if (text.startsWith('DECLARE')) {
        if (statementError) throw statementError;
        assert.equal(query.queryMode, 'extended');
        return { rows: [] };
      }
      if (text.startsWith('FETCH')) return { fields: resultFields, rows: [[1]] };
      if (text.startsWith('EXPLAIN')) {
        assert.equal(query.queryMode, 'extended');
        return { rows: [{ 'QUERY PLAN': text.includes('FORMAT JSON') ? [{ Plan: { 'Node Type': 'Result' } }] : 'Result' }] };
      }
      if (text.startsWith('select oid::int')) return { rows: [{ oid: 23, name: 'integer' }] };
      if (text.includes("current_setting('server_version')")) return { rows: [{ v: '16.0' }] };
      return { rows: [], fields: resultFields };
    },
    release(broken) { releases.push(broken); },
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['exampledb', 'postgresql://exampleReader@localhost:5432/exampledb']]),
    statementTimeoutMs: 1000,
    maxRows: 10,
    maxCellChars: 1000,
    exportDir,
    exportMaxRows: 10,
    exportMaxBytes: 10000,
    exportMaxMs: 5000,
  }, { audit: entry => auditEntries.push(entry) });
  db.pool = () => ({ connect: async () => client });
  if (cachedRole) db.roleChecks.set('exampledb', { status: 'ok', blocking: [], warnings: [] });
  return { db, statements, reads, auditEntries, releases, state };
}

// Under standard_conforming_strings=off the quote is escaped and the real
// advisory-lock call is outside the string. Under on it is only string data,
// exactly as sqlGuard parses it. The test never executes it on a real server.
const legacySql = String.raw`select '\'' as exampleText, pg_advisory_lock(1) -- '`;
const operations = [
  ['query', db => db.query('exampledb', legacySql)],
  ['explain', db => db.explain('exampledb', legacySql, [], true)],
  ['run_report', db => db.runReport('exampledb', legacySql, { previewRows: 1 })],
];

for (const [tool, run] of operations) {
  test(`${tool} pins string semantics before sending user SQL and remains audited`, async () => {
    const fixture = createFakeDatabase();
    await fixture.db.withCorrelation('exampleCall', () => run(fixture.db));
    assert.ok(fixture.reads.length > 0);
    assert.ok(fixture.reads.every(read => read.standardStrings === 'on' && read.readOnly));
    assert.equal(fixture.state.standardStrings, 'off');
    assert.deepEqual(fixture.releases, [false]);
    assert.equal(fixture.statements.at(-1), 'ROLLBACK');
    assert.ok(!fixture.statements.includes('COMMIT'));
    assert.equal(fixture.auditEntries.length, 1);
    assert.equal(fixture.auditEntries[0].tool, tool);
    assert.equal(fixture.auditEntries[0].correlationId, 'exampleCall');
  });
}

test('pins string semantics again when a pooled connection is reused', async () => {
  const fixture = createFakeDatabase();
  await fixture.db.query('exampledb', 'select 1');
  await fixture.db.query('exampledb', 'select 1');
  assert.equal(fixture.statements.filter(text => text.includes('SET LOCAL standard_conforming_strings')).length, 2);
  assert.ok(fixture.reads.every(read => read.standardStrings === 'on'));
  assert.deepEqual(fixture.releases, [false, false]);
});

test('pins string semantics before the first role-check catalog read', async () => {
  const fixture = createFakeDatabase({ cachedRole: false });
  await fixture.db.query('exampledb', 'select 1');
  assert.equal(fixture.reads[0].text, roleCheckQueries.role);
  assert.ok(fixture.reads.every(read => read.standardStrings === 'on' && read.readOnly));
  assert.deepEqual(fixture.auditEntries.map(entry => entry.tool), ['role_check', 'query']);
});

test('a failed string-mode pin refuses the operation, rolls back and is audited', async () => {
  const pinError = Object.assign(new Error('example setting refused'), { code: '42501', severity: 'ERROR' });
  const fixture = createFakeDatabase({ cachedRole: false, pinError });
  await assert.rejects(fixture.db.query('exampledb', 'select 1'), error => error === pinError);
  assert.deepEqual(fixture.reads, []);
  assert.equal(fixture.statements.at(-1), 'ROLLBACK');
  assert.equal(fixture.state.standardStrings, 'off');
  assert.deepEqual(fixture.releases, [false]);
  assert.equal(fixture.auditEntries[0].errorCode, 'PERMISSION_DENIED');
  assert.equal(fixture.auditEntries[0].sqlState, '42501');
});

test('a failed user statement still rolls back the local string setting', async () => {
  const statementError = Object.assign(new Error('example statement refused'), { code: '42601', severity: 'ERROR' });
  const fixture = createFakeDatabase({ statementError });
  await assert.rejects(fixture.db.query('exampledb', 'select 1'), error => error === statementError);
  assert.equal(fixture.reads[0].standardStrings, 'on');
  assert.equal(fixture.state.standardStrings, 'off');
  assert.equal(fixture.statements.at(-1), 'ROLLBACK');
  assert.deepEqual(fixture.releases, [false]);
});

test('CSV export uses the same pinned read-only transaction', async t => {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'example-string-mode-'));
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const fixture = createFakeDatabase({ exportDir });
  const result = await fixture.db.exportCsv('exampledb', 'select 1', [], 'exampleOrders', ',');
  assert.equal(result.rowCount, 1);
  assert.ok(fixture.reads.every(read => read.standardStrings === 'on' && read.readOnly));
  assert.equal(fixture.state.standardStrings, 'off');
  assert.equal(fixture.auditEntries[0].tool, 'export_csv');
});
