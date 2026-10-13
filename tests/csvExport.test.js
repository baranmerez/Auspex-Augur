import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { ReadOnlyDatabase } from '../src/db.js';

// Any unhandled rejection during these tests would crash a real MCP server.
const unhandled = [];
const onUnhandled = err => unhandled.push(err);
process.on('unhandledRejection', onUnhandled);
after(() => {
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'no unhandled rejections');
});

const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-csv-test-'));

// Fake pg client: FETCH returns `batches` in order; failFetchAt makes that
// FETCH reject; fetchDelayMs delays every FETCH.
function fakeDb({ batches = [[[1, 'a'], [2, 'b']]], failFetchAt = -1, fetchDelayMs = 0, fields = [{ name: 'id', dataTypeID: 23 }, { name: 'ad', dataTypeID: 25 }] } = {}) {
  let fetches = 0;
  const client = {
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      if (!text.startsWith('FETCH')) return { rows: [] };
      if (fetchDelayMs) await new Promise(r => setTimeout(r, fetchDelayMs));
      const i = fetches++;
      if (i === failFetchAt) throw new Error('connection lost during FETCH');
      return { rows: batches[i] ?? [], fields };
    },
    release() {},
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['local', 'postgresql://u@127.0.0.1:1/a']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500, exportMaxRows: 100000, exportDir,
  });
  db.pool = () => ({ connect: async () => client });
  return db;
}

test('two exports with the same name in the same second get different files', () => {
  const db = fakeDb();
  const names = new Set(Array.from({ length: 200 }, () => db.exportPath('Sipariş Listesi')));
  assert.equal(names.size, 200);
  for (const n of names) assert.match(path.basename(n), /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d_[0-9a-f]{6}_Sipari_Listesi\.csv$/);
});

test('a name collision fails cleanly and leaves the existing file byte for byte', async () => {
  const db = fakeDb({ fetchDelayMs: 20 });
  const existing = path.join(exportDir, 'existing.csv');
  fs.writeFileSync(existing, 'keep me\r\n');
  db.exportPath = () => existing;
  await assert.rejects(db._exportCsv('local', 'select 1', [], 'x', ','), /EEXIST/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep me\r\n');
});

test('a FETCH failure removes only the partial file this export created', async () => {
  const db = fakeDb({ batches: [Array.from({ length: 1000 }, (_, i) => [i, 'x'])], failFetchAt: 1 });
  const target = path.join(exportDir, 'partial.csv');
  db.exportPath = () => target;
  await assert.rejects(db._exportCsv('local', 'select 1', [], 'x', ','), /connection lost/);
  assert.equal(fs.existsSync(target), false);
});

test('a write error rejects the call instead of crashing the process', async () => {
  const db = fakeDb();
  db.exportPath = () => path.join(exportDir, 'never-created.csv');
  db.openExportStream = () => new Writable({
    write(chunk, enc, cb) { cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })); },
  });
  await assert.rejects(db._exportCsv('local', 'select 1', [], 'x', ','), /ENOSPC/);
});

test('a slow writer applies backpressure and still gets every row', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => [i, 'satır ' + 'x'.repeat(50)]);
  const db = fakeDb({ batches: [rows] });
  let buffered = 0;
  let maxBuffered = 0;
  const chunks = [];
  db.exportPath = () => path.join(exportDir, 'slow.csv');
  db.openExportStream = () => {
    const w = new Writable({
      highWaterMark: 256,
      write(chunk, enc, cb) { chunks.push(chunk.toString()); setImmediate(cb); },
    });
    const original = w.write.bind(w);
    w.write = (chunk, ...rest) => {
      buffered = w.writableLength + Buffer.byteLength(chunk);
      maxBuffered = Math.max(maxBuffered, buffered);
      return original(chunk, ...rest);
    };
    return w;
  };
  const res = await db._exportCsv('local', 'select 1', [], 'x', ',');
  assert.equal(res.rowCount, 1000);
  const text = chunks.join('');
  assert.ok(text.startsWith('﻿id,ad\r\n'));
  assert.equal(text.trim().split('\r\n').length, 1001);
  assert.ok(maxBuffered < 1024, `buffer stayed small (${maxBuffered} bytes)`);
});

// Columns: text, varchar, int4, numeric, date, jsonb (unknown to the type list
// counts as text). Rows mix formula-like text, real negatives and Turkish.
const mixedFields = [
  { name: 'note', dataTypeID: 25 }, { name: 'code', dataTypeID: 1043 }, { name: 'n', dataTypeID: 23 },
  { name: 'amount', dataTypeID: 1700 }, { name: 'day', dataTypeID: 1082 }, { name: 'doc', dataTypeID: 3802 },
];
const mixedRows = [
  ['=1+1', '+1+1', -5, '-12.50', '2026-10-13', '{"a":1}'],
  ['@SUM(1,1)', '-2+3', 0, '7', null, '=x'],
  ['\tTAB', '\rCR', 1, '-0.5', '2026-01-01', null],
  ['Şükrü, "Öz"\nİkinci satır', 'ığüşöç', 2, '3', '2026-02-02', '[1]'],
];

async function exportText(mode, delimiter = ',') {
  const db = fakeDb({ batches: [mixedRows], fields: mixedFields });
  const chunks = [];
  db.exportPath = () => path.join(exportDir, `mixed-${mode}.csv`);
  db.openExportStream = () => new Writable({ write(chunk, enc, cb) { chunks.push(chunk.toString()); cb(); } });
  await db._exportCsv('local', 'select 1', [], 'x', delimiter, undefined, mode);
  return chunks.join('');
}

test('raw mode keeps every value exactly (default)', async () => {
  const text = await exportText('raw');
  assert.ok(text.startsWith('﻿note,code,n,amount,day,doc\r\n'));
  assert.match(text, /\r\n=1\+1,\+1\+1,-5,-12\.50,2026-10-13,"\{""a"":1\}"\r\n/);
  assert.ok(text.includes('\r\n"@SUM(1,1)",-2+3,0,7,,=x\r\n'));
  assert.ok(text.includes('"Şükrü, ""Öz""\nİkinci satır",ığüşöç,2,3,2026-02-02,[1]\r\n'));
});

test('spreadsheet mode neutralizes formula-like text but keeps numbers and dates', async () => {
  const text = await exportText('spreadsheet');
  const lines = text.slice(1).split('\r\n');
  assert.equal(lines[0], 'note,code,n,amount,day,doc');
  assert.equal(lines[1], `'=1+1,'+1+1,-5,-12.50,2026-10-13,"{""a"":1}"`);
  assert.equal(lines[2], `"'@SUM(1,1)",'-2+3,0,7,,'=x`);
  assert.equal(lines[3], `'\tTAB,"'\rCR",1,-0.5,2026-01-01,`);
  assert.equal(lines[4], '"Şükrü, ""Öz""\nİkinci satır",ığüşöç,2,3,2026-02-02,[1]');
});

test('spreadsheet mode works with the semicolon delimiter', async () => {
  const text = await exportText('spreadsheet', ';');
  assert.equal(text.slice(1).split('\r\n')[2], `'@SUM(1,1);'-2+3;0;7;;'=x`);
});

test('an unknown mode is rejected before touching the database', async () => {
  const db = fakeDb();
  await assert.rejects(db._exportCsv('local', 'select 1', [], 'x', ',', undefined, 'excel'), /mode must be/);
});
