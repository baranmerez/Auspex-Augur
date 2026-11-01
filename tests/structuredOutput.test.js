import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SchemaMemory } from '../src/memory/store.js';
import { queryOutput, explainOutput, tableKnowledgeOutput } from '../src/outputSchemas.js';

// #159: successful results carry structuredContent next to the JSON text;
// query, explain and table_knowledge advertise an outputSchema that matches
// their real results (validated by the MCP SDK before every reply).

let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1) + (clock++) * 60000).toISOString();
const col = (column, attnum, type = 'integer') => ({ column, attnum, type, not_null: false, default: null, comment: null });
const trigger = name => ({
  name, timing: 'BEFORE', events: ['INSERT'], level: 'ROW', enabled: 'enabled', function: 'example.orders_before_write',
  whenCondition: null, definition: `CREATE TRIGGER ${name} BEFORE INSERT ON example.orders FOR EACH ROW EXECUTE FUNCTION example.orders_before_write()`,
});
const ordersDescribe = () => ({
  profile: 'example', relation: 'example.orders', schema: 'example', table: 'orders', kind: 'table', oid: 2001, estimated_rows: 1000, comment: 'Orders',
  columns: [col('order_id', 1), col('customer_id', 2), col('amount', 3, 'numeric'), col('created_at', 4, 'timestamp')],
  constraints: [
    { name: 'orders_pkey', type: 'primary key', definition: 'PRIMARY KEY (order_id)', columns: ['order_id'], ref_schema: null, ref_table: null, ref_columns: null },
    { name: 'orders_customer_fk', type: 'foreign key', definition: 'FOREIGN KEY (customer_id) REFERENCES example.customers(customer_id)', columns: ['customer_id'], ref_schema: 'example', ref_table: 'customers', ref_columns: ['customer_id'] },
  ],
  indexes: [], referencedBy: [], triggers: [trigger('orders_check')],
});

const valid = (schema, value) => {
  const r = schema.safeParse(JSON.parse(JSON.stringify(value)));
  assert.ok(r.success, JSON.stringify(r.error?.issues));
};

test('table_knowledge results match the schema: unknown table, bare record, and a record with notes, scores and triggers', () => {
  const mem = new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-structured-')), { now });
  valid(tableKnowledgeOutput, mem.knowledge('example', 'example', 'orders'));
  mem.addNote('example', { kind: 'rule', text: 'Database-wide rule.' });
  mem.addNote('example', { kind: 'rule', schema: 'example', table: 'orders', text: 'Rule on a table not described yet.' });
  const unknown = mem.knowledge('example', 'example', 'orders');
  assert.equal(unknown.known, false);
  valid(tableKnowledgeOutput, unknown);

  mem.recordDescribe(ordersDescribe());
  valid(tableKnowledgeOutput, mem.knowledge('example', 'example', 'orders'));
  mem.addNote('example', { kind: 'observation', schema: 'example', table: 'orders', column: 'amount', text: 'Never negative.', evidence: { sql: 'select min(amount) from example.orders', figures: { min: '0.00' } } });
  mem.addNote('example', { kind: 'inference', text: 'An unconfirmed reading.' });
  mem.scoreColumns('example', {
    schema: 'example', table: 'orders',
    columns: [{ name: 'order_id', score: 5, roles: ['key'], reason: 'Main key', sources: 3 }, { name: 'amount', by: 'user', score: 4 }],
    triggers: [{ name: 'orders_check', summary: 'Checks new orders.' }],
  });
  const full = mem.knowledge('example', 'example', 'orders');
  assert.equal(full.known, true);
  assert.ok(full.columnScores.length && full.triggers.length && full.notes.length && full.databaseNotes.length);
  valid(tableKnowledgeOutput, full);
});

test('query results match the schema: empty, truncated, exact text values, notes and memory failures', () => {
  valid(queryOutput, { profile: 'example', columns: [], rows: [], rowCount: 0, truncated: false });
  valid(queryOutput, {
    profile: 'example', columns: ['amount', 'big', 'at', 'doc', 'ok', 'n', 'f', 'raw'],
    rows: [['12345678901234567890.000000000000000001', '9007199254740993', '2026-01-01 10:00:00', '{"a": 1.000000000000000001}', true, 5, 1.5, null]],
    rowCount: 1, truncated: true,
    notes: ['rule: example rule'], memoryError: 'disk full', memoryErrorCode: 'DISK_ERROR', partialCommit: { written: 1, total: 2 },
  });
  const bad = queryOutput.safeParse({ profile: 'example', columns: ['x'], rows: [[{ nested: 1 }]], rowCount: 1, truncated: false });
  assert.equal(bad.success, false, 'cells are scalars');
});

