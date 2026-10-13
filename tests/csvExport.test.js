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
function fakeDb({ batches = [[[1, 'a'], [2, 'b']]], failFetchAt = -1, fetchDelayMs = 0 } = {}) {
  let fetches = 0;
  const fields = [{ name: 'id', dataTypeID: 23 }, { name: 'ad', dataTypeID: 25 }];
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
