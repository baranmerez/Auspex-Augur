import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ReadOnlyDatabase } from '../src/db.js';

const parseNumericArray = value => pg.types.getTypeParser(1231, 'text')(value);

// numeric is exact in PostgreSQL and is returned as text for scalar columns.
// Array elements must not be routed through parseFloat before formatting.
test('numeric arrays preserve large integers and decimal precision', () => {
  const values = ['9007199254740993', '12345678901234567890.123456789', '0.000000000000000000001'];
  assert.deepEqual(parseNumericArray(`{${values.join(',')}}`), values);
  const parseNumeric = pg.types.getTypeParser(1700, 'text');
  for (const value of values) assert.equal(parseNumericArray(`{${value}}`)[0], parseNumeric(value));
});

test('numeric arrays preserve scale, negative values and special numeric values', () => {
  assert.deepEqual(parseNumericArray('{1.2300,-9007199254740993,NaN,Infinity,-Infinity}'),
    ['1.2300', '-9007199254740993', 'NaN', 'Infinity', '-Infinity']);
});

test('numeric arrays retain nesting, SQL nulls and empty arrays', () => {
  assert.deepEqual(parseNumericArray('{{9007199254740993,NULL},{1.2300,-0.000001}}'),
    [['9007199254740993', null], ['1.2300', '-0.000001']]);
  assert.deepEqual(parseNumericArray('{}'), []);
});

test('the audited query path returns exact numeric array values', async () => {
  const entries = [];
  const statements = [];
  const db = new ReadOnlyDatabase({
    profiles: new Map([['exampledb', 'postgresql://example_reader@localhost/exampledb']]),
    statementTimeoutMs: 30000, maxRows: 10, maxCellChars: 1000,
  }, { audit: entry => entries.push(entry) });
  db.ensureRoleChecked = async () => {};
  db.pool = () => ({ connect: async () => ({
    async query(input) {
      const text = typeof input === 'string' ? input : input.text;
      statements.push(text);
      return text.startsWith('FETCH ')
        ? { fields: [{ name: 'amounts', dataTypeID: 1231 }], rows: [[parseNumericArray('{9007199254740993,1.2300,NaN,NULL}')]] }
        : { fields: [], rows: [] };
    },
    release() {},
  }) });
  const result = await db.query('exampledb', 'SELECT amounts FROM example.orders');
  assert.deepEqual(result.rows, [['["9007199254740993","1.2300","NaN",null]']]);
  assert.equal(result.rowCount, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, 'query');
  assert.match(statements[0], /^BEGIN .* READ ONLY$/);
  assert.equal(statements.at(-1), 'ROLLBACK');
});
