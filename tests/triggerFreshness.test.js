import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaMemory } from '../src/memory/store.js';

// Trigger summaries bound to their direct function's stored definition
// (#152), with synthetic records only.
let clock = 0;
const now = () => new Date(Date.UTC(2026, 2, 1) + (clock++) * 60000).toISOString();
const col = (column, attnum, type = 'integer') => ({ column, attnum, type, not_null: false, default: null, comment: null });
const memory = () => new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-trg-fresh-')), { now });

const trigger = (table, name, fn = 'example.orders_before_write', extra = {}) => ({
  name, timing: 'BEFORE', events: ['INSERT'], level: 'ROW', enabled: 'enabled', function: fn, whenCondition: null,
  definition: `CREATE TRIGGER ${name} BEFORE INSERT ON example.${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`, ...extra,
});
const describe = (profile, table, triggers) => ({
  profile, relation: `example.${table}`, schema: 'example', table, kind: 'table', oid: table.length, estimated_rows: 10, comment: null,
  columns: [col('order_id', 1), col('status_code', 2)], constraints: [], indexes: [], referencedBy: [], triggers,
});
const body = (name, check, schema = 'example') => `CREATE OR REPLACE FUNCTION ${schema}.${name}()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF ${check} THEN RAISE EXCEPTION 'bad'; END IF;\n  RETURN NEW;\nEND\n$function$\n`;
const fn = (name, check, extra = {}) => ({
  schema: 'example', name, arguments: '', returns: 'trigger', kind: 'function', language: 'plpgsql', volatility: 'volatile',
  securityDefiner: false, strict: false, parallel: 'unsafe', config: [], owner: 'report_reader', canExecute: true, comment: null,
  returnsTrigger: true, usedByTriggers: [], definition: body(extra.name ?? name, check, extra.schema), ...extra,
});
const summarize = (mem, table, names, profile = 'exampledb') => mem.scoreColumns(profile, { schema: 'example', table, triggers: names.map(name => ({ name, summary: `Checks ${name}.` })) });
const freshness = (mem, table, profile = 'exampledb') => mem.knowledge(profile, 'example', table).triggers
  .map(t => [t.name, t.summaryFreshness ?? null, t.summaryFreshnessReason ?? null, t.summaryStale ?? false]);
const graphTriggers = (mem, table, profile = 'exampledb') => JSON.parse(fs.readFileSync(path.join(mem.root, profile, 'graph.json'), 'utf8'))
  .nodes.find(n => n.id === `example.${table}`).triggers.map(t => [t.name, t.summaryFreshness ?? null, t.summaryFreshnessReason ?? null, t.summaryStale ?? false]);

test('a new summary records the function identity, fingerprint, capture time and completeness', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check')]));
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'NEW.status_code IS NULL')]);
  summarize(mem, 'orders', ['orders_check']);
  const ev = mem.readTable('exampledb', 'example', 'orders').triggerSummaries.orders_check.functionEvidence;
  const fnRec = mem.readFunction('exampledb', 'example', 'orders_before_write');
  assert.deepEqual(ev, {
    ref: 'example.orders_before_write', schema: 'example', name: 'orders_before_write', arguments: '',
    capturedAt: fnRec.describedAt, definitionHash: fnRec.overloads[0].definitionHash, definitionLength: fnRec.overloads[0].definitionLength, complete: true,
  });
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'fresh', null, false]]);
  const stored = fs.readFileSync(mem.tablePath('exampledb', 'example', 'orders'), 'utf8');
  assert.ok(!/RAISE EXCEPTION|RETURN NEW/.test(stored), 'no function source in the table record');
});

test('unchanged trigger DDL with a changed function body is stale; an unchanged refresh is not', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check')]));
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'NEW.status_code IS NULL')]);
  summarize(mem, 'orders', ['orders_check']);
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'NEW.status_code IS NULL')]);
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'fresh', null, false]], 'an unchanged refresh keeps it fresh');
  mem.recordFunctions('exampledb', [fn('orders_before_write', "NEW.status_code NOT IN ('new', 'done')")]);
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'stale', 'function-changed', true]]);
  assert.deepEqual(graphTriggers(mem, 'orders'), freshness(mem, 'orders'), 'graph.json shows the same freshness');
  const k = mem.knowledge('exampledb', 'example', 'orders');
  assert.equal(k.triggers[0].summary, 'Checks orders_check.', 'the summary text is kept for review');
  // Re-recording the reviewed summary binds it to the new definition.
  summarize(mem, 'orders', ['orders_check']);
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'fresh', null, false]]);
});

