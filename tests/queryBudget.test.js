import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyDatabase, QueryBudgetError } from '../src/db.js';
import { loadConfig } from '../src/config.js';

// Fake database with an injected clock: counts connections, answers every
// statement with an empty result, and has a role check already passed.
function fakeDb(budget = {}, { source = 'mcp' } = {}) {
  let connects = 0;
  let clock = 1_000_000;
  const client = { async query() { return { rows: [], fields: [] }; }, release() {} };
  const audit = [];
  const config = {
    profiles: new Map([['shop', 'postgresql://u@127.0.0.1:1/a'], ['crm', 'postgresql://u@127.0.0.1:1/b']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 10, maxCellChars: 100, ...budget,
  };
  const db = new ReadOnlyDatabase(config, { audit: e => audit.push(e), source, now: () => clock });
  db.pool = () => ({ connect: async () => { connects++; return client; } });
  for (const name of config.profiles.keys()) db.roleChecks.set(name, { status: 'ok', blocking: [], warnings: [] });
  return { db, audit, connects: () => connects, advance: ms => { clock += ms; } };
}

const query = (db, profile = 'shop') => db.query(profile, 'select 1');

test('calls under the limit pass', async () => {
  const { db, connects } = fakeDb({ maxQueriesPerMinute: 3 });
  for (let i = 0; i < 3; i++) await query(db);
  assert.equal(connects(), 3);
});

test('the call over the limit is refused before connecting and audited with the error', async () => {
  const { db, audit, connects, advance } = fakeDb({ maxQueriesPerMinute: 3 }, { source: 'script' });
  for (let i = 0; i < 3; i++) {
    await query(db);
    advance(10000);
  }
  await assert.rejects(query(db), err => {
    assert.ok(err instanceof QueryBudgetError);
    assert.match(err.message, /Query budget exhausted for profile "shop": 3 database operations in the last minute, limit 3 per minute/);
    assert.match(err.message, /next slot frees up in 30 s/);
    assert.match(err.message, /Do not retry in a loop: batch the work into fewer, set-based queries/);
    return true;
  });
  assert.equal(connects(), 3, 'the refused call never connected');
  const last = audit.at(-1);
  assert.equal(last.tool, 'query');
  assert.equal(last.source, 'script');
  assert.equal(last.profile, 'shop');
  assert.match(last.error, /Query budget exhausted/);
});

test('slots free up as the one-minute window slides', async () => {
  const { db, connects, advance } = fakeDb({ maxQueriesPerMinute: 2 });
  await query(db); // t = 0
  advance(20000);
  await query(db); // t = 20 s
  advance(39999);
  await assert.rejects(query(db), /next slot frees up in 1 s/); // t = 59.999 s
  advance(1);
  await query(db); // t = 60 s: the call at t = 0 left the window
  await assert.rejects(query(db), /next slot frees up in 20 s/);
  advance(20000);
  await query(db);
  assert.equal(connects(), 4);
});

test('a refused call does not use up a slot', async () => {
  const { db, advance } = fakeDb({ maxQueriesPerMinute: 1 });
  await query(db);
  for (let i = 0; i < 5; i++) {
    advance(1000);
    await assert.rejects(query(db), QueryBudgetError);
  }
  advance(55000);
  await query(db);
});

test('the per-profile limit wins over the global one, and profiles have separate budgets', async () => {
  const { db, connects } = fakeDb({ maxQueriesPerMinute: 100, maxQueriesByProfile: new Map([['shop', 1]]) });
  assert.equal(db.maxQueriesPerMinute('shop'), 1);
  assert.equal(db.maxQueriesPerMinute('crm'), 100);
  await query(db);
  await assert.rejects(query(db), /limit 1 per minute/);
  await query(db, 'crm');
  await query(db, 'crm');
  assert.equal(connects(), 3);
});

test('without budget settings the default is 60 per minute', async () => {
  const { db } = fakeDb();
  assert.equal(db.maxQueriesPerMinute('shop'), 60);
  for (let i = 0; i < 60; i++) await query(db);
  await assert.rejects(query(db), /60 database operations in the last minute, limit 60/);
});

test('one audited operation with several statements and connections counts once', async () => {
  const { db, connects } = fakeDb({ maxQueriesPerMinute: 2 });
  await db.audited('batch', { profile: 'shop' }, async () => {
    await db.withReadOnly('shop', async client => { await client.query('select 1'); await client.query('select 2'); });
    await db.withReadOnly('shop', async client => client.query('select 3'));
  });
  await query(db);
  await assert.rejects(query(db), QueryBudgetError);
  assert.equal(connects(), 3);
});

test('concurrent operations are charged separately', async () => {
  const { db, connects } = fakeDb({ maxQueriesPerMinute: 2 });
  const results = await Promise.allSettled([query(db), query(db), query(db)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'fulfilled', 'rejected']);
  assert.ok(results.find(r => r.status === 'rejected').reason instanceof QueryBudgetError);
  assert.equal(connects(), 2);
});

test('an unknown profile is refused without using a slot', async () => {
  const { db } = fakeDb({ maxQueriesPerMinute: 1 });
  await assert.rejects(query(db, 'nope'), /Unknown profile/);
  await query(db);
});

// Configuration.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-budget-'));
let n = 0;
function profilesFile(content) {
  const file = path.join(dir, `profiles-${n++}.json`);
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}
const baseEnv = { AUSPEX_HOME: dir, AUSPEX_PROFILES_FILE: path.join(dir, 'none.json') };

test('config: default 60, global env, file field and per-profile env override', () => {
  assert.equal(loadConfig(baseEnv).maxQueriesPerMinute, 60);
  const file = profilesFile({
    shop: { url: 'postgresql://Auspex@10.0.0.5/shopdb', maxQueriesPerMinute: 30 },
    crm: { url: 'postgresql://Auspex@10.0.0.6/crm', maxQueriesPerMinute: 20 },
    hr: { url: 'postgresql://Auspex@10.0.0.7/hr' },
  });
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_MAX_QUERIES_PER_MINUTE: '120', AUSPEX_MAX_QUERIES_PER_MINUTE_CRM: '5' });
  assert.equal(config.maxQueriesPerMinute, 120);
  assert.equal(config.maxQueriesByProfile.get('shop'), 30);
  assert.equal(config.maxQueriesByProfile.get('crm'), 5, 'env overrides the file');
  assert.equal(config.maxQueriesByProfile.has('hr'), false);
  const db = new ReadOnlyDatabase(config, { audit: () => {} });
  assert.deepEqual(['shop', 'crm', 'hr'].map(p => db.maxQueriesPerMinute(p)), [30, 5, 120]);
});

test('config: env profiles get the per-profile env override too', () => {
  const config = loadConfig({ ...baseEnv, AUSPEX_DB_SHOP: 'postgresql://Auspex@10.0.0.5/shopdb', AUSPEX_MAX_QUERIES_PER_MINUTE_SHOP: '7' });
  assert.equal(config.maxQueriesByProfile.get('shop'), 7);
});

test('config: bad budget values are refused', () => {
  for (const value of ['0', '10001', 'abc', '-5']) {
    assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_MAX_QUERIES_PER_MINUTE: value }), /AUSPEX_MAX_QUERIES_PER_MINUTE must be an integer between 1 and 10000/, value);
    assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_DB_SHOP: 'postgresql://Auspex@h/db', AUSPEX_MAX_QUERIES_PER_MINUTE_SHOP: value }),
      /AUSPEX_MAX_QUERIES_PER_MINUTE_SHOP must be an integer between 1 and 10000/, value);
  }
  for (const value of [0, 10001, 1.5, '30', null]) {
    const file = profilesFile({ shop: { url: 'postgresql://Auspex@h/db', maxQueriesPerMinute: value } });
    assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file }), /"maxQueriesPerMinute" must be an integer between 1 and 10000/, String(value));
  }
});
