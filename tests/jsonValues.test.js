import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { ReadOnlyDatabase } from '../src/db.js';

// Rows of the caller's SQL keep the json and jsonb digits PostgreSQL returned:
// JSON.parse would turn 9007199254740993 into 9007199254740992 and cut long
// decimals. No database is contacted: the fake cursor decodes each value with
// the types the FETCH asked for, like node-postgres does.

const payload = '{"amount": 1234567890.123456789, "orderId": 9007199254740993}';
const arrayPayload = '{"{\\"orderId\\": 9007199254740993}",NULL}';

function fakeDatabase(exportDir, fetched = []) {
  const db = new ReadOnlyDatabase({
    profiles: new Map([['exampledb', 'postgresql://report_reader@db.example.test:5432/exampledb']]),
    statementTimeoutMs: 30000, maxRows: 10, maxCellChars: 1000,
    exportDir, exportMaxRows: 10, exportMaxBytes: 100000, exportMaxMs: 5000,
  }, { audit: () => {} });
  db.ensureRoleChecked = async () => {};
  let sent = 0;
  db.pool = () => ({ connect: async () => ({
    async query(input) {
      const text = typeof input === 'string' ? input : input.text;
      if (!text.startsWith('FETCH ')) return { fields: [], rows: [] };
      fetched.push(input);
      if (sent++ % 2) return { fields: [], rows: [] }; // the export asks again until empty
      const types = input.types ?? pg.types;
      return {
        fields: [{ name: 'payload', dataTypeID: 3802 }, { name: 'payloads', dataTypeID: 3807 }],
        rows: [[types.getTypeParser(3802, 'text')(payload), types.getTypeParser(3807, 'text')(arrayPayload)]],
      };
    },
    release() {},
  }) });
  return db;
}

test('query returns the exact json and jsonb text, arrays included', async () => {
  const fetched = [];
  const result = await fakeDatabase(os.tmpdir(), fetched).query('exampledb', 'SELECT payload, payloads FROM example.orders');
  assert.equal(result.rows[0][0], payload);
  assert.equal(result.rows[0][1], JSON.stringify(['{"orderId": 9007199254740993}', null]));
  assert.ok(fetched.every(q => q.types), 'every FETCH carries the result types');
});

test('raw CSV export keeps the exact JSON numbers', async () => {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'example-json-export-'));
  try {
    const exported = await fakeDatabase(exportDir).exportCsv('exampledb', 'SELECT payload, payloads FROM example.orders', [], 'exampleOrders', ',', undefined, 'raw');
    const csv = fs.readFileSync(exported.file, 'utf8');
    assert.match(csv, /9007199254740993/);
    assert.match(csv, /1234567890\.123456789/);
    assert.doesNotMatch(csv, /9007199254740992/);
  } finally {
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
});

test('the driver defaults stay JSON.parse for Auspex catalog queries', () => {
  assert.deepEqual(pg.types.getTypeParser(3802, 'text')('{"table": "example.orders"}'), { table: 'example.orders' });
});

test('non-finite floats and intervals keep PostgreSQL text, finite floats stay numbers', async () => {
  const fetched = [];
  const db = fakeDatabase(os.tmpdir(), fetched);
  await db.query('exampledb', 'SELECT 1');
  const types = fetched[0].types;
  const parse = (oid, text) => types.getTypeParser(oid, 'text')(text);
  assert.equal(parse(701, 'NaN'), 'NaN');
  assert.equal(parse(701, '-Infinity'), '-Infinity');
  assert.equal(parse(700, 'Infinity'), 'Infinity');
  assert.equal(parse(701, '1.5'), 1.5);
  assert.deepEqual(parse(1022, '{NaN,Infinity,-Infinity,NULL,2.5}'), ['NaN', 'Infinity', '-Infinity', null, 2.5]);
  assert.deepEqual(parse(1021, '{{1,NaN}}'), [[1, 'NaN']]);
  assert.equal(parse(1186, 'P1Y2M3DT4H5M6.789123S'), 'P1Y2M3DT4H5M6.789123S');
  assert.deepEqual(parse(1187, '{P1Y2M,NULL}'), ['P1Y2M', null]);
  assert.equal(parse(23, '42'), 42, 'other types keep the default parsers');
});
