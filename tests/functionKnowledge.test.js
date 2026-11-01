import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SchemaMemory } from '../src/memory/store.js';
import { exampleFunctions, viewDescribe } from './fixtures/exampleMemory.js';

// function_knowledge answers from synthetic cached records only (#151).
let clock = 0;
const now = () => new Date(Date.UTC(2026, 1, 1) + (clock++) * 60000).toISOString();
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-fn-knowledge-'));
const profile = 'exampledb';

function seeded(dir = tempDir()) {
  const mem = new SchemaMemory(dir, { now });
  mem.recordDescribeMany(profile, [viewDescribe(profile)]);
  mem.recordFunctions(profile, exampleFunctions());
  mem.recordListedFunctions(profile, [
    { schema: 'example', name: 'order_count', arguments: 'p_customer_id bigint', returns: 'bigint', kind: 'function', language: 'sql', volatility: 'stable' },
  ]);
  return mem;
}

test('a described function: overloads, state, definition availability, no source by default', () => {
  const mem = seeded();
  const k = mem.functionKnowledge(profile, 'example', 'order_total');
  assert.equal(k.known, true);
  assert.equal(k.state, 'described');
  assert.ok(k.describedAt && k.firstSeen && k.lastSeen);
  assert.match(k.note, /not a guarantee about the database now/);
  assert.equal(k.overloadCount, 2);
  assert.deepEqual(k.overloads.map(o => o.arguments), ['p_order_id bigint', 'p_order_id bigint, p_currency text']);
  for (const o of k.overloads) {
    assert.equal(o.definitionAvailable, true);
    assert.equal(o.storedTruncated, false);
    assert.ok(o.definitionLength > 0);
    assert.equal(o.definition, undefined, 'no source text unless asked');
  }
  assert.deepEqual(k.overloads[0].inferred.reads, ['example.order_items']);
  assert.match(k.overloads[0].inferred.note, /not resolved to an overload/);
  assert.deepEqual(k.calledBy.functions, ['example.order_report'], 'a caller from a stored body');
  assert.match(k.calledBy.note, /inference/);
  assert.equal(k.overloadFound, undefined);
});

test('a listed-only function has no definition and says so', () => {
  const mem = seeded();
  const k = mem.functionKnowledge(profile, 'example', 'order_count');
  assert.equal(k.state, 'listed-only');
  assert.equal(k.describedAt, null);
  assert.deepEqual(k.overloads.map(o => [o.arguments, o.listedOnly, o.definitionAvailable, o.definitionLength]), [['p_customer_id bigint', true, false, null]]);
  const withText = mem.functionKnowledge(profile, 'example', 'order_count', { definitionChars: 100 });
  assert.equal(withText.overloads[0].definition, undefined);
});

test('overload selection is exact and never substitutes another overload', () => {
  const mem = seeded();
  const one = mem.functionKnowledge(profile, 'example', 'order_total', { arguments: 'p_order_id bigint, p_currency text' });
  assert.equal(one.overloadFound, true);
  assert.deepEqual(one.overloads.map(o => o.arguments), ['p_order_id bigint, p_currency text']);
  const miss = mem.functionKnowledge(profile, 'example', 'order_total', { arguments: 'p_order_id integer' });
  assert.equal(miss.known, true);
  assert.equal(miss.overloadFound, false);
  assert.equal(miss.overloads, undefined);
  assert.deepEqual(miss.knownOverloads, ['p_order_id bigint', 'p_order_id bigint, p_currency text']);
  const prefix = mem.functionKnowledge(profile, 'example', 'order_total', { arguments: 'p_order_id' });
  assert.equal(prefix.overloadFound, false, 'no prefix or fuzzy match');
});

test('the definition comes back only for one overload, cut at definitionChars', () => {
  const mem = seeded();
  const both = mem.functionKnowledge(profile, 'example', 'order_total', { definitionChars: 50 });
  assert.ok(both.overloads.every(o => o.definition === undefined));
  assert.match(both.definitionOmitted, /one overload/);
  const one = mem.functionKnowledge(profile, 'example', 'order_total', { arguments: 'p_order_id bigint', definitionChars: 50 });
  const [o] = one.overloads;
  assert.equal(o.definition.length, 50);
  assert.equal(o.definitionReturnedChars, 50);
  assert.equal(o.definitionTruncated, true);
  const single = mem.functionKnowledge(profile, 'example', 'order_report', { definitionChars: 100000 });
  assert.equal(single.overloads[0].definitionTruncated, false);
  assert.equal(single.overloads[0].definition.length, single.overloads[0].definitionLength);
});

test('a definition stored truncated reports its full length and storedTruncated', () => {
  const mem = new SchemaMemory(tempDir(), { now });
  const [a] = exampleFunctions();
  mem.recordFunctions(profile, [{ ...a, memoryDefinition: 'x'.repeat(300), definitionLength: 250000 }]);
  const k = mem.functionKnowledge(profile, 'example', 'order_total', { definitionChars: 20000 });
  const [o] = k.overloads;
  assert.equal(o.storedTruncated, true);
  assert.equal(o.definitionLength, 250000);
  assert.equal(o.definitionReturnedChars, 300);
  assert.equal(o.definitionTruncated, true);
});

