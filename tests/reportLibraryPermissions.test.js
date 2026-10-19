import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, sqlHash } from '../src/reports/library.js';

test('private report SQL, metadata and HTML are owner-only on POSIX', { skip: process.platform === 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'example-private-report-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const library = new Library(path.join(home, 'library'));
  const reportRef = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'private-notes' };
  const sql = 'select private_note from example.orders';
  const oldUmask = process.umask(0o022);
  try {
    library.saveDraft({ ref: reportRef, sql });
    library.writeHtml('draft', reportRef, 'exampleconfidential');
    const draft = library.paths('draft', reportRef);
    assert.equal(fs.statSync(library.root).mode & 0o077, 0, 'other accounts cannot traverse private report storage');
    for (const file of Object.values(draft)) {
      assert.equal(fs.statSync(file).mode & 0o077, 0, 'other accounts cannot read private report files');
    }

    // Tighten an older permissive library directory when writing a report.
    fs.chmodSync(library.root, 0o755);
    library.saveDraft({ ref: reportRef, sql });
    assert.equal(fs.statSync(library.root).mode & 0o077, 0);

    // Approval copies the SQL and HTML, so their private modes must survive.
    library.appendRun('draft', reportRef, { at: '2026-10-20T00:00:00Z', sqlHash: sqlHash(sql), warnings: [] }, null);
    library.approve(reportRef);
    const approved = library.paths('approved', reportRef);
    for (const file of Object.values(approved)) {
      assert.equal(fs.statSync(file).mode & 0o077, 0, 'approved private report files remain protected');
    }
    assert.equal(fs.readFileSync(approved.html, 'utf8'), 'exampleconfidential');
  } finally {
    process.umask(oldUmask);
  }
});