test('explain results match the schema with and without memory fields', () => {
  valid(explainOutput, { profile: 'example', analyzed: false, plan: 'Seq Scan on example.orders' });
  valid(explainOutput, { profile: 'example', analyzed: true, plan: 'Result', notes: ['x'], unexploredNeighbors: { tables: ['example.customers'], more: 0 }, repair: { error: 'x' } });
});

test('validating a result never changes it: exact numerics stay text', () => {
  const result = { profile: 'example', columns: ['n'], rows: [['9007199254740993']], rowCount: 1, truncated: false };
  const parsed = queryOutput.parse(result);
  assert.equal(parsed.rows[0][0], '9007199254740993');
  assert.equal(typeof parsed.rows[0][0], 'string');
});

// ---------- over the protocol ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-structured-mcp-'));
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
let client;

before(async () => {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_DB_EXAMPLE: 'postgresql://auspex@127.0.0.1:1/example' };
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE|ENABLED_TOOL_GROUPS)/i.test(k) && k !== 'AUSPEX_DB_EXAMPLE') delete env[k];
  client = new Client({ name: 'structured-mcp-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
});
after(async () => { await client?.close(); });

test('tools/list advertises an outputSchema for query, explain and table_knowledge only; open to new fields', async () => {
  const { tools } = await client.listTools();
  const withSchema = tools.filter(t => t.outputSchema).map(t => t.name).sort();
  assert.deepEqual(withSchema, ['explain', 'query', 'table_knowledge']);
  const query = tools.find(t => t.name === 'query').outputSchema;
  assert.equal(query.type, 'object');
  assert.deepEqual(query.required.sort(), ['columns', 'profile', 'rowCount', 'rows', 'truncated']);
  assert.notEqual(query.additionalProperties, false);
  assert.deepEqual(tools.find(t => t.name === 'table_knowledge').outputSchema.required.sort(), ['known', 'relation']);
  assert.deepEqual(tools.find(t => t.name === 'explain').outputSchema.required.sort(), ['analyzed', 'plan', 'profile']);
});

test('a success carries the same data as text and as structuredContent, validated by the SDK', async () => {
  const r = await client.callTool({ name: 'table_knowledge', arguments: { profile: 'example', schema: 'example', table: 'orders' } });
  assert.equal(r.isError, undefined);
  // A text-only consumer reads the first block as before.
  assert.equal(r.content.length, 1);
  const fromText = JSON.parse(r.content[0].text);
  assert.deepEqual(r.structuredContent, fromText);
  assert.equal(fromText.known, false);
  assert.ok(r._meta.correlationId);
});

test('a missing cached object and memory notes still validate after a remember', async () => {
  const saved = await client.callTool({ name: 'remember', arguments: { profile: 'example', action: 'add', kind: 'rule', schema: 'example', table: 'orders', text: 'Amounts are stored with two decimals.' } });
  assert.equal(saved.isError, undefined);
  assert.equal(saved.structuredContent.note.kind, 'rule', 'schema-less tools carry structuredContent too');
  const r = await client.callTool({ name: 'table_knowledge', arguments: { profile: 'example', schema: 'example', table: 'orders' } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(r.structuredContent.notes[0].text, 'Amounts are stored with two decimals.');
});

// SDK clients validate any structuredContent against the outputSchema, also
// on errors; tools with a schema carry the envelope in the JSON text block.
const envelope = r => JSON.parse(r.content[1].text).error;

test('errors of tools with an outputSchema keep isError and the envelope in text, without structuredContent', async () => {
  const r = await client.callTool({ name: 'query', arguments: { profile: 'nope', sql: 'select 1' } });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent, undefined);
  assert.match(r.content[0].text, /Unknown profile/);
  assert.equal(envelope(r).code, 'PROFILE_INVALID');
  assert.equal(envelope(r).retryable, false);
  const conn = await client.callTool({ name: 'explain', arguments: { profile: 'example', sql: 'select 1' } });
  assert.equal(conn.isError, true);
  assert.equal(envelope(conn).code, 'CONNECTION_FAILED');
  assert.equal(envelope(conn).retryable, true);
  // An SDK-level failure (input validation) of such a tool is handled the same way.
  const invalid = await client.callTool({ name: 'table_knowledge', arguments: { profile: 'example' } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
  assert.equal(envelope(invalid).code, 'INVALID_INPUT');
});

test('errors of schema-less tools still carry the envelope as structuredContent', async () => {
  const r = await client.callTool({ name: 'list_schemas', arguments: { profile: 'nope' } });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'PROFILE_INVALID');
  assert.deepEqual(JSON.parse(r.content[1].text), r.structuredContent);
  const invalid = await client.callTool({ name: 'list_schemas', arguments: {} });
  assert.equal(invalid.structuredContent.error.code, 'INVALID_INPUT');
});
