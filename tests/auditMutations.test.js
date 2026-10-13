import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Starts the real MCP server over stdio with a temporary home and a profile
// that is never connected to: every tool used here works without a database.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-audit-test-'));
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
let client;

before(async () => {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_DB_SHOP: 'postgresql://auspex@127.0.0.1:1/shop' };
  for (const k of Object.keys(env)) if (/^AUSPEX_DB_/i.test(k) && k !== 'AUSPEX_DB_SHOP') delete env[k];
  client = new Client({ name: 'audit-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
});
after(async () => { await client?.close(); });

const call = (name, args) => client.callTool({ name, arguments: args });
function auditEntries() {
  const dir = path.join(home, 'logs');
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
}
const ref = { db: 'shop', schema: 'sales', category: 'Audit', name: 'totals' };

test('report, script and memory changes are audited on success and failure, without content', async () => {
  const secretText = 'NOTE-TEXT-MARKER';
  const secretSql = 'select 4242 as sql_marker';

  assert.ok(!(await call('save_report', { ...ref, sql: secretSql })).isError);
  assert.ok(!(await call('approve_report', ref)).isError);
  assert.ok((await call('approve_report', { ...ref, name: 'missing' })).isError);
  assert.ok(!(await call('save_execute_script', { ...ref, name: 'fix', sql: 'BEGIN;\nUPDATE sales.t SET a = 4242 WHERE id = 1;\nROLLBACK;' })).isError);
  assert.ok((await call('save_execute_script', { ...ref, name: 'bad', sql: 'DELETE FROM sales.t;' })).isError);
  const added = await call('remember', { profile: 'shop', action: 'add', kind: 'rule', text: secretText });
  const noteId = JSON.parse(added.content[0].text).note.id;
  assert.ok(!(await call('remember', { profile: 'shop', action: 'archive', id: noteId, reason: 'REASON-MARKER' })).isError);
  assert.ok((await call('remember', { profile: 'shop', action: 'archive', id: 999 })).isError);

  const entries = auditEntries().filter(e => e.source === 'mcp');
  const of = tool => entries.filter(e => e.tool === tool);

  const [saved] = of('save_report');
  assert.equal(saved.report, 'shop/sales/Audit/totals');
  assert.equal(saved.version, 1);
  assert.match(saved.sqlHash, /^[0-9a-f]{12}$/);

  const approvals = of('approve_report');
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0].version, 1);
  assert.match(approvals[1].error, /No draft/);

  const scripts = of('save_execute_script');
  assert.equal(scripts.length, 2);
  assert.ok(scripts[0].file.endsWith('fix.sql'));
  assert.match(scripts[1].error, /rejected/);

  const notes = of('remember');
  assert.deepEqual(notes.map(e => [e.action, e.noteId ?? null, e.noteStatus ?? null, !!e.error]),
    [['add', noteId, 'active', false], ['archive', noteId, 'archived', false], ['archive', 999, null, true]]);

  const raw = JSON.stringify(entries);
  for (const marker of [secretText, 'REASON-MARKER', 'sql_marker', '4242']) assert.ok(!raw.includes(marker), `${marker} is not logged`);
});

test('local read-only tools add no entries; calls rejected by input validation are not logged', async () => {
  const before = auditEntries().length;
  await call('table_knowledge', { profile: 'shop', schema: 'sales', table: 'orders' });
  await call('list_reports', {});
  // Schema validation happens in the MCP SDK before any handler runs, so such
  // a call never reaches the audit log (documented in the README).
  const invalid = await call('remember', { profile: 'shop', action: 'delete' });
  assert.ok(invalid.isError);
  assert.equal(auditEntries().length, before);
});
