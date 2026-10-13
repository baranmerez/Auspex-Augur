import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyDatabase } from '../src/db.js';
import { search, listTables, describeTable, listSchemas } from '../src/catalog.js';

const profiles = new Map([['local', 'postgresql://u@127.0.0.1:1/none']]);

function recorder() {
  const entries = [];
  return { entries, audit: e => entries.push(e) };
}

test('a query rejected by the SQL guard is logged with its error', async () => {
  const { entries, audit } = recorder();
  const db = new ReadOnlyDatabase({ profiles, statementTimeoutMs: 1000 }, { audit, source: 'mcp' });
  await assert.rejects(db.query('local', 'delete from t', []));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'mcp');
  assert.equal(entries[0].tool, 'query');
  assert.equal(entries[0].profile, 'local');
  assert.equal(entries[0].sql, 'delete from t');
  assert.match(entries[0].error, /Only SELECT/);
  assert.equal(typeof entries[0].ms, 'number');
});

test('connection failures and missing profiles are logged', async () => {
  const { entries, audit } = recorder();
  const db = new ReadOnlyDatabase({ profiles, statementTimeoutMs: 1000 }, { audit });
  await assert.rejects(db.explain('local', 'select 1', [], true));
  await assert.rejects(db.query(undefined, 'select 1'));
  assert.deepEqual(entries.map(e => [e.source, e.tool, e.analyze ?? null]), [['script', 'explain', true], ['script', 'query', null]]);
  assert.match(entries[0].error, /Could not connect/);
  assert.match(entries[1].error, /profile is required/);
  await db.close();
});

test('catalog operations are logged', async () => {
  const { entries, audit } = recorder();
  const db = new ReadOnlyDatabase({ profiles, statementTimeoutMs: 1000 }, { audit });
  await assert.rejects(search(db, 'local', 'invoice'));
  await assert.rejects(listTables(db, 'local', 'public', '%x%'));
  await assert.rejects(describeTable(db, 'local', 'sales', 'orders'));
  await assert.rejects(listSchemas(db, 'local'));
  assert.deepEqual(entries.map(e => e.tool), ['search', 'list_tables', 'describe_table', 'list_schemas']);
  assert.equal(entries[0].text, 'invoice');
  assert.equal(entries[2].table, 'orders');
  await db.close();
});

test('without an explicit audit function entries go to the configured log dir', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-audit-'));
  const db = new ReadOnlyDatabase({ profiles, statementTimeoutMs: 1000, logDir });
  await assert.rejects(db.query('local', 'update t set a = 1'));
  const [file] = fs.readdirSync(logDir);
  const line = JSON.parse(fs.readFileSync(path.join(logDir, file), 'utf8').trim());
  assert.equal(line.source, 'script');
  assert.equal(line.tool, 'query');
  assert.ok(line.ts);
});