test('a shared function makes every calling trigger stale, on other tables too', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check', 'example.check_row'), trigger('orders', 'orders_log', 'example.log_row')]));
  mem.recordDescribe(describe('exampledb', 'shipments', [trigger('shipments', 'shipments_check', 'example.check_row')]));
  mem.recordFunctions('exampledb', [fn('check_row', 'NEW.order_id IS NULL'), fn('log_row', 'false')]);
  summarize(mem, 'orders', ['orders_check', 'orders_log']);
  summarize(mem, 'shipments', ['shipments_check']);
  mem.recordFunctions('exampledb', [fn('check_row', 'NEW.order_id IS NULL OR NEW.status_code IS NULL')]);
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'stale', 'function-changed', true], ['orders_log', 'fresh', null, false]]);
  assert.deepEqual(freshness(mem, 'shipments'), [['shipments_check', 'stale', 'function-changed', true]]);
  assert.deepEqual(graphTriggers(mem, 'shipments'), freshness(mem, 'shipments'));
});

test('a changed trigger binding or trigger definition is stale', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check'), trigger('orders', 'orders_log')]));
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'false'), fn('other_check', 'true')]);
  summarize(mem, 'orders', ['orders_check', 'orders_log']);
  const same = trigger('orders', 'orders_check');
  mem.recordDescribe(describe('exampledb', 'orders', [
    { ...same, function: 'example.other_check' }, // same definition text, another function
    trigger('orders', 'orders_log', 'example.other_check'),
  ]));
  assert.deepEqual(freshness(mem, 'orders'), [
    ['orders_check', 'stale', 'binding-changed', true],
    ['orders_log', 'stale', 'trigger-changed', true],
  ]);
});

test('missing evidence is unverified: function not recorded, listed only, deleted, unresolved', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [
    trigger('orders', 'a_unknown', 'example.not_recorded'),
    trigger('orders', 'b_listed', 'example.listed_only'),
    trigger('orders', 'c_deleted', 'example.goes_away'),
    trigger('orders', 'd_dotted', 'a.b.c'),
  ]));
  mem.recordListedFunctions('exampledb', [{ schema: 'example', name: 'listed_only', arguments: '', returns: 'trigger', kind: 'function', language: 'plpgsql', volatility: 'volatile' }]);
  mem.recordFunctions('exampledb', [fn('goes_away', 'false')]);
  // "a.b.c" matches both schema a / name b.c and schema a.b / name c.
  mem.recordFunctions('exampledb', [fn('b.c', 'false', { schema: 'a' }), fn('c', 'false', { schema: 'a.b' })]);
  summarize(mem, 'orders', ['a_unknown', 'b_listed', 'c_deleted', 'd_dotted']);
  const ev = mem.readTable('exampledb', 'example', 'orders').triggerSummaries;
  assert.deepEqual([ev.a_unknown, ev.b_listed, ev.d_dotted].map(s => [s.functionEvidence.gap, s.functionEvidence.complete]), [
    ['function-not-recorded', false], ['definition-missing', false], ['binding-unresolved', false],
  ]);
  // The function record of c_deleted disappears from memory.
  fs.rmSync(mem.functionPath('exampledb', 'example', 'goes_away'));
  assert.deepEqual(freshness(mem, 'orders'), [
    ['a_unknown', 'unverified', 'function-not-recorded', false],
    ['b_listed', 'unverified', 'definition-missing', false],
    ['c_deleted', 'unverified', 'function-missing', false],
    ['d_dotted', 'unverified', 'binding-unresolved', false],
  ]);
  // Describing the function later does not confirm the old summary.
  mem.recordFunctions('exampledb', [fn('not_recorded', 'false')]);
  assert.deepEqual(freshness(mem, 'orders')[0], ['a_unknown', 'unverified', 'function-not-recorded', false]);
  summarize(mem, 'orders', ['a_unknown']);
  assert.deepEqual(freshness(mem, 'orders')[0], ['a_unknown', 'fresh', null, false]);
});

test('an overload removed by a complete describe is unverified, not fresh', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check')]));
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'false')]);
  summarize(mem, 'orders', ['orders_check']);
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'false', { arguments: 'p_flag boolean', returns: 'boolean', returnsTrigger: false })]);
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'unverified', 'function-missing', false]]);
});

test('a truncated definition is unverified unless a change shows in its hash or length', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check')]));
  const cut = 'x'.repeat(500);
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'false', { memoryDefinition: cut, definitionLength: 250000 })]);
  summarize(mem, 'orders', ['orders_check']);
  const ev = mem.readTable('exampledb', 'example', 'orders').triggerSummaries.orders_check.functionEvidence;
  assert.equal(ev.complete, false);
  assert.equal(ev.gap, 'definition-truncated');
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'false', { memoryDefinition: cut, definitionLength: 250000 })]);
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'unverified', 'definition-truncated', false]]);
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'false', { memoryDefinition: cut, definitionLength: 250001 })]);
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'stale', 'function-changed', true]]);
});

