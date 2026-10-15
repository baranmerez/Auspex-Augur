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
  // The role check is covered in roleCheck.test.js; here the role is known good.
  db.roleChecks.set('local', { status: 'ok', blocking: [], warnings: [] });
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

// Collects what an export writes instead of touching the disk.
function capture(db) {
  const chunks = [];
  db.exportPath = () => path.join(exportDir, 'budget.csv');
  db.openExportStream = () => new Writable({ write(chunk, enc, cb) { chunks.push(chunk.toString()); cb(); } });
  return () => chunks.join('');
}
const batch = n => Array.from({ length: n }, (_, i) => [i, 'satır ' + i]);

test('the row cap ends the file at a row and says why', async () => {
  const db = fakeDb({ batches: [batch(5)] });
  db.config.exportMaxRows = 3;
  const text = capture(db);
  const r = await db._exportCsv('local', 'select 1', [], 'x', ',');
  assert.deepEqual([r.rowCount, r.truncated, r.stopReason], [3, true, 'rows']);
  assert.equal(text().trim().split('\r\n').length, 4, 'header + 3 rows');
});

test('the size cap never writes past the limit and stops at a row boundary', async () => {
  const db = fakeDb({ batches: [batch(100)] });
  db.config.exportMaxBytes = 200;
  const text = capture(db);
  const r = await db._exportCsv('local', 'select 1', [], 'x', ',');
  assert.equal(r.stopReason, 'bytes');
  assert.equal(r.truncated, true);
  assert.ok(r.bytes <= 200 && Buffer.byteLength(text()) === r.bytes, `${r.bytes} bytes written`);
  assert.ok(text().endsWith('\r\n'), 'last line is complete');
  assert.equal(text().trim().split('\r\n').length, r.rowCount + 1);
});

test('the total time cap stops between batches', async () => {
  const db = fakeDb({ batches: [batch(1000), batch(1000), batch(1000)], fetchDelayMs: 20 });
  db.config.exportMaxMs = 10;
  capture(db);
  const r = await db._exportCsv('local', 'select 1', [], 'x', ',');
  assert.deepEqual([r.rowCount, r.truncated, r.stopReason], [1000, true, 'time']);
});

test('an export within every limit is complete and not truncated', async () => {
  const db = fakeDb({ batches: [batch(10)] });
  capture(db);
  const r = await db._exportCsv('local', 'select 1', [], 'x', ',');
  assert.deepEqual([r.rowCount, r.truncated, r.stopReason], [10, false, null]);
});

// Formula-like column names and values, written to a real file on disk.
const headerFields = [
  { name: '=1+1', dataTypeID: 25 }, { name: '+a', dataTypeID: 25 }, { name: '-b', dataTypeID: 23 },
  { name: '@c', dataTypeID: 25 }, { name: '\td', dataTypeID: 25 }, { name: 'Şükrü, "ad"\nx', dataTypeID: 25 },
];
const headerRows = [['=1+1', '+x', -5, '@y', '\rz', null]];

async function exportFile(mode, delimiter = ',') {
  const db = fakeDb({ batches: [headerRows], fields: headerFields });
  const r = await db._exportCsv('local', 'select 1', [], `headers-${mode}`, delimiter, undefined, mode);
  const text = fs.readFileSync(r.file, 'utf8');
  assert.equal(Buffer.byteLength(text), r.bytes, 'reported size matches the file');
  return text;
}

test('spreadsheet mode neutralizes formula-like column names in the written file', async () => {
  const text = await exportFile('spreadsheet');
  assert.ok(text.startsWith('﻿'));
  const lines = text.slice(1).split('\r\n');
  assert.equal(lines[0], `'=1+1,'+a,'-b,'@c,'\td,"Şükrü, ""ad""\nx"`);
  assert.equal(lines[1], `'=1+1,'+x,-5,'@y,"'\rz",`);
});

test('spreadsheet mode headers work with the semicolon delimiter', async () => {
  const text = await exportFile('spreadsheet', ';');
  assert.equal(text.slice(1).split('\r\n')[0], `'=1+1;'+a;'-b;'@c;'\td;"Şükrü, ""ad""\nx"`);
});

test('raw mode keeps column names exactly in the written file', async () => {
  const text = await exportFile('raw');
  const lines = text.slice(1).split('\r\n');
  assert.equal(lines[0], `=1+1,+a,-b,@c,\td,"Şükrü, ""ad""\nx"`);
  assert.equal(lines[1], `=1+1,+x,-5,@y,"\rz",`);
});
