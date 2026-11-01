import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyDatabase, CancelledError } from '../src/db.js';
import { ReportService } from '../src/reports/service.js';
import { classifyError } from '../src/errors.js';

// #144: the MCP request's AbortSignal reaches running work. A fake pg client
// records statements; a FETCH can be held until the test cancels it. The
// real CancelRequest is replaced by a stub that fails the pending statement
// with 57014, as PostgreSQL does (tests/integration.local.mjs runs it for real).
function fakeDb({ holdFetch = false, ignoreCancel = false, connectDelay = null } = {}) {
  const audit = [];
  let failPending = null;
  const client = {
    statements: [],
    released: [],
    dropped: false,
    processID: 4242,
    secretKey: 7,
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      client.statements.push(text);
      if (client.dropped) throw new Error('Client has encountered a connection error and is not queryable');
      if (text.startsWith('FETCH') && holdFetch) {
        await new Promise((_, reject) => { failPending = reject; });
      }
      if (text.startsWith('FETCH')) return { rows: [[1]], fields: [{ name: 'n', dataTypeID: 23 }] };
      return { rows: [] };
    },
    on() {},
    off() {},
    connection: { stream: { destroy() { client.dropped = true; failPending?.(new Error('Connection terminated')); } } },
    release(broken) { client.released.push(broken); },
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['local', 'postgresql://u@127.0.0.1:1/a']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500, exportMaxRows: 100000,
    exportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-cancel-export-')),
  }, { audit: e => audit.push(e), source: 'mcp' });
  db.pool = () => ({ connect: () => (connectDelay ? connectDelay.then(() => client) : Promise.resolve(client)) });
  db.roleChecks.set('local', { status: 'ok', blocking: [], warnings: [] });
  db.cancelGraceMs = 50;
  const cancels = [];
  db.sendCancel = (c, name) => {
    cancels.push({ processID: c.processID, name });
    if (!ignoreCancel) setImmediate(() => failPending?.(Object.assign(new Error('canceling statement due to user request'), { code: '57014', severity: 'ERROR' })));
  };
  return { db, client, audit, cancels };
}

// Runs fn as one MCP tool call with this signal.
const asCall = (db, signal, fn) => db.withCorrelation('c-1', fn, signal);

test('CANCELLED is a stable, non-retryable error code', () => {
  assert.deepEqual(classifyError(new CancelledError()), { code: 'CANCELLED', retryable: false });
});

test('a call cancelled before connecting never connects and costs no query budget', async () => {
  const { db, client, audit } = fakeDb();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(asCall(db, controller.signal, () => db.query('local', 'select 1')), { errorCode: 'CANCELLED' });
  assert.deepEqual(client.statements, []);
  assert.equal(db.budgetUse.get('local'), undefined);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].tool, 'query');
  assert.equal(audit[0].errorCode, 'CANCELLED');
  assert.equal(audit[0].correlationId, 'c-1');
});

test('a call cancelled while waiting for a connection stops at once; the late connection is closed unused', async () => {
  let arrive;
  const { db, client } = fakeDb({ connectDelay: new Promise(r => { arrive = r; }) });
  const controller = new AbortController();
  const running = asCall(db, controller.signal, () => db.query('local', 'select 1'));
  setImmediate(() => controller.abort());
  await assert.rejects(running, { errorCode: 'CANCELLED' });
  arrive();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(client.statements, []);
  assert.deepEqual(client.released, [true]);
});

test('cancelling a pending query sends one CancelRequest for its own backend and drops the connection', async () => {
  const { db, client, audit, cancels } = fakeDb({ holdFetch: true });
  const controller = new AbortController();
  const running = asCall(db, controller.signal, () => db.query('local', 'select 1'));
  await new Promise(r => setTimeout(r, 10));
  assert.ok(client.statements.some(s => s.startsWith('FETCH')), 'the FETCH is pending');
  controller.abort();
  await assert.rejects(running, { errorCode: 'CANCELLED' });
  assert.deepEqual(cancels, [{ processID: 4242, name: 'local' }]);
  assert.equal(client.statements.at(-1), 'ROLLBACK');
  assert.deepEqual(client.released, [true], 'a cancelled connection never goes back to the pool');
  assert.equal(audit.at(-1).errorCode, 'CANCELLED');
  assert.equal(audit.at(-1).tool, 'query');
});

test('the next call after a cancellation works normally and keeps its client query method', async () => {
  const { db, client } = fakeDb({ holdFetch: true });
  const controller = new AbortController();
  const running = asCall(db, controller.signal, () => db.query('local', 'select 1'));
  await new Promise(r => setTimeout(r, 10));
  controller.abort();
  await assert.rejects(running, { errorCode: 'CANCELLED' });
  assert.equal(Object.hasOwn(client, 'query'), true, 'the own query method of the double is restored');
  const fresh = fakeDb();
  const r = await asCall(fresh.db, new AbortController().signal, () => fresh.db.query('local', 'select 1'));
  assert.deepEqual(r.rows, [[1]]);
  assert.deepEqual(fresh.client.released, [false]);
});

