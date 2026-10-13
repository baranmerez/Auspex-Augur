import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyDatabase } from '../src/db.js';
import { evaluateRoleCheck, RoleCheckError } from '../src/roleCheck.js';

const cleanRole = { rolname: 'Auspex', rolsuper: false, rolbypassrls: false, rolreplication: false, rolcreaterole: false, rolcreatedb: false, default_read_only: 'on' };
const codes = list => list.map(f => f.code);

test('a role with only SELECT is ok', () => {
  const r = evaluateRoleCheck({ role: cleanRole, database: { can_create: false } });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.warnings, []);
});

test('superuser, bypassrls, replication, createrole, risky memberships and writable tables block', () => {
  const r = evaluateRoleCheck({
    role: { ...cleanRole, rolsuper: true, rolbypassrls: true, rolreplication: true, rolcreaterole: true },
    memberships: ['pg_write_all_data', 'pg_execute_server_program'],
    writable: [{ schema: 'sales', name: 'orders', total: '12' }, { schema: 'sales', name: 'lines', total: '12' }],
  });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(codes(r.blocking), ['superuser', 'bypassrls', 'replication', 'createrole', 'membership', 'membership', 'writable_tables']);
  assert.match(r.blocking.at(-1).text, /12 table\(s\), e\.g\. sales\.orders, sales\.lines/);
});

test('schema CREATE (e.g. granted to PUBLIC), database CREATE, CREATEDB and default read-only off only warn', () => {
  const r = evaluateRoleCheck({
    role: { ...cleanRole, rolcreatedb: true, default_read_only: 'off' },
    createSchemas: ['app', 'lib'],
    database: { can_create: true },
  });
  assert.equal(r.status, 'warning');
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(codes(r.warnings), ['createdb', 'default_read_only_off', 'create_on_schema', 'create_on_database']);
  assert.match(r.warnings[2].text, /app, lib/);
});

test('a role that cannot be found fails closed', () => {
  assert.equal(evaluateRoleCheck({ role: undefined }).status, 'blocked');
});

// Fake client answering the role-check queries from `facts`.
function fakeDb(facts) {
  const sent = [];
  let connects = 0;
  const client = {
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      sent.push(text);
      if (text.includes('from pg_roles where rolname = current_user')) return { rows: [facts.role] };
      if (text.includes("pg_has_role(current_user, r.oid, 'MEMBER')")) return { rows: facts.memberships.map(rolname => ({ rolname })) };
      if (text.includes('has_any_column_privilege')) return { rows: facts.writable };
      if (text.includes("has_schema_privilege(oid, 'CREATE')")) return { rows: facts.createSchemas.map(nspname => ({ nspname })) };
      if (text.includes("has_database_privilege(current_database(), 'CREATE')")) return { rows: [{ can_create: facts.canCreate }] };
      if (text === 'USER QUERY') return { rows: [['ran']] };
      return { rows: [] };
    },
    release() {},
  };
  const audit = [];
  const db = new ReadOnlyDatabase({ profiles: new Map([['shop', 'postgresql://u@127.0.0.1:1/a']]), statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000 },
    { audit: e => audit.push(e), source: 'mcp' });
  db.pool = () => ({ connect: async () => { connects++; return client; } });
  return { db, sent, audit, connects: () => connects };
}
const clean = () => ({ role: cleanRole, memberships: [], writable: [], createSchemas: ['app'], canCreate: false });
const roleQueries = sent => sent.filter(s => s.includes('from pg_roles where rolname = current_user')).length;

test('the check runs once per profile, warnings do not block, and the result is audited', async () => {
  const { db, sent, audit } = fakeDb(clean());
  const run = () => db.withReadOnly('shop', client => client.query('USER QUERY'));
  assert.deepEqual((await run()).rows, [['ran']]);
  await run();
  assert.equal(roleQueries(sent), 1, 'checked on first use only');
  assert.equal(db.roleCheck('shop').status, 'warning');
  const entry = audit.find(e => e.tool === 'role_check');
  assert.deepEqual({ profile: entry.profile, roleStatus: entry.roleStatus, warnings: entry.warnings, source: entry.source },
    { profile: 'shop', roleStatus: 'warning', warnings: ['create_on_schema'], source: 'mcp' });
});

test('a role that can write blocks every call; later calls fail without connecting', async () => {
  const facts = { ...clean(), writable: [{ schema: 'sales', name: 'orders', total: '1' }] };
  const { db, sent, audit, connects } = fakeDb(facts);
  await assert.rejects(db.withReadOnly('shop', client => client.query('USER QUERY')), err => err instanceof RoleCheckError && /not read-only.*sales\.orders/.test(err.message));
  assert.ok(!sent.includes('USER QUERY'), 'the user query never ran');
  assert.ok(sent.includes('ROLLBACK'), 'the transaction was rolled back');
  assert.equal(connects(), 1);
  await assert.rejects(db.query('shop', 'select 1'), RoleCheckError);
  assert.equal(connects(), 1, 'no new connection for a known blocked profile');
  assert.deepEqual(audit.find(e => e.tool === 'role_check').blocking, ['writable_tables']);

  // After the grant is fixed, check_profile runs the check again.
  facts.writable = [];
  const again = await db.checkProfile('shop');
  assert.equal(again.status, 'warning');
  assert.deepEqual((await db.withReadOnly('shop', client => client.query('USER QUERY'))).rows, [['ran']]);
});

test('check_profile reports a blocked role instead of throwing', async () => {
  const { db } = fakeDb({ ...clean(), role: { ...cleanRole, rolsuper: true } });
  const r = await db.checkProfile('shop');
  assert.equal(r.profile, 'shop');
  assert.equal(r.status, 'blocked');
  assert.deepEqual(codes(r.blocking), ['superuser']);
});
