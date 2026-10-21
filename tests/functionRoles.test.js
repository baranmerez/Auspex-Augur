import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyDatabase } from '../src/db.js';
import { describeFunctions, listFunctions, functionTriggerFromRow } from '../src/catalog.js';
import { SchemaMemory } from '../src/memory/store.js';

// tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate, 64 instead of.
const trig = (tableName, trigger, tgtype, schema = 'example') => ({ schema, tableName, trigger, tgtype });

test('trigger rows decode timing, events and level from tgtype; table is a proper key', () => {
  assert.deepEqual(functionTriggerFromRow(trig('orders', 'orders_check', 1 | 2 | 4 | 16)), {
    table: 'example.orders', schema: 'example', tableName: 'orders', trigger: 'orders_check', timing: 'before', events: ['insert', 'update'], level: 'row',
  });
  const instead = functionTriggerFromRow(trig('v_order_list', 'v_order_list_insert', 64 | 1 | 4));
  assert.deepEqual([instead.timing, instead.events, instead.level], ['instead', ['insert'], 'row']);
  const statement = functionTriggerFromRow(trig('order_events', 'order_events_purge', 8 | 32));
  assert.deepEqual([statement.timing, statement.events, statement.level], ['after', ['delete', 'truncate'], 'statement']);
  assert.equal(functionTriggerFromRow(trig('orders.history', 'h', 2, 'example')).table, 'example."orders.history"', 'a dot in a name is quoted like tableKey');
  assert.deepEqual(functionTriggerFromRow({ table: 'example.orders', trigger: 'old_shape' }), { table: 'example.orders', trigger: 'old_shape' });
});

function fakeDb(rows) {
  const sent = [];
  const client = {
    async query(q, values) {
      const text = typeof q === 'string' ? q : q.text;
      sent.push({ text, params: values });
      return { rows };
    },
    release() {},
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['example', 'postgresql://u@127.0.0.1:1/a']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500,
  }, { audit: () => {} });
  db.pool = () => ({ connect: async () => client });
  db.roleChecks.set('example', { status: 'ok', blocking: [], warnings: [] });
  return { db, sent };
}

const triggerRow = { schema: 'example', name: 'orders_audit', arguments: '', returns: 'trigger', kind: 'function', language: 'plpgsql', volatility: 'volatile',
  returns_trigger: true, used_by_triggers: [trig('orders', 'orders_audit', 1 | 16), trig('customers', 'customers_audit', 4)] };

test('list_functions and describe_functions return returnsTrigger and decoded usedByTriggers in their one statement', async () => {
  const list = fakeDb([triggerRow]);
  const r = await listFunctions(list.db, 'example', { schema: 'example' });
  assert.equal(r.statements, 1);
  const [f] = r.functions;
  assert.equal(f.returnsTrigger, true);
  assert.deepEqual(f.usedByTriggers.map(t => `${t.table}:${t.timing}:${t.events.join('+')}:${t.level}`), ['example.orders:after:update:row', 'example.customers:after:insert:statement']);
  const listSql = list.sent.find(s => s.text.includes('limit $3')).text;
  assert.match(listSql, /p\.prorettype = 'trigger'::regtype as returns_trigger/);
  assert.match(listSql, /not t\.tgisinternal/);

  const describe = fakeDb([{ ord: 1, ...triggerRow, definition: 'CREATE FUNCTION example.orders_audit() ...', definition_length: '40' }]);
  const d = await describeFunctions(describe.db, 'example', { functions: ['example.orders_audit'] });
  assert.equal(d.statements, 1);
  assert.equal(d.functions[0].returnsTrigger, true);
  assert.equal(d.functions[0].usedByTriggers[0].timing, 'after');
  assert.match(describe.sent.find(s => s.text.includes('pg_get_functiondef')).text, /'tgtype', t\.tgtype::int/);
});

const decoded = (tableName, trigger, tgtype) => functionTriggerFromRow(trig(tableName, trigger, tgtype));
const listed = (name, extra = {}) => ({ schema: 'example', name, arguments: '', returns: 'trigger', kind: 'function', language: 'plpgsql', volatility: 'volatile', returnsTrigger: true, usedByTriggers: [], ...extra });

