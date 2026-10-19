import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyDatabase } from '../src/db.js';

function fakeDatabase({ settingError = null, queryError = null } = {}) {
  const statements = [];
  const queryModes = [];
  const roleModes = [];
  const releases = [];
  const auditRecords = [];
  let stringMode = 'off'; // A legacy server or role default, not PGOPTIONS.
  const client = {
    async query(input) {
      const text = typeof input === 'string' ? input : input.text;
      statements.push(text);
      if (text === 'SET LOCAL standard_conforming_strings = on') {
        if (settingError) throw settingError;
        stringMode = 'on';
      }
      if (text.startsWith('DECLARE ')) {
        queryModes.push(stringMode);
        if (queryError) throw queryError;
      }
      if (text === 'ROLLBACK') stringMode = 'off';
      return { rows: [], fields: [] };
    },
    release(broken) { releases.push(broken); },
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['exampledb', 'postgresql://example_reader@localhost/exampledb']]),
    statementTimeoutMs: 30000,
    maxRows: 10,
    maxCellChars: 100,
  }, { audit: entry => auditRecords.push(entry) });
  db.pool = () => ({ connect: async () => client });
  db.ensureRoleChecked = async () => { roleModes.push(stringMode); };
  return { db, statements, queryModes, roleModes, releases, auditRecords, currentMode: () => stringMode };
}

test('pins ordinary-string semantics before the role check and guarded query', async () => {
  const fixture = fakeDatabase();
  // The guard treats the function name as literal text. With the server's
  // setting off, the backslash instead escapes the quote and exposes the call.
  const sql = String.raw`SELECT '\' || ', pg_advisory_lock(1) --'`;
  await fixture.db.query('exampledb', sql);
  assert.deepEqual(fixture.roleModes, ['on']);
  assert.deepEqual(fixture.queryModes, ['on']);
  assert.match(fixture.statements[0], /^BEGIN .* READ ONLY$/);
  assert.equal(fixture.statements.at(-1), 'ROLLBACK');
  assert.equal(fixture.currentMode(), 'off');
  assert.deepEqual(fixture.releases, [false]);
  assert.equal(fixture.auditRecords[0].tool, 'query');
  assert.equal(fixture.auditRecords[0].error, undefined);
});

test('pins the setting again when the pooled client is reused', async () => {
  const fixture = fakeDatabase();
  for (let i = 0; i < 2; i++) await fixture.db.query('exampledb', 'SELECT 1 FROM example.orders');
  assert.deepEqual(fixture.queryModes, ['on', 'on']);
  assert.equal(fixture.statements.filter(text => text === 'SET LOCAL standard_conforming_strings = on').length, 2);
  assert.equal(fixture.currentMode(), 'off');
  assert.equal(fixture.auditRecords.length, 2);
});

test('fails closed and audits the failure when the setting cannot be pinned', async () => {
  const settingError = Object.assign(new Error('example setting rejected'), { code: '42501' });
  const fixture = fakeDatabase({ settingError });
  await assert.rejects(fixture.db.query('exampledb', 'SELECT 1'), error => error === settingError);
  assert.deepEqual(fixture.roleModes, []);
  assert.deepEqual(fixture.queryModes, []);
  assert.equal(fixture.statements.at(-1), 'ROLLBACK');
  assert.deepEqual(fixture.releases, [false]);
  assert.equal(fixture.auditRecords.length, 1);
  assert.equal(fixture.auditRecords[0].error, settingError.message);
});

test('rolls back the local setting and releases the client after a query error', async () => {
  const queryError = Object.assign(new Error('example query rejected'), { code: '42501' });
  const fixture = fakeDatabase({ queryError });
  await assert.rejects(fixture.db.query('exampledb', 'SELECT 1'), error => error === queryError);
  assert.deepEqual(fixture.queryModes, ['on']);
  assert.equal(fixture.currentMode(), 'off');
  assert.equal(fixture.statements.at(-1), 'ROLLBACK');
  assert.deepEqual(fixture.releases, [false]);
  assert.equal(fixture.auditRecords[0].error, queryError.message);
});
