import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyDatabase } from '../src/db.js';

test('CSV exports containing row values are owner-private on POSIX', { skip: process.platform === 'win32' }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'example-private-export-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const exportDir = path.join(home, 'exports');
  const originalUmask = process.umask(0o022);
  try {
    const db = new ReadOnlyDatabase({
      profiles: new Map([['exampledb', 'postgresql://example@localhost:5432/exampledb']]),
      exportDir, exportMaxRows: 10, exportMaxBytes: 100000, exportMaxMs: 5000,
    }, { audit: () => {} });
    // Never connects to a database: the cursor and FETCH are test doubles.
    db.withReadOnly = async (profile, fn) => {
      assert.equal(profile, 'exampledb');
      return fn({
        async query(query) {
          const statement = typeof query === 'string' ? query : query.text;
          if (statement.startsWith('DECLARE')) return { rows: [] };
          if (statement.startsWith('FETCH')) {
            return {
              fields: [{ name: 'private_note', dataTypeID: 25 }],
              rows: [['exampleconfidential']],
            };
          }
          throw new Error('Unexpected query in fake cursor');
        },
      }, 'exampledb');
    };
    const exportOnce = () => db.exportCsv('exampledb', 'select private_note from example.orders', [], 'exampleOrders', ',');
    const first = await exportOnce();
    assert.equal(first.rowCount, 1);
    assert.match(fs.readFileSync(first.file, 'utf8'), /exampleconfidential/);
    assert.equal(fs.statSync(exportDir).mode & 0o077, 0, 'others must not traverse the export directory');
    assert.equal(fs.statSync(first.file).mode & 0o077, 0, 'others must not read exported table data');

    // A directory created by an older Auspex version must be secured too.
    fs.chmodSync(exportDir, 0o755);
    const second = await exportOnce();
    assert.equal(fs.statSync(exportDir).mode & 0o077, 0);
    assert.equal(fs.statSync(second.file).mode & 0o077, 0);
    assert.notEqual(second.file, first.file);
  } finally {
    process.umask(originalUmask);
  }
});
