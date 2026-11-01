import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { toolGroups, toolGroupNames, resolveToolGroups, toolsOfGroups, toolGroupOf } from '../src/toolGroups.js';
import { readEnabledToolGroups, readProfilesFile } from '../src/config.js';
import { promptSkills } from '../src/skills.js';

// #160: enabledToolGroups chooses the callable tool set at startup.
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-groups-'));

function serverEnv(home, extra = {}) {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'profiles.json'), AUSPEX_DB_EXAMPLE: 'postgresql://auspex@127.0.0.1:1/example', ...extra };
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE)_/i.test(k) && k !== 'AUSPEX_DB_EXAMPLE') delete env[k];
  if (!extra.AUSPEX_ENABLED_TOOL_GROUPS) delete env.AUSPEX_ENABLED_TOOL_GROUPS;
  return env;
}

const clients = [];
after(async () => { for (const c of clients) await c.close(); });
async function start(extra = {}, profilesJson = null) {
  const home = tempDir();
  if (profilesJson) fs.writeFileSync(path.join(home, 'profiles.json'), JSON.stringify(profilesJson));
  const client = new Client({ name: 'groups-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: serverEnv(home, extra), stderr: 'ignore' }));
  clients.push(client);
  return { client, home };
}
function auditEntries(home) {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).filter(Boolean).map(l => JSON.parse(l));
}
const names = list => list.map(t => t.name).sort();

// ---------- validation ----------
test('no setting enables every group; a list keeps the fixed order and always adds core', () => {
  assert.deepEqual(resolveToolGroups(null), toolGroupNames);
  assert.deepEqual(resolveToolGroups(['query', ' Explore '], 'x'), ['core', 'explore', 'query']);
  assert.deepEqual(resolveToolGroups(['core', 'explore'], 'x'), ['core', 'explore']);
});

test('unknown names, an empty selection and missing dependencies stop the server with a clear message', () => {
  assert.throws(() => resolveToolGroups(['explore', 'admin'], 'AUSPEX_ENABLED_TOOL_GROUPS'), /unknown tool group "admin"; known groups: core, explore, query, reports, memory/);
  assert.throws(() => resolveToolGroups([], 'x'), /at least one group besides core/);
  assert.throws(() => resolveToolGroups(['core'], 'x'), /at least one group besides core/);
  assert.throws(() => resolveToolGroups(['memory'], 'x'), /"memory" needs "explore"/);
  assert.throws(() => resolveToolGroups('explore', 'x'), /expected a list/);
  assert.throws(() => resolveToolGroups([1], 'x'), /expected a list/);
});

test('the environment overrides the profiles file; the file key is a setting, not a profile', () => {
  const dir = tempDir();
  const file = path.join(dir, 'profiles.json');
  fs.writeFileSync(file, JSON.stringify({ enabledToolGroups: ['explore'], example: { url: 'postgresql://report_reader@db.example.test:5432/exampledb' } }));
  assert.deepEqual(readEnabledToolGroups(file, {}), { groups: ['core', 'explore'], source: 'file' });
  assert.deepEqual(readEnabledToolGroups(file, { AUSPEX_ENABLED_TOOL_GROUPS: 'query, explore' }), { groups: ['core', 'explore', 'query'], source: 'env' });
  assert.deepEqual(readEnabledToolGroups(path.join(dir, 'none.json'), {}), { groups: toolGroupNames, source: 'default' });
  assert.deepEqual(readProfilesFile(file).map(p => p.name), ['example']);
  fs.writeFileSync(file, JSON.stringify({ enabledToolGroups: ['reportz'] }));
  assert.throws(() => readEnabledToolGroups(file, {}), /"enabledToolGroups" in .*unknown tool group "reportz"/);
});

test('every tool belongs to exactly one group and every prompt names known groups', () => {
  const all = toolsOfGroups(toolGroupNames);
  assert.equal(new Set(all).size, all.length);
  for (const p of promptSkills) for (const g of p.groups) assert.ok(toolGroupNames.includes(g), `${p.prompt}: ${g}`);
  assert.equal(toolGroupOf('query'), 'query');
  assert.equal(toolGroupOf('no_such_tool'), null);
});

test('an invalid setting ends startup with exit code 1 instead of enabling everything', () => {
  const home = tempDir();
  const r = spawnSync(process.execPath, [serverPath], { env: serverEnv(home, { AUSPEX_ENABLED_TOOL_GROUPS: 'explore,admin' }), input: '', encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /configuration error: Invalid AUSPEX_ENABLED_TOOL_GROUPS: unknown tool group "admin"/);
});

// ---------- over the protocol ----------
test('default: the callable tool set is unchanged and is exactly the union of all groups', async () => {
  const { client } = await start();
  const { tools } = await client.listTools();
  assert.deepEqual(names(tools), toolsOfGroups(toolGroupNames).sort(), 'a tool missing from src/toolGroups.js stops the server; a group entry without a tool fails here');
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name).sort(), ['code', 'columns', 'ddl', 'explore', 'report']);
  const profiles = await client.callTool({ name: 'list_profiles', arguments: {} });
  assert.deepEqual(profiles.structuredContent.toolGroups, { enabled: toolGroupNames, source: 'default', disabledTools: [] });
  assert.doesNotMatch(client.getInstructions(), /not available/);
  const r = await client.getPrompt({ name: 'explore', arguments: {} });
  assert.doesNotMatch(r.messages[0].content.text, /Not available on this server/);
});

