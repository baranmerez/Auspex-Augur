import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuditLog } from '../src/auditLog.js';

test('audit files and directories are owner-only, including existing files', { skip: process.platform === 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'example-audit-private-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const logDir = path.join(home, 'logs');
  const oldUmask = process.umask(0o022);
  try {
    const audit = createAuditLog(logDir);
    audit({ tool: 'query', profile: 'exampledb', sql: 'select * from example.orders where id = $1', params: ['exampleOnly'] });
    const [fileName] = fs.readdirSync(logDir);
    const file = path.join(logDir, fileName);
    assert.equal(fs.statSync(logDir).mode & 0o077, 0, 'directory must not be traversable by other users');
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'SQL and params must not be readable by other users');

    // Old audit files may have been created under the process umask (0644).
    // The next write must tighten their permissions before appending data.
    fs.chmodSync(file, 0o644);
    fs.chmodSync(logDir, 0o755);
    audit({ tool: 'query', profile: 'exampledb', sql: 'select 1 from example.orders' });
    assert.equal(fs.statSync(logDir).mode & 0o077, 0);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally {
    process.umask(oldUmask);
  }
});