test('a re-list refreshes the trigger facts of listed-only overloads and never touches described ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-fn-roles-'));
  const mem = new SchemaMemory(dir);
  const definition = 'CREATE FUNCTION example.orders_check()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN RETURN NEW; END $function$';
  mem.recordFunctions('exampledb', [{ ...listed('orders_check'), definition, usedByTriggers: [decoded('orders', 'orders_check', 1 | 2 | 4)] }]);
  mem.recordListedFunctions('exampledb', [listed('orders_audit')]);
  const second = mem.recordListedFunctions('exampledb', [
    listed('orders_audit', { usedByTriggers: [decoded('orders', 'orders_audit', 1 | 16)] }),
    listed('orders_check', { usedByTriggers: [] }),
  ]);
  assert.deepEqual(second, { functionsAdded: 0, overloadsAdded: 0, overloadsRefreshed: 1 });
  const audit = mem.readFunction('exampledb', 'example', 'orders_audit').overloads[0];
  assert.deepEqual([audit.listedOnly, audit.definition, audit.usedByTriggers.map(t => t.trigger)], [true, null, ['orders_audit']]);
  const check = mem.readFunction('exampledb', 'example', 'orders_check').overloads[0];
  assert.equal(check.definition, definition, 'the described overload keeps its definition');
  assert.deepEqual(check.usedByTriggers.map(t => t.trigger), ['orders_check'], 'and its trigger facts');
  assert.deepEqual(mem.recordListedFunctions('exampledb', [listed('orders_audit', { usedByTriggers: [decoded('orders', 'orders_audit', 1 | 16)] })]),
    { functionsAdded: 0, overloadsAdded: 0 }, 'unchanged facts are not rewritten');
});

test('graph functions: role from catalog facts, timings and trigger tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-fn-roles-'));
  const mem = new SchemaMemory(dir);
  mem.recordListedFunctions('exampledb', [
    listed('orders_audit', { usedByTriggers: [decoded('orders', 'orders_audit', 1 | 16), decoded('customers', 'customers_audit', 1 | 2 | 4), decoded('orders', 'orders_audit_stmt', 32)] }),
    listed('v_order_list_insert', { usedByTriggers: [decoded('v_order_list', 'v_order_list_insert', 64 | 1 | 4)] }),
    listed('close_day', { kind: 'procedure', returns: null, returnsTrigger: false }),
    listed('order_sum', { kind: 'aggregate', returns: 'numeric', returnsTrigger: false }),
    listed('order_rank', { kind: 'window', returns: 'bigint', returnsTrigger: false }),
    listed('order_total', { returns: 'numeric', returnsTrigger: false }),
  ]);
  const fns = new Map(JSON.parse(fs.readFileSync(path.join(dir, 'exampledb', 'graph.json'), 'utf8')).functions.map(f => [f.name, f]));
  const audit = fns.get('orders_audit');
  assert.deepEqual([audit.role, audit.timings, audit.triggerTables, audit.usedByTriggers], ['trigger', ['after', 'before'], ['example.customers', 'example.orders'], 3]);
  assert.deepEqual([fns.get('v_order_list_insert').role, fns.get('v_order_list_insert').timings], ['trigger', ['instead']]);
  assert.deepEqual(['close_day', 'order_sum', 'order_rank', 'order_total'].map(n => fns.get(n).role), ['procedure', 'aggregate', 'window', 'function']);
  assert.deepEqual([fns.get('order_total').timings, fns.get('order_total').triggerTables], [[], []]);
});

test('records from before trigger timing load fine: role from the return type, tables from the stored text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-fn-roles-'));
  const mem = new SchemaMemory(dir);
  const file = mem.functionPath('exampledb', 'example', 'orders_log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema: 'example', name: 'orders_log', firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z', describedAt: '2026-01-01T00:00:00.000Z',
    overloads: [{ arguments: '', returns: 'trigger', kind: 'function', language: 'plpgsql', volatility: 'volatile', usedByTriggers: [{ table: 'example.orders', trigger: 'orders_log' }], definition: null }],
    history: [],
  }));
  const [f] = mem.graph('exampledb').functions;
  assert.deepEqual([f.role, f.timings, f.triggerTables, f.usedByTriggers], ['trigger', [], ['example.orders'], 1]);
});