test('exploration only: tools/list, prompts and instructions show only what can be called', async () => {
  const { client, home } = await start({ AUSPEX_ENABLED_TOOL_GROUPS: 'explore' });
  const { tools } = await client.listTools();
  assert.deepEqual(names(tools), [...toolGroups.core, ...toolGroups.explore].sort());
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name), ['explore']);
  const text = (await client.getPrompt({ name: 'explore', arguments: { profile: 'example' } })).messages[0].content.text;
  const note = text.split('\n').find(l => l.startsWith('Not available on this server'));
  assert.ok(note, 'the prompt names the tools it mentions that are disabled');
  for (const t of ['query', 'remember', 'score_columns']) assert.match(note, new RegExp(`\\b${t}\\b`));
  assert.doesNotMatch(note, /\bdescribe_tables\b|\bexport_csv\b/, 'only tools the workflow mentions');
  const instructions = client.getInstructions();
  assert.doesNotMatch(instructions, /Report library:|Column importance:|save it with remember/);
  assert.match(instructions, /describe_tables for the structure/);
  assert.match(instructions, /these tools are not available: query, explain, export_csv, save_report/);
  const profiles = await client.callTool({ name: 'list_profiles', arguments: {} });
  assert.equal(profiles.structuredContent.toolGroups.source, 'env');
  assert.deepEqual(profiles.structuredContent.toolGroups.enabled, ['core', 'explore']);
  assert.equal(auditEntries(home).length, 0);
});

test('function_knowledge belongs to explore: listed and advised with it, absent without it', async () => {
  assert.equal(toolGroupOf('function_knowledge'), 'explore');
  const withExplore = await start({ AUSPEX_ENABLED_TOOL_GROUPS: 'explore' });
  assert.ok(names((await withExplore.client.listTools()).tools).includes('function_knowledge'));
  assert.match(withExplore.client.getInstructions(), /function_knowledge does the same/);
  const without = await start({ AUSPEX_ENABLED_TOOL_GROUPS: 'query' });
  assert.equal(names((await without.client.listTools()).tools).includes('function_knowledge'), false);
  const instructions = without.client.getInstructions();
  assert.doesNotMatch(instructions, /function_knowledge does the same/);
  assert.match(instructions, /these tools are not available: .*\bfunction_knowledge\b/);
});

test('a disabled tool called directly by name is refused with TOOL_DISABLED before any handler, database work or library change', async () => {
  const { client, home } = await start({ AUSPEX_ENABLED_TOOL_GROUPS: 'explore' });
  const q = await client.callTool({ name: 'query', arguments: { profile: 'example', sql: 'select 1' } });
  assert.equal(q.isError, true);
  assert.equal(q.structuredContent.error.code, 'TOOL_DISABLED');
  assert.equal(q.structuredContent.error.retryable, false);
  assert.match(q.content[0].text, /belongs to tool group "query".*enabledToolGroups is core, explore.*restart/);
  const saved = await client.callTool({ name: 'save_report', arguments: { db: 'example', schema: 'example', category: 'Orders', name: 'x', sql: 'select 1' } });
  assert.equal(saved.structuredContent.error.code, 'TOOL_DISABLED');
  assert.equal(fs.existsSync(path.join(home, 'library')), false, 'nothing was written to the library');
  const unknown = await client.callTool({ name: 'no_such_tool', arguments: {} });
  assert.equal(unknown.structuredContent.error.code, 'INVALID_INPUT', 'an unknown tool is answered as before');
  // Astra B-F2: a name that only starts with a disabled tool's name is unknown, not disabled.
  for (const name of ['query unknown', 'query not found', 'save_report x']) {
    const r = await client.callTool({ name, arguments: {} });
    assert.equal(r.structuredContent.error.code, 'INVALID_INPUT', name);
  }
  assert.deepEqual(auditEntries(home), [], 'refused before any audited work');
});

test('reports disabled: report workflows are hidden and report tools refused; profile selection stays', async () => {
  const { client } = await start({}, { enabledToolGroups: ['explore', 'query', 'memory'] });
  const { tools } = await client.listTools();
  const listed = names(tools);
  for (const t of toolGroups.reports) assert.ok(!listed.includes(t), t);
  for (const t of ['list_profiles', 'check_profile', 'query', 'remember']) assert.ok(listed.includes(t), t);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name).sort(), ['code', 'columns', 'explore']);
  const columns = (await client.getPrompt({ name: 'columns', arguments: {} })).messages[0].content.text;
  assert.match(columns.split('\n').find(l => l.startsWith('Not available')), /list_reports/);
  const run = await client.callTool({ name: 'run_report', arguments: { db: 'example', schema: 'example', category: 'Orders', name: 'x' } });
  assert.equal(run.structuredContent.error.code, 'TOOL_DISABLED');
  assert.doesNotMatch(client.getInstructions(), /Report library:/);
  assert.match(client.getInstructions(), /save it with remember/);
});
