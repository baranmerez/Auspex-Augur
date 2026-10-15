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
