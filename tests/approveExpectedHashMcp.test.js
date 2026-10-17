import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Library } from '../src/reports/library.js';

// approve_report over the real MCP server (stdio) without a database: runs are
// written into the library directly. expectedHash is optional; when given, a
// draft whose SQL changed since that version is refused with STALE_VERSION.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-approve-hash-'));
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const lib = new Library(path.join(home, 'library'));
let client;

before(async () => {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_DB_EXAMPLE: 'postgresql://auspex@127.0.0.1:1/example' };
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE|SCRIPT_ROOT)_/i.test(k) && k !== 'AUSPEX_DB_EXAMPLE') delete env[k];
  for (const k of ['AUSPEX_LIBRARY_DIR', 'AUSPEX_LOG_DIR', 'AUSPEX_MEMORY_DIR', 'AUSPEX_DATA_DIR']) delete env[k];
  client = new Client({ name: 'approve-hash-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
});
after(async () => {
  await client?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const call = (name, args) => client.callTool({ name, arguments: args });
const result = r => JSON.parse(r.content[0].text);
const ref = { db: 'example', schema: 'example', category: 'Example Reports', name: 'example-report' };

// save_report, then a successful run of that SQL recorded in the library.
async function saveAndRun(r, sql) {
  const saved = await call('save_report', { ...r, sql });
  assert.ok(!saved.isError, saved.content[0].text);
  const { sqlHash } = result(saved);
  assert.match(sqlHash, /^[0-9a-f]{12}$/);
  lib.appendRun('draft', r, { at: new Date().toISOString(), sqlHash, durationMs: 5, rows: 1, warnings: [] }, null);
  return sqlHash;
}

test('approve_report lists expectedHash as an optional field', async () => {
  const { tools } = await client.listTools();
  const tool = tools.find(t => t.name === 'approve_report');
  assert.deepEqual(tool.inputSchema.required.sort(), ['category', 'db', 'name', 'schema']);
  assert.equal(tool.inputSchema.properties.expectedHash.type, 'string');
  assert.match(tool.description, /expectedHash/);
  const bad = await call('approve_report', { ...ref, expectedHash: 'NOT-A-HASH' });
  assert.ok(bad.isError, 'an invalid hash format is refused');
});

test('with expectedHash a changed draft is refused; the matching hash approves', async () => {
  const v1 = await saveAndRun(ref, 'select order_id from example.orders');
  const v2 = await saveAndRun(ref, 'select order_id, status_code from example.orders');
  const stale = await call('approve_report', { ...ref, expectedHash: v1 });
  assert.ok(stale.isError);
  assert.equal(stale.structuredContent.error.code, 'STALE_VERSION');
  assert.match(stale.content[0].text, /changed since you opened it \(now version 2\)/);
  assert.equal(lib.exists('draft', ref), true, 'nothing moved');

  const ok = await call('approve_report', { ...ref, expectedHash: v2 });
  assert.ok(!ok.isError, ok.content[0].text);
  assert.equal(result(ok).version, 2);

  const logs = path.join(home, 'logs');
  const entries = fs.readdirSync(logs).flatMap(f => fs.readFileSync(path.join(logs, f), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
  assert.deepEqual(entries.filter(e => e.tool === 'approve_report' && e.errorCode === 'STALE_VERSION').length, 1, 'the refusal is audited');
});

test('without expectedHash the current draft SQL is approved as before', async () => {
  const other = { ...ref, name: 'example-report-2' };
  await saveAndRun(other, 'select customer_id from example.customers');
  const ok = await call('approve_report', other);
  assert.ok(!ok.isError, ok.content[0].text);
  assert.equal(result(ok).version, 1);
});
