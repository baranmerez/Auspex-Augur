import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Library } from '../src/reports/library.js';

// The real MCP server over stdio; tests/fixtures/fakeReportDb.mjs stands in
// for PostgreSQL, so run_report goes through its handler without a database.
// The profile's query budget is 1 per minute: each successful run below uses
// a fresh profile, which fails if one run_report were charged twice.
const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-run-audit-'));
const failHtml = path.join(home, 'fail-html');
let client;

const profiles = ['example', 'exampledb', 'test'];
before(async () => {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_TEST_FAIL_HTML: failHtml };
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE|SCRIPT_ROOT)_/i.test(k)) delete env[k];
  for (const p of profiles) {
    env[`AUSPEX_DB_${p.toUpperCase()}`] = `postgresql://report_reader@db.example.test:1/${p}`;
    env[`AUSPEX_MAX_QUERIES_PER_MINUTE_${p.toUpperCase()}`] = '1';
  }
  client = new Client({ name: 'run-audit-test', version: '1.0.0' });
  const fake = pathToFileURL(path.join(here, 'fixtures', 'fakeReportDb.mjs')).href;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', fake, path.join(here, '..', 'src', 'index.js')], env, stderr: 'ignore' }));
});
after(async () => { await client?.close(); });

const call = (name, args) => client.callTool({ name, arguments: args });
const auditEntries = () => {
  const dir = path.join(home, 'logs');
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
};
// Every entry of one tool call, found by the correlation ID of its result.
const entriesOf = result => auditEntries().filter(e => e.correlationId === result._meta.correlationId);
const errorCodeOf = result => result.structuredContent?.error?.code;

async function saved(db, name, sql = 'select 1 as id') {
  const ref = { db, schema: 'example', category: 'Audit', name };
  const res = await call('save_report', { ...ref, sql });
  assert.ok(!res.isError, res.content[0].text);
  return ref;
}

test('a successful run_report writes one terminal entry with its database phase', async () => {
  const ref = await saved('example', 'ok');
  const res = await call('run_report', { ...ref, analyze: 'never', previewRows: 2 });
  assert.ok(!res.isError, res.content[0].text);
  const entries = entriesOf(res);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  const [e] = entries;
  assert.equal(e.tool, 'run_report');
  assert.equal(e.report, 'example/example/Audit/ok');
  assert.equal(e.error, undefined);
  assert.equal(e.stage, 'draft');
  assert.match(e.sqlHash, /^[0-9a-f]{12}$/);
  assert.equal(e.rowCount, 2);
  assert.ok(Number.isFinite(e.phases?.database?.ms), 'the database phase is timed');
  assert.equal(e.phases.database.errorCode, undefined);
  assert.ok(e.ms >= e.phases.database.ms);
});

test('a .sql file changed outside save_report is refused and audited', async () => {
  const ref = await saved('exampledb', 'edited');
  fs.writeFileSync(new Library(path.join(home, 'library')).paths('draft', ref).sql, 'select 2 as id\n');
  const res = await call('run_report', { ...ref, analyze: 'never' });
  assert.equal(errorCodeOf(res), 'PRECONDITION_FAILED');
  const entries = entriesOf(res);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(entries[0].tool, 'run_report');
  assert.equal(entries[0].errorCode, 'PRECONDITION_FAILED');
  assert.equal(entries[0].phases, undefined, 'refused before the database');
});

test('params together with preset are refused and audited', async () => {
  const ref = await saved('exampledb', 'both', 'select $1::int as id');
  const res = await call('run_report', { ...ref, params: [1], preset: 'today' });
  assert.equal(errorCodeOf(res), 'INVALID_INPUT');
  const entries = entriesOf(res);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(entries[0].errorCode, 'INVALID_INPUT');
  assert.equal(entries[0].phases, undefined);
});

test('a missing report is refused and audited', async () => {
  const res = await call('run_report', { db: 'exampledb', schema: 'example', category: 'Audit', name: 'missing' });
  assert.ok(res.isError);
  const entries = entriesOf(res);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(entries[0].errorCode, errorCodeOf(res));
});

test('a disk error after the query leaves a failed terminal entry, not a successful one', async () => {
  const ref = await saved('test', 'eio');
  fs.writeFileSync(failHtml, '');
  let res;
  try {
    res = await call('run_report', { ...ref, analyze: 'never', previewRows: 2 });
  } finally {
    fs.rmSync(failHtml, { force: true });
  }
  assert.ok(res.isError);
  const entries = entriesOf(res);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  const [e] = entries;
  assert.match(e.error, /EIO/);
  assert.equal(e.errorCode, errorCodeOf(res));
  assert.ok(Number.isFinite(e.phases?.database?.ms), 'the query ran');
  assert.equal(e.phases.database.errorCode, undefined, 'the database phase itself succeeded');
  const raw = JSON.stringify(e);
  assert.ok(!raw.includes('"preview"') && !raw.includes('maskedColumns'), 'no preview values or masking input');
});
