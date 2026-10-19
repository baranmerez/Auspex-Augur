import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ReadOnlyDatabase } from '../src/db.js';

const temporalCases = [
  { name: 'date', oid: 1182, scalarOid: 1082, value: '2026-10-19' },
  { name: 'timestamp', oid: 1115, scalarOid: 1114, value: '2026-10-19 09:50:01.123456' },
  { name: 'timestamptz', oid: 1185, scalarOid: 1184, value: '2026-10-19 09:50:01.123456+03' },
];

for (const { name, oid, scalarOid, value } of temporalCases) {
  test(`${name} arrays keep the same exact text as scalar values`, () => {
    const parseArray = pg.types.getTypeParser(oid, 'text');
    const parseScalar = pg.types.getTypeParser(scalarOid, 'text');
    assert.deepEqual(parseArray(`{"${value}",NULL}`), [value, null]);
    assert.equal(parseArray(`{"${value}"}`)[0], parseScalar(value));
    assert.deepEqual(parseArray('{}'), []);
  });

  test(`${name} arrays preserve infinity and multidimensional structure`, () => {
    const parseArray = pg.types.getTypeParser(oid, 'text');
    assert.deepEqual(parseArray(`{{"${value}",NULL},{infinity,-infinity}}`),
      [[value, null], ['infinity', '-infinity']]);
  });
}

test('temporal array cells retain microseconds and timezone offsets when formatted', () => {
  const db = new ReadOnlyDatabase({ maxCellChars: 1000 }, { audit: () => {} });
  const parsed = pg.types.getTypeParser(1185, 'text')(
    '{"2026-10-19 09:50:01.123456+03","2026-10-19 06:50:01.123456+00",infinity,NULL}');
  assert.equal(db.formatCell(parsed),
    '["2026-10-19 09:50:01.123456+03","2026-10-19 06:50:01.123456+00","infinity",null]');
});