test('a server that ignores the CancelRequest gets its connection dropped after the grace', async () => {
  const { db, client } = fakeDb({ holdFetch: true, ignoreCancel: true });
  const controller = new AbortController();
  const running = asCall(db, controller.signal, () => db.query('local', 'select 1'));
  await new Promise(r => setTimeout(r, 10));
  const started = Date.now();
  controller.abort();
  await assert.rejects(running, { errorCode: 'CANCELLED' });
  assert.ok(Date.now() - started < 1000, 'bounded by cancelGraceMs');
  assert.equal(client.dropped, true);
  assert.deepEqual(client.released, [true]);
});

test('no statement starts after the cancellation in a multi-statement call', async () => {
  const { db, client } = fakeDb();
  const controller = new AbortController();
  await assert.rejects(asCall(db, controller.signal, () => db.withReadOnly('local', async c => {
    await c.query('select 1');
    controller.abort();
    await c.query('select 2');
  })), { errorCode: 'CANCELLED' });
  assert.ok(client.statements.includes('select 1'));
  assert.ok(!client.statements.includes('select 2'));
  assert.equal(client.statements.at(-1), 'ROLLBACK');
});

test('a call without a signal (scheduler, scripts) is unaffected', async () => {
  const { db, client } = fakeDb();
  const r = await db.query('local', 'select 1');
  assert.deepEqual(r.rows, [[1]]);
  assert.equal(client.query.name, 'query');
});

test('a cancelled export removes its partial file and is audited as cancelled', async () => {
  const { db, client, audit } = fakeDb({ holdFetch: true });
  const controller = new AbortController();
  const running = asCall(db, controller.signal, () => db.exportCsv('local', 'select 1', [], 'cancelled', ','));
  await new Promise(r => setTimeout(r, 10));
  controller.abort();
  await assert.rejects(running, { errorCode: 'CANCELLED' });
  assert.deepEqual(fs.readdirSync(db.config.exportDir), [], 'no file is kept');
  assert.deepEqual(client.released, [true]);
  assert.equal(audit.at(-1).tool, 'export_csv');
  assert.equal(audit.at(-1).errorCode, 'CANCELLED');
});

test('an export cancelled while waiting for a slow disk stops at once and removes the file', async () => {
  const { db } = fakeDb();
  const { Writable } = await import('node:stream');
  const controller = new AbortController();
  // A stream that never drains: the export waits on the disk, not on the database.
  db.openExportStream = target => {
    const out = new Writable({ highWaterMark: 1, write() {} });
    fs.writeFileSync(target, '');
    setImmediate(() => out.emit('open'));
    return out;
  };
  const running = asCall(db, controller.signal, () => db.exportCsv('local', 'select 1', [], 'slow', ','));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, { errorCode: 'CANCELLED' });
  assert.deepEqual(fs.readdirSync(db.config.exportDir), []);
});

// run_report: cancellation between phases.
function reportSetup(onRun) {
  const fake = {
    resolveProfile: name => String(name).toLowerCase(),
    signal: null,
    cancelled() { return fake.signal?.aborted === true; },
    throwIfCancelled() { if (fake.cancelled()) throw new CancelledError(); },
    async runReport(profile) {
      onRun?.();
      return { profile, serverVersion: '16.0', plan: [{ Plan: { 'Node Type': 'Result', 'Total Cost': 0.01, 'Plan Rows': 1 } }], explainMs: 1, previewMs: 1,
        columns: [{ name: 'amount', type: 'integer' }], rows: [[1]], rowCount: 1, truncated: false, previewExecuted: true };
    },
  };
  const svc = new ReportService(fake, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-cancel-report-')));
  return { svc, fake };
}
const ref = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'order-total' };

test('run_report cancelled during the database phase saves no run and no HTML', async () => {
  const controller = new AbortController();
  const { svc, fake } = reportSetup(() => controller.abort());
  fake.signal = controller.signal;
  svc.save({ ...ref, sql: 'SELECT 1 AS amount' });
  const html = svc.library.paths('draft', svc.ref(ref)).html;
  const before = fs.readFileSync(html, 'utf8');
  await assert.rejects(svc.run(ref), { errorCode: 'CANCELLED' });
  assert.deepEqual(svc.library.readMeta('draft', svc.ref(ref)).runs, [], 'no run was recorded');
  assert.equal(fs.readFileSync(html, 'utf8'), before, 'the HTML was not regenerated');
});

test('run_report not cancelled saves its run as before', async () => {
  const { svc, fake } = reportSetup();
  fake.signal = new AbortController().signal;
  svc.save({ ...ref, sql: 'SELECT 1 AS amount' });
  const r = await svc.run(ref);
  assert.equal(r.stage, 'draft');
  assert.equal(fs.existsSync(r.htmlFile), true);
});