test('a legacy summary without function evidence is unverified; a trigger change still makes it stale', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check'), trigger('orders', 'orders_log')]));
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'false')]);
  summarize(mem, 'orders', ['orders_check', 'orders_log']);
  const rec = mem.readTable('exampledb', 'example', 'orders');
  for (const s of Object.values(rec.triggerSummaries)) delete s.functionEvidence;
  mem.writeTable('exampledb', rec);
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'unverified', 'legacy', false], ['orders_log', 'unverified', 'legacy', false]]);
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check'), trigger('orders', 'orders_log', 'example.orders_before_write', { definition: 'CREATE TRIGGER orders_log AFTER DELETE ON example.orders FOR EACH ROW EXECUTE FUNCTION example.orders_before_write()' })]));
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'unverified', 'legacy', false], ['orders_log', 'stale', 'trigger-changed', true]]);
});

test('same names in two profiles: a change in one never touches the other', () => {
  const mem = memory();
  for (const profile of ['exampledb', 'testdb']) {
    mem.recordDescribe(describe(profile, 'orders', [trigger('orders', 'orders_check')]));
    mem.recordFunctions(profile, [fn('orders_before_write', 'false')]);
    summarize(mem, 'orders', ['orders_check'], profile);
  }
  mem.recordFunctions('testdb', [fn('orders_before_write', 'true')]);
  assert.deepEqual(freshness(mem, 'orders', 'testdb'), [['orders_check', 'stale', 'function-changed', true]]);
  assert.deepEqual(freshness(mem, 'orders', 'exampledb'), [['orders_check', 'fresh', null, false]]);
  assert.deepEqual(graphTriggers(mem, 'orders', 'exampledb'), [['orders_check', 'fresh', null, false]]);
});

test('a flattened name ending in "()" is never stripped to bind another function', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check', 'example.orders_before_write()')]));
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'false')]);
  summarize(mem, 'orders', ['orders_check']);
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'unverified', 'binding-unresolved', false]]);
});

test('separate function schema and name bind exactly, also with "()" or dots in a name', () => {
  const mem = memory();
  // Both example."audit()" and example.audit are cached; the trigger calls the first.
  const exact = (table, name, schema, fnName) => trigger(table, name, `${schema}.${fnName}`, { functionSchema: schema, functionName: fnName });
  mem.recordDescribe(describe('exampledb', 'orders', [exact('orders', 'a_parens', 'example', 'audit()'), exact('orders', 'b_dotted', 'a', 'b.c')]));
  mem.recordFunctions('exampledb', [fn('audit()', 'false'), fn('audit', 'false'), fn('b.c', 'false', { schema: 'a' }), fn('c', 'false', { schema: 'a.b' })]);
  summarize(mem, 'orders', ['a_parens', 'b_dotted']);
  const ev = mem.readTable('exampledb', 'example', 'orders').triggerSummaries;
  assert.deepEqual([ev.a_parens, ev.b_dotted].map(s => [s.functionEvidence.schema, s.functionEvidence.name, s.functionEvidence.complete]), [['example', 'audit()', true], ['a', 'b.c', true]]);
  assert.deepEqual(freshness(mem, 'orders'), [['a_parens', 'fresh', null, false], ['b_dotted', 'fresh', null, false]]);
  // A change of the namesakes leaves them fresh; a change of the called functions does not.
  mem.recordFunctions('exampledb', [fn('audit', 'true'), fn('c', 'true', { schema: 'a.b' })]);
  assert.deepEqual(freshness(mem, 'orders'), [['a_parens', 'fresh', null, false], ['b_dotted', 'fresh', null, false]]);
  mem.recordFunctions('exampledb', [fn('audit()', 'true'), fn('b.c', 'true', { schema: 'a' })]);
  assert.deepEqual(freshness(mem, 'orders'), [['a_parens', 'stale', 'function-changed', true], ['b_dotted', 'stale', 'function-changed', true]]);
  assert.deepEqual(graphTriggers(mem, 'orders'), freshness(mem, 'orders'));
});

test('an older flattened record bound before keeps its evidence when describe_table adds the identity', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check')]));
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'false')]);
  summarize(mem, 'orders', ['orders_check']);
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check', 'example.orders_before_write', { functionSchema: 'example', functionName: 'orders_before_write' })]));
  assert.deepEqual(freshness(mem, 'orders'), [['orders_check', 'fresh', null, false]]);
});

test('a trigger summary that turns stale makes the table profile stale', () => {
  const mem = memory();
  mem.recordDescribe(describe('exampledb', 'orders', [trigger('orders', 'orders_check')]));
  mem.recordFunctions('exampledb', [fn('orders_before_write', 'NEW.status_code IS NULL')]);
  summarize(mem, 'orders', ['orders_check']);
  mem.saveTableProfile('exampledb', { schema: 'example', table: 'orders', sections: { purpose: 'One row per order.' } });
  assert.deepEqual(mem.tableProfile('exampledb', 'example', 'orders').profile.freshnessReasons, [{ code: 'reports-unknown' }]);
  mem.recordFunctions('exampledb', [fn('orders_before_write', "NEW.status_code NOT IN ('new', 'done')")]);
  const v = mem.tableProfile('exampledb', 'example', 'orders').profile;
  assert.equal(v.freshness, 'stale');
  assert.deepEqual(v.freshnessReasons, [{ code: 'trigger-summaries-changed' }]);
});
