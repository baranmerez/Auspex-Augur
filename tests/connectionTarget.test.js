import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { loadConfig, describeConnection } from '../src/config.js';
import { ReadOnlyDatabase, clearLibpqEnv, ignoredLibpqEnv } from '../src/db.js';

// The endpoint Auspex shows must be the one node-postgres connects to: a
// profile URL must name host, user and database, a missing port becomes an
// explicit 5432, and PG* variables in the environment never pick the target
// or add session settings. Nothing here connects to a database.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-target-'));
const baseEnv = { AUSPEX_HOME: dir, AUSPEX_PROFILES_FILE: path.join(dir, 'missing.json') };

// Runs fn with these variables set in process.env (where node-postgres reads
// them) and restores the previous values afterwards. An undefined value
// removes the variable for the duration of fn.
function withProcessEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const driverTarget = url => {
  const p = new pg.Client({ connectionString: url }).connectionParameters;
  return { host: p.host, port: String(p.port), database: p.database, user: p.user };
};

test('a profile URL without host, user or database is refused, from the file and from the environment', () => {
  for (const url of ['postgresql://localhost', 'postgresql://report_reader@db.example.test', 'postgresql://db.example.test/exampledb', 'postgresql:///exampledb']) {
    assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_DB_EXAMPLE: url }), /needs .*(host|user|database)/, url);
    const file = path.join(dir, `p-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({ example: { url } }));
    assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file }), /needs .*(host|user|database)/, url);
  }
});

test('a missing port becomes an explicit 5432, so PGPORT, PGUSER and PGDATABASE cannot change the target', () => {
  const file = path.join(dir, 'ports.json');
  fs.writeFileSync(file, JSON.stringify({ example: { url: 'postgresql://report_reader@db.example.test/exampledb?sslmode=require' } }));
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_DB_TEST: 'postgresql://report_reader@db.example.test/testdb' });
  assert.equal(config.profiles.get('example'), 'postgresql://report_reader@db.example.test:5432/exampledb?sslmode=require');
  assert.equal(config.profiles.get('test'), 'postgresql://report_reader@db.example.test:5432/testdb');
  withProcessEnv({ PGPORT: '6543', PGUSER: 'unintended_user', PGDATABASE: 'unintended_database', PGHOST: 'elsewhere.example.test' }, () => {
    for (const name of ['example', 'test']) {
      const url = config.profiles.get(name);
      const shown = describeConnection(url);
      assert.deepEqual(driverTarget(url), { host: shown.host, port: shown.port, database: shown.database, user: shown.user }, name);
    }
  });
});

test('a URL with its own port is kept exactly as written', () => {
  const url = 'postgresql://report_reader@db.example.test:6000/exampledb';
  assert.equal(loadConfig({ ...baseEnv, AUSPEX_DB_EXAMPLE: url }).profiles.get('example'), url);
});

test('PG* variables that would change the target or the session are removed; pgpass and TLS settings stay', () => {
  const env = Object.fromEntries(ignoredLibpqEnv.map(k => [k, 'x']));
  Object.assign(env, { PGPASSFILE: 'C:/example/pgpass.conf', PGSSLMODE: 'require', PATH: 'p' });
  assert.deepEqual(clearLibpqEnv(env).sort(), [...ignoredLibpqEnv].sort());
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'PGPASSFILE', 'PGSSLMODE']);
  assert.deepEqual(clearLibpqEnv(env), [], 'nothing left to remove');
});

test('creating a pool clears PGOPTIONS, PGREPLICATION and PGPASSWORD before node-postgres reads them', () => {
  const url = 'postgresql://report_reader@db.example.test:5432/exampledb';
  const db = new ReadOnlyDatabase({ profiles: new Map([['example', url]]) }, { audit: () => {} });
  const stderr = process.stderr.write;
  let warned = '';
  process.stderr.write = chunk => { warned += chunk; return true; };
  try {
    // Start without any ignored variable: CI runners may set PGUSER and others.
    const clean = Object.fromEntries(ignoredLibpqEnv.map(k => [k, undefined]));
    withProcessEnv({ ...clean, PGOPTIONS: '-c search_path=elsewhere', PGREPLICATION: 'database', PGPASSWORD: 'not-from-pgpass' }, () => {
      const pool = db.pool('example');
      const p = new pg.Client(pool.options).connectionParameters;
      assert.equal(p.options, undefined);
      assert.equal(p.replication, undefined);
      assert.equal(process.env.PGPASSWORD, undefined);
      pool.end();
    });
  } finally {
    process.stderr.write = stderr;
  }
  assert.match(warned, /ignores PGPASSWORD, PGOPTIONS, PGREPLICATION from the environment/);
  assert.doesNotMatch(warned, /not-from-pgpass|search_path/, 'values are never printed');
});

test('socket, IPv6 and encoded URLs keep their target when the port is added', () => {
  const cases = [
    'postgresql://report_reader@%2Fvar%2Frun%2Fpostgresql/exampledb',
    'postgresql://report_reader@[::1]/exampledb?sslmode=require',
    'postgresql://report%20reader@db.example.test/example%2Fdb',
  ];
  for (const raw of cases) {
    const url = loadConfig({ ...baseEnv, AUSPEX_DB_EXAMPLE: raw }).profiles.get('example');
    const before = driverTarget(raw.replace(/(@[^/]+)\//, '$1:5432/'));
    const after = driverTarget(url);
    assert.deepEqual(after, before, raw);
    const shown = describeConnection(url);
    assert.deepEqual(after, { host: shown.host, port: shown.port, database: shown.database, user: shown.user }, `shown = used for ${raw}`);
  }
});
