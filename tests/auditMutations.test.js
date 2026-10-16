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
const scriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-audit-root-'));
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
let client;

before(async () => {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_DB_SHOP: 'postgresql://auspex@127.0.0.1:1/shop',
    AUSPEX_DB_TINY: 'postgresql://auspex@127.0.0.1:1/tiny', AUSPEX_MAX_QUERIES_PER_MINUTE_TINY: '1', AUSPEX_SCRIPT_ROOT_SCRATCH: scriptRoot };
  const keep = ['AUSPEX_DB_SHOP', 'AUSPEX_DB_TINY', 'AUSPEX_MAX_QUERIES_PER_MINUTE_TINY', 'AUSPEX_SCRIPT_ROOT_SCRATCH'];
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE|SCRIPT_ROOT)_/i.test(k) && !keep.includes(k)) delete env[k];
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
  assert.ok((await call('approve_report', ref)).isError, 'no run yet');
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
  assert.match(approvals[0].error, /no successful run/);
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

test('list_profiles shows script roots; a script saved into one is audited with its path and names', async () => {
  const listed = JSON.parse((await call('list_profiles', {})).content[0].text);
  assert.deepEqual(listed.scriptRoots, [{ name: 'scratch', path: path.resolve(scriptRoot), source: 'env' }]);
  assert.equal(listed.notesLanguage, null);

  const args = { ...ref, name: 'rooted', root: 'scratch', folder: 'Audit_DB_Scripts_V1', fileName: '00_audit_preflight.sql', sql: 'BEGIN;\nUPDATE sales.t SET zqscriptmarker = 1 WHERE id = 1;\nROLLBACK;' };
  const saved = await call('save_execute_script', args);
  assert.ok(!saved.isError, saved.content[0].text);
  const file = path.join(fs.realpathSync.native(scriptRoot), 'Audit_DB_Scripts_V1', '00_audit_preflight.sql');
  assert.equal(JSON.parse(saved.content[0].text).externalFile, file);
  const again = await call('save_execute_script', { ...args, name: 'rooted-2' });
  assert.ok(again.isError, 'the existing file is never overwritten');

  const [ok, refused] = auditEntries().filter(e => e.tool === 'save_execute_script' && e.root === 'scratch');
  assert.equal(ok.file, file);
  assert.ok(ok.libraryFile.endsWith('rooted.sql'));
  assert.deepEqual([ok.folder, ok.fileName], ['Audit_DB_Scripts_V1', '00_audit_preflight.sql']);
  assert.match(refused.error, /already exists/);
  // Markers no random part of an entry (UUID, temp folder, timing) can contain.
  assert.ok(!JSON.stringify([ok, refused]).includes('zqscriptmarker'), 'no SQL text in the audit log');

  const report = await call('save_report', { ...ref, name: 'rooted-report', root: 'scratch', folder: 'Audit_DB_Scripts_V1/raporlar', fileName: '01_audit_report.sql', sql: 'select 1 as zqreportmarker' });
  assert.ok(!report.isError, report.content[0].text);
  const reportFile = path.join(fs.realpathSync.native(scriptRoot), 'Audit_DB_Scripts_V1', 'raporlar', '01_audit_report.sql');
  assert.equal(JSON.parse(report.content[0].text).externalFile, reportFile);
  const [logged] = auditEntries().filter(e => e.tool === 'save_report' && e.root === 'scratch');
  assert.equal(logged.file, reportFile);
  assert.equal(logged.folder, 'Audit_DB_Scripts_V1/raporlar');
  assert.ok(!JSON.stringify(logged).includes('zqreportmarker'));
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

// Error envelope (README: Errors): readable text first, then code, retryable
// and correlationId in structuredContent and in a JSON text block.
const envelope = result => {
  assert.ok(result.isError);
  assert.match(result.content[0].text, /\S/);
  const { error } = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[1].text), { error });
  assert.equal(result._meta.correlationId, error.correlationId);
  assert.match(error.correlationId, /^[0-9a-f-]{36}$/);
  return error;
};

test('errors carry a stable code and a correlation ID that matches the audit entry', async () => {
  // Schema validation in the SDK: INVALID_INPUT, not audited.
  const schema = envelope(await call('remember', { profile: 'shop', action: 'delete' }));
  assert.equal(schema.code, 'INVALID_INPUT');
  assert.equal(schema.retryable, false);

  // Validation in the handler: audited with the same correlation ID and code.
  const noId = envelope(await call('remember', { profile: 'shop', action: 'archive' }));
  assert.equal(noId.code, 'INVALID_INPUT');
  const missing = envelope(await call('approve_report', { ...ref, name: 'nothing-here' }));
  assert.equal(missing.code, 'NOT_FOUND');
  const unknown = envelope(await call('list_schemas', { profile: 'nope' }));
  assert.equal(unknown.code, 'PROFILE_INVALID');
  const entries = auditEntries();
  for (const e of [noId, missing, unknown]) {
    const logged = entries.filter(x => x.correlationId === e.correlationId);
    assert.equal(logged.length, 1, 'one audit entry per call');
    assert.equal(logged[0].errorCode, e.code);
  }

  // A success returns its correlation ID in _meta, and the audit entry has it.
  const ok = await call('save_report', { ...ref, name: 'corr', sql: 'select 1' });
  assert.ok(!ok.isError);
  assert.equal(auditEntries().filter(x => x.correlationId === ok._meta.correlationId && x.tool === 'save_report').length, 1);
});

test('query budget refusal is QUERY_BUDGET_EXCEEDED with retryAfterSeconds, per process', async () => {
  // Budget 1 per minute: the first call uses it (and fails to connect), the second is refused before connecting.
  const first = envelope(await call('list_schemas', { profile: 'tiny' }));
  assert.equal(first.code, 'CONNECTION_FAILED');
  const refused = envelope(await call('list_schemas', { profile: 'tiny' }));
  assert.equal(refused.code, 'QUERY_BUDGET_EXCEEDED');
  assert.equal(refused.retryable, true);
  assert.equal(refused.budgetScope, 'process');
  assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60);
  const [logged] = auditEntries().filter(x => x.correlationId === refused.correlationId);
  assert.equal(logged.errorCode, 'QUERY_BUDGET_EXCEEDED');
  assert.ok(!JSON.stringify(refused).includes('127.0.0.1'), 'no connection details in the envelope');
});

test('list_profiles returns notesLanguage from the profiles file and does not list it as a profile', async () => {
  const langHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-lang-test-'));
  const file = path.join(langHome, 'profiles.json');
  fs.writeFileSync(file, JSON.stringify({ notesLanguage: 'pt-BR' }));
  const env = { ...process.env, AUSPEX_HOME: langHome, AUSPEX_PROFILES_FILE: file, AUSPEX_DB_SHOP: 'postgresql://auspex@127.0.0.1:1/shop' };
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE|SCRIPT_ROOT)_/i.test(k) && k !== 'AUSPEX_DB_SHOP') delete env[k];
  const other = new Client({ name: 'lang-test', version: '1.0.0' });
  await other.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
  try {
    const listed = JSON.parse((await other.callTool({ name: 'list_profiles', arguments: {} })).content[0].text);
    assert.equal(listed.notesLanguage, 'pt-BR');
    assert.deepEqual(listed.profiles.map(p => p.name), ['shop']);
  } finally {
    await other.close();
  }
});
