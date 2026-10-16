import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyDatabase } from '../src/db.js';
import { classifyError, errorCodes } from '../src/errors.js';
import { LockBusyError } from '../src/fileLock.js';
import { RoleCheckError } from '../src/roleCheck.js';
import { assertReadOnlyQuery } from '../src/sqlGuard.js';
import { LibraryError } from '../src/reports/library.js';
import { MemoryError } from '../src/memory/store.js';

// Fake database: every statement after the transaction setup fails with
// failWith (when given); the role check has already passed.
function fakeDb({ failWith, budget = 60, connectError } = {}) {
  const audit = [];
  const client = {
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      if (failWith && !/^(BEGIN|SET LOCAL|ROLLBACK)/.test(text)) throw failWith;
      return { rows: [], fields: [] };
    },
    release() {},
  };
  const config = {
    profiles: new Map([['example', 'postgresql://u@127.0.0.1:1/a']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 60000, maxRows: 10, maxCellChars: 100, maxQueriesPerMinute: budget,
  };
  const db = new ReadOnlyDatabase(config, { audit: e => audit.push(e), source: 'mcp', now: () => 1_000_000 });
  db.pool = () => ({ connect: async () => { if (connectError) throw connectError; return client; } });
  db.roleChecks.set('example', { status: 'ok', blocking: [], warnings: [] });
  return { db, audit };
}

const pgError = (code, message) => Object.assign(new Error(message), { code, severity: 'ERROR' });
const classified = async promise => {
  try {
    await promise;
  } catch (err) {
    return classifyError(err);
  }
  assert.fail('expected a rejection');
};
const allowedKeys = new Set(['code', 'retryable', 'retryAfterSeconds', 'budgetScope', 'sqlState']);

test('query budget refusal: code, retryable and retry-after, labeled per process', async () => {
  const { db } = fakeDb({ budget: 1 });
  await db.query('example', 'select 1');
  const e = await classified(db.query('example', 'select 1'));
  assert.equal(e.code, 'QUERY_BUDGET_EXCEEDED');
  assert.equal(e.retryable, true);
  assert.ok(Number.isInteger(e.retryAfterSeconds) && e.retryAfterSeconds >= 1 && e.retryAfterSeconds <= 60);
  assert.equal(e.budgetScope, 'process');
});

test('each failure kind has its own code without parsing the message', async () => {
  assert.deepEqual(classifyError(new LockBusyError('x.lock')), { code: 'LOCK_BUSY', retryable: true });
  assert.deepEqual(classifyError(new RoleCheckError('example', { blocking: [{ text: 'superuser' }] })), { code: 'ROLE_REJECTED', retryable: false });
  assert.throws(() => assertReadOnlyQuery('delete from t'), err => classifyError(err).code === 'SQL_REJECTED');
  assert.deepEqual(classifyError(Object.assign(new Error('no space'), { code: 'ENOSPC' })), { code: 'DISK_ERROR', retryable: false });
  assert.equal(classifyError(Object.assign(new Error('exists'), { code: 'EEXIST' })).code, 'DISK_ERROR');
  assert.equal(classifyError(new LibraryError('bad name')).code, 'INVALID_INPUT');
  assert.equal(classifyError(new LibraryError('gone', 'NOT_FOUND')).code, 'NOT_FOUND');
  assert.equal(classifyError(new MemoryError('Note #1 not found.', 'NOT_FOUND')).code, 'NOT_FOUND');
  assert.deepEqual(classifyError(new Error('anything else')), { code: 'INTERNAL', retryable: false });
  for (const err of [new LockBusyError('x'), new Error('y'), pgError('57014', 'z')]) assert.ok(errorCodes.includes(classifyError(err).code));
});

test('PostgreSQL errors map by SQLSTATE: timeout, lock timeout, read-only, connection', async () => {
  const timeout = await classified(fakeDb({ failWith: pgError('57014', 'canceling statement due to statement timeout') }).db.query('example', 'select 1'));
  assert.deepEqual(timeout, { code: 'TIMEOUT', retryable: false, sqlState: '57014' });
  assert.deepEqual(classifyError(pgError('55P03', 'lock')), { code: 'TIMEOUT', retryable: true, sqlState: '55P03' });
  assert.equal(classifyError(pgError('25006', 'read only')).code, 'SQL_REJECTED');
  assert.equal(classifyError(pgError('42501', 'denied')).code, 'PERMISSION_DENIED');
  assert.deepEqual(classifyError(pgError('42P01', 'missing')), { code: 'DATABASE_ERROR', retryable: false, sqlState: '42P01' });
  // A plain error whose code only looks like a SQLSTATE is not a PostgreSQL error.
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'ABCDE' })).code, 'INTERNAL');
});