test('oversized relationship lists are capped with an omitted count', () => {
  const mem = new SchemaMemory(tempDir(), { now });
  const [a] = exampleFunctions();
  const usedByTriggers = Array.from({ length: 30 }, (_, i) => ({ schema: 'example', tableName: `t${String(i).padStart(2, '0')}`, trigger: `trg_${i}`, table: `example.t${i}` }));
  const reads = Array.from({ length: 25 }, (_, i) => `example.r${String(i).padStart(2, '0')}`).map(t => `SELECT 1 FROM ${t};`).join('\n');
  const body = `CREATE OR REPLACE FUNCTION example.order_total(p_order_id bigint)\n RETURNS numeric\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n${reads}\nRETURN 0;\nEND\n$function$\n`;
  mem.recordFunctions(profile, [{ ...a, usedByTriggers, definition: body }]);
  const k = mem.functionKnowledge(profile, 'example', 'order_total', { maxItems: 10 });
  const [o] = k.overloads;
  assert.equal(o.usedByTriggers.length, 10);
  assert.equal(o.usedByTriggersOmitted, 20);
  assert.equal(o.inferred.reads.length, 10);
  assert.equal(o.inferred.readsOmitted, 15);
  const all = mem.functionKnowledge(profile, 'example', 'order_total');
  assert.equal(all.overloads[0].usedByTriggers.length, 20, 'default cap');
  assert.equal(all.overloads[0].usedByTriggersOmitted, 10);
});

test('the overload config list is capped with an omitted count', () => {
  const mem = new SchemaMemory(tempDir(), { now });
  const [a] = exampleFunctions();
  const config = Array.from({ length: 30 }, (_, i) => `example.setting_${i}=on`);
  mem.recordFunctions(profile, [{ ...a, config }]);
  const [o] = mem.functionKnowledge(profile, 'example', 'order_total', { maxItems: 2 }).overloads;
  assert.deepEqual(o.config, config.slice(0, 2));
  assert.equal(o.configOmitted, 28);
  const [small] = mem.functionKnowledge(profile, 'example', 'order_total', { maxItems: 50 }).overloads;
  assert.equal(small.config.length, 30);
  assert.equal(small.configOmitted, undefined);
});

test('quoted identifiers and profile boundaries: exact names, no cross-profile answer', () => {
  const mem = new SchemaMemory(tempDir(), { now });
  const [a] = exampleFunctions();
  mem.recordFunctions(profile, [{ ...a, schema: 'Example.Sales', name: 'Order "Total"' }]);
  mem.recordFunctions('otherdb', [{ ...a, definition: a.definition.replace('sum(amount)', 'max(amount)') }]);
  const quoted = mem.functionKnowledge(profile, 'Example.Sales', 'Order "Total"');
  assert.equal(quoted.known, true);
  assert.equal(quoted.function, '"Example.Sales"."Order ""Total"""');
  assert.equal(mem.functionKnowledge(profile, 'example.sales', 'order "total"').known, false, 'names are not case-folded');
  assert.equal(mem.functionKnowledge(profile, 'example', 'order_total').known, false, 'otherdb record is not visible in exampledb');
  const other = mem.functionKnowledge('otherdb', 'example', 'order_total', { definitionChars: 20000 });
  assert.match(other.overloads[0].definition, /max\(amount\)/);
});

test('an unknown function is a cache miss with a hint, nothing is recorded', () => {
  const dir = tempDir();
  const mem = new SchemaMemory(dir, { now });
  const k = mem.functionKnowledge(profile, 'example', 'missing_fn');
  assert.deepEqual(Object.keys(k).sort(), ['function', 'hint', 'known']);
  assert.equal(k.known, false);
  assert.match(k.hint, /describe_functions/);
  assert.equal(fs.existsSync(path.join(dir, profile, 'functions')), false);
});

test('recent changes come from the stored history', () => {
  const mem = seeded();
  const [a, b] = exampleFunctions();
  mem.recordFunctions(profile, [{ ...a, definition: a.definition.replace('sum(amount)', 'sum(amount) * 2') }, b]);
  const k = mem.functionKnowledge(profile, 'example', 'order_total');
  assert.equal(k.recentChanges.length, 1);
  assert.match(k.recentChanges[0], /definition of \(p_order_id bigint\) changed/);
});

// Over the real MCP server with a profile that can never connect.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-fn-knowledge-mcp-'));
let client;
after(async () => { await client?.close(); });

test('MCP function_knowledge answers with PostgreSQL unreachable and audits no database call', async () => {
  seeded(path.join(home, 'memory')).recordFunctions('example', exampleFunctions());
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_DB_EXAMPLE: 'postgresql://auspex@127.0.0.1:1/example' };
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE|MEMORY)_/i.test(k) && k !== 'AUSPEX_DB_EXAMPLE') delete env[k];
  delete env.AUSPEX_MEMORY_DIR;
  client = new Client({ name: 'fn-knowledge-test', version: '1.0.0' });
  const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
  const { tools } = await client.listTools();
  const tool = tools.find(t => t.name === 'function_knowledge');
  assert.ok(tool, 'function_knowledge is registered');
  assert.deepEqual(tool.inputSchema.required.sort(), ['name', 'profile', 'schema']);
  assert.equal(tool.inputSchema.properties.definitionChars.maximum, 20000);
  assert.equal(tool.inputSchema.properties.maxItems.maximum, 200);
  const res = await client.callTool({ name: 'function_knowledge', arguments: { profile: 'example', schema: 'example', name: 'order_total', arguments: 'p_order_id bigint' } });
  assert.notEqual(res.isError, true);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.known, true);
  assert.deepEqual(body.overloads.map(o => o.arguments), ['p_order_id bigint']);
  const miss = JSON.parse((await client.callTool({ name: 'function_knowledge', arguments: { profile: 'example', schema: 'example', name: 'nope' } })).content[0].text);
  assert.equal(miss.known, false);
  const logs = path.join(home, 'logs');
  const entries = fs.existsSync(logs) ? fs.readdirSync(logs).flatMap(f => fs.readFileSync(path.join(logs, f), 'utf8').trim().split('\n')).filter(Boolean) : [];
  assert.deepEqual(entries.filter(l => /"sql"|withReadOnly|role/.test(l)), [], 'no database statement was audited');
});
