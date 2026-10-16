import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Catalog tools over the real MCP server (stdio) with a profile that is never
// reachable: input schemas, validation and auditing without a database.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-catalog-mcp-'));
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
let client;

before(async () => {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_DB_SHOP: 'postgresql://auspex@127.0.0.1:1/shop' };
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE)_/i.test(k) && k !== 'AUSPEX_DB_SHOP') delete env[k];
  client = new Client({ name: 'catalog-mcp-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
});
after(async () => { await client?.close(); });

const call = (name, args) => client.callTool({ name, arguments: args });
function auditEntries() {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).filter(Boolean).map(l => JSON.parse(l));
}

test('relation_stats is listed with its input schema', async () => {
  const { tools } = await client.listTools();
  const tool = tools.find(t => t.name === 'relation_stats');
  assert.ok(tool, 'relation_stats is registered');
  assert.deepEqual(tool.inputSchema.required.sort(), ['profile', 'tables']);
  assert.equal(tool.inputSchema.properties.tables.maxItems, 50);
  assert.equal(tool.inputSchema.properties.schema.type, 'string');
  assert.match(tool.description, /at most 2 statements/i);
});

test('describe_functions and the extended search are listed with their input schemas', async () => {
  const { tools } = await client.listTools();
  const describe = tools.find(t => t.name === 'describe_functions');
  assert.ok(describe, 'describe_functions is registered');
  assert.deepEqual(describe.inputSchema.required, ['profile']);
  assert.equal(describe.inputSchema.properties.functions.maxItems, 50);
  assert.equal(describe.inputSchema.properties.maxChars.maximum, 200000);
  const searchTool = tools.find(t => t.name === 'search');
  assert.equal(searchTool.inputSchema.properties.searchSource.type, 'boolean');
  assert.equal(searchTool.inputSchema.properties.includeRoutines.type, 'boolean');
  assert.match(tools.find(t => t.name === 'describe_tables').description, /6, or 7 when/);
});

test('save_report text fields and the server instructions point to notesLanguage', async () => {
  const { tools } = await client.listTools();
  const props = tools.find(t => t.name === 'save_report').inputSchema.properties;
  for (const field of ['title', 'description', 'note']) assert.match(props[field].description, /notesLanguage/);
  assert.match(client.getInstructions(), /save_report title, description and note/);
});

test('describe_tables offers detail summary (default) or full; a bad value is refused by the schema', async () => {
  const { tools } = await client.listTools();
  const describe = tools.find(t => t.name === 'describe_tables');
  assert.deepEqual(describe.inputSchema.properties.detail.enum, ['summary', 'full']);
  assert.deepEqual(describe.inputSchema.required.sort(), ['profile', 'tables']);
  assert.match(describe.description, /detail "summary" \(default\)/);
  assert.match(describe.description, /from the full catalog data in either mode/);
  const before = auditEntries().length;
  const bad = await call('describe_tables', { profile: 'shop', tables: ['sales.orders'], detail: 'everything' });
  assert.ok(bad.isError);
  assert.equal(bad.structuredContent.error.code, 'INVALID_INPUT');
  assert.equal(auditEntries().length, before, 'schema validation happens before the handler');
  const res = await call('describe_tables', { profile: 'shop', tables: ['sales.orders'], detail: 'full' });
  assert.equal(res.structuredContent.error.code, 'CONNECTION_FAILED');
});

test('profile_tables lists parentFilter; a bad op, too many conditions or a filter without parent are refused', async () => {
  const { tools } = await client.listTools();
  const filter = tools.find(t => t.name === 'profile_tables').inputSchema.properties.parentFilter;
  assert.equal(filter.maxItems, 5);
  assert.deepEqual(filter.items.properties.op.enum, ['=', '<>', '>', '>=', '<', '<=', 'in', 'not in', 'is null', 'is not null']);
  assert.deepEqual(filter.items.required.sort(), ['column', 'op']);
  const parent = { table: 'sales.customer', key: 'id' };
  const badOp = await call('profile_tables', { profile: 'shop', tables: ['sales.orders'], parent, parentFilter: [{ column: 'id', op: 'like', value: 'x' }] });
  assert.equal(badOp.structuredContent.error.code, 'INVALID_INPUT');
  const tooMany = await call('profile_tables', { profile: 'shop', tables: ['sales.orders'], parent, parentFilter: Array.from({ length: 6 }, () => ({ column: 'id', op: 'is null' })) });
  assert.equal(tooMany.structuredContent.error.code, 'INVALID_INPUT');
  const noParent = await call('profile_tables', { profile: 'shop', tables: ['sales.orders'], parentFilter: [{ column: 'id', op: 'is null' }] });
  assert.equal(noParent.structuredContent.error.code, 'INVALID_INPUT');
  const [logged] = auditEntries().filter(e => e.correlationId === noParent._meta.correlationId);
  assert.deepEqual([logged.tool, logged.errorCode], ['profile_tables', 'INVALID_INPUT'], 'refused by the handler before connecting, and audited');
  const arity = await call('profile_tables', { profile: 'shop', tables: ['sales.orders'], parent, parentFilter: [{ column: 'id', op: 'in', value: 1 }] });
  assert.equal(arity.structuredContent.error.code, 'INVALID_INPUT');
});

test('describe_functions without functions or pattern is refused before connecting and audited', async () => {
  const res = await call('describe_functions', { profile: 'shop' });
  assert.ok(res.isError);
  assert.equal(res.structuredContent.error.code, 'INVALID_INPUT');
  const [logged] = auditEntries().filter(e => e.correlationId === res._meta.correlationId);
  assert.deepEqual([logged.tool, logged.errorCode], ['describe_functions', 'INVALID_INPUT']);
  const connect = await call('describe_functions', { profile: 'shop', pattern: 'example_co' });
  assert.equal(connect.structuredContent.error.code, 'CONNECTION_FAILED');
});

test('relation_stats: oversized input is refused by the schema, a real call is audited once', async () => {
  const before = auditEntries().length;
  const tooMany = await call('relation_stats', { profile: 'shop', tables: Array.from({ length: 51 }, (_, i) => `s.t${i}`) });
  assert.ok(tooMany.isError);
  assert.equal(tooMany.structuredContent.error.code, 'INVALID_INPUT');
  assert.equal(auditEntries().length, before, 'schema validation happens before the handler');

  const res = await call('relation_stats', { profile: 'shop', tables: ['sales.orders'], schema: 'sales' });
  assert.ok(res.isError);
  assert.equal(res.structuredContent.error.code, 'CONNECTION_FAILED');
  const logged = auditEntries().filter(e => e.correlationId === res._meta.correlationId);
  assert.equal(logged.length, 1);
  assert.deepEqual([logged[0].tool, logged[0].tables, logged[0].schema, logged[0].errorCode], ['relation_stats', ['sales.orders'], 'sales', 'CONNECTION_FAILED']);
});