test('connection failures: authentication is not retryable, an unreachable server is', async () => {
  const auth = await classified(fakeDb({ connectError: pgError('28P01', 'password authentication failed for user "u"') }).db.query('example', 'select 1'));
  assert.deepEqual(auth, { code: 'CONNECTION_FAILED', retryable: false, sqlState: '28P01' });
  const refused = await classified(fakeDb({ connectError: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }).db.query('example', 'select 1'));
  assert.deepEqual(refused, { code: 'CONNECTION_FAILED', retryable: true });
});

test('a connection that drops mid-query is CONNECTION_FAILED and retryable, disk errors stay DISK_ERROR', async () => {
  // The messages node-postgres raises (without a code) when the socket drops.
  for (const message of ['Connection terminated unexpectedly', 'Connection terminated',
    'Client has encountered a connection error and is not queryable']) {
    const e = await classified(fakeDb({ failWith: new Error(message) }).db.query('example', 'select 1'));
    assert.deepEqual(e, { code: 'CONNECTION_FAILED', retryable: true }, message);
  }
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']) {
    const e = await classified(fakeDb({ failWith: Object.assign(new Error(`read ${code}`), { code }) }).db.query('example', 'select 1'));
    assert.deepEqual(e, { code: 'CONNECTION_FAILED', retryable: true }, code);
  }
  // Code wins over message; only the exact pg messages match.
  for (const code of ['EEXIST', 'ENOSPC']) {
    assert.deepEqual(classifyError(Object.assign(new Error('Connection terminated unexpectedly'), { code })), { code: 'DISK_ERROR', retryable: false }, code);
  }
  assert.equal(classifyError(pgError('57P01', 'Connection terminated unexpectedly')).code, 'CONNECTION_FAILED');
  assert.equal(classifyError(new Error('Connection terminated unexpectedly while saving')).code, 'INTERNAL');
  assert.equal(classifyError(new Error('Client was closed and is not queryable')).code, 'INTERNAL');
});

test('invalid parameters and profiles are INVALID_INPUT / PROFILE_INVALID', async () => {
  const { db } = fakeDb();
  assert.equal((await classified(db.query('example', 'select 1', [], 1, 0.1))).code, 'INVALID_INPUT');
  assert.equal((await classified(db.query('example', 'select 1', [], 1, 999))).code, 'INVALID_INPUT');
  assert.equal((await classified(db.query('nope', 'select 1'))).code, 'PROFILE_INVALID');
  assert.equal((await classified(db.query('', 'select 1'))).code, 'PROFILE_INVALID');
  assert.equal((await classified(db.query('example', 'update t set a = 1'))).code, 'SQL_REJECTED');
});

test('the correlation ID of a call is on every audit entry it writes; errors carry their code', async () => {
  const { db, audit } = fakeDb({ failWith: pgError('57014', 'timeout') });
  await assert.rejects(db.withCorrelation('cid-1', () => db.query('example', 'select 1')));
  await db.withCorrelation('cid-2', () => db.audited('outer', {}, () => db.audited('inner', {}, async () => ({ rowCount: 0 }))));
  assert.deepEqual(audit.map(e => [e.tool, e.correlationId, e.errorCode ?? null, e.sqlState ?? null]),
    [['query', 'cid-1', 'TIMEOUT', '57014'], ['inner', 'cid-2', null, null], ['outer', 'cid-2', null, null]]);

  // The first-use role check is part of the call: same ID. Here the fake
  // catalog has no role, so the check blocks the profile.
  const fresh = fakeDb();
  fresh.db.roleChecks.clear();
  const e = await classified(fresh.db.withCorrelation('cid-3', () => fresh.db.query('example', 'select 1')));
  assert.equal(e.code, 'ROLE_REJECTED');
  assert.deepEqual(fresh.audit.map(x => [x.tool, x.correlationId, x.errorCode ?? null]),
    [['role_check', 'cid-3', null], ['query', 'cid-3', 'ROLE_REJECTED']]);
  // Outside a tool call (scripts) there is no correlation ID field at all.
  await db.audited('script_op', {}, async () => ({}));
  assert.ok(!('correlationId' in audit.at(-1)));
});

test('the envelope holds no message text, SQL, parameters or connection details', async () => {
  const marker = 'SECRET-MARKER-4242';
  const { db } = fakeDb({ failWith: pgError('22P02', `invalid input syntax for type integer: "${marker}"`) });
  const e = await classified(db.query('example', `select '${marker}'::int`, [marker]));
  assert.ok(Object.keys(e).every(k => allowedKeys.has(k)), JSON.stringify(e));
  assert.ok(!JSON.stringify(e).includes(marker));
  const conn = await classified(fakeDb({ connectError: Object.assign(new Error(`connect to postgresql://u@db.internal:5432/${marker}`), { code: 'ENOTFOUND' }) }).db.query('example', 'select 1'));
  assert.ok(!JSON.stringify(conn).includes(marker) && !JSON.stringify(conn).includes('db.internal'));
});
