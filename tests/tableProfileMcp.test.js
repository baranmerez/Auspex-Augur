import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SchemaMemory } from '../src/memory/store.js';
import { Library } from '../src/reports/library.js';
import { seedExampleMemory } from './fixtures/exampleMemory.js';

// table_profile over the real MCP server (stdio). The profile points at a
// closed port: any database call would fail, so a passing get and save prove
// the tool answers from local memory only. Synthetic example data only.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-table-profile-mcp-'));
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
let client;

before(async () => {
  seedExampleMemory(path.join(home, 'memory'), 'example');
  const lib = new Library(path.join(home, 'library'));
  lib.saveDraft({ ref: { db: 'example', schema: 'example', category: 'Example Reports', name: 'example-report' }, title: 'Orders by day', sql: 'select created_at::date, count(*) from example.orders group by 1' });
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_DB_EXAMPLE: 'postgresql://auspex@127.0.0.1:1/example' };
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE|SCRIPT_ROOT|ENABLED_TOOL_GROUPS)_?/i.test(k) && k !== 'AUSPEX_DB_EXAMPLE') delete env[k];
  for (const k of ['AUSPEX_LIBRARY_DIR', 'AUSPEX_LOG_DIR', 'AUSPEX_MEMORY_DIR', 'AUSPEX_DATA_DIR']) delete env[k];
  client = new Client({ name: 'table-profile-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
});
after(async () => {
  await client?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const call = (name, args) => client.callTool({ name, arguments: args });
const result = r => JSON.parse(r.content[0].text);
const sections = { purpose: 'One row per order of Example Co.', usage: 'Daily order counts.' };
const auditEntries = () => {
  const dir = path.join(home, 'logs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)).map(l => JSON.parse(l)) : [];
};

test('table_profile is listed with get and save', async () => {
  const { tools } = await client.listTools();
  const tool = tools.find(t => t.name === 'table_profile');
  assert.ok(tool, 'registered');
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['get', 'save']);
  assert.match(tool.description, /no database access/);
});

test('save then get: sections, sources, version, author and freshness, without a database call', async () => {
  const saved = await call('table_profile', { profile: 'example', action: 'save', schema: 'example', table: 'orders', sections, sources: { usage: [{ type: 'report', ref: 'example-report' }, { type: 'note', ref: 1 }] }, language: 'en' });
  assert.ok(!saved.isError, saved.content[0].text);
  assert.deepEqual(result(saved), { relation: 'example.orders', stored: 'current', version: 1, author: 'agent' });
  const got = await call('table_profile', { profile: 'example', action: 'get', schema: 'example', table: 'orders' });
  assert.ok(!got.isError, got.content[0].text);
  const r = result(got);
  assert.equal(r.profile.version, 1);
  assert.equal(r.profile.author, 'agent');
  assert.equal(r.profile.freshness, 'fresh');
  assert.equal(r.profile.sections.usage, 'Daily order counts.');
  assert.deepEqual(r.profile.sources.usage, [{ type: 'report', ref: 'example-report' }, { type: 'note', ref: '1' }]);
  assert.deepEqual(r.inputs.reports, [{ key: 'example|Example Reports|example-report', title: 'Orders by day' }]);
  assert.ok(r.requiredTables.some(t => t.id === 'example.customers' && t.evidence[0].type === 'catalog'));
  assert.deepEqual(got.structuredContent.profile.version, 1);
  const entries = auditEntries();
  assert.equal(entries.filter(e => e.tool === 'table_profile' && e.action === 'save' && e.stored === 'current').length, 1, 'the save is audited');
  assert.ok(!JSON.stringify(entries).includes('Daily order counts'), 'no profile text in the audit log');
  assert.ok(!entries.some(e => e.sql || e.tool === 'check_profile'), 'no database call');
});

test('a user-owned profile turns an agent save into a proposal', async () => {
  const memory = new SchemaMemory(path.join(home, 'memory'));
  const current = memory.tableProfile('example', 'example', 'orders').profile.version;
  memory.saveTableProfile('example', { schema: 'example', table: 'orders', sections: { purpose: 'Written by the user.' }, expectedVersion: current }, { by: 'user' });
  const saved = result(await call('table_profile', { profile: 'example', action: 'save', schema: 'example', table: 'orders', sections }));
  assert.equal(saved.stored, 'proposal');
  const r = result(await call('table_profile', { profile: 'example', action: 'get', schema: 'example', table: 'orders' }));
  assert.equal(r.profile.sections.purpose, 'Written by the user.');
  assert.equal(r.proposal.version, saved.version);
});

test('invalid input is refused with INVALID_INPUT', async () => {
  const noSections = await call('table_profile', { profile: 'example', action: 'save', schema: 'example', table: 'orders' });
  assert.ok(noSections.isError);
  assert.equal(noSections.structuredContent.error.code, 'INVALID_INPUT');
  const extra = await call('table_profile', { profile: 'example', action: 'get', schema: 'example', table: 'orders', sections });
  assert.ok(extra.isError);
  const tooLong = await call('table_profile', { profile: 'example', action: 'save', schema: 'example', table: 'orders', sections: { purpose: 'x'.repeat(4001) } });
  assert.ok(tooLong.isError);
  const unknown = await call('table_profile', { profile: 'example', action: 'save', schema: 'example', table: 'nope', sections });
  assert.equal(unknown.structuredContent.error.code, 'NOT_FOUND');
});
