import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaMemory, diffFunction, overloadFromDescribe, recordFromDescribe, diffTable } from '../src/memory/store.js';
import { seedExampleMemory, seedExampleViewsAndFunctions, exampleFunctions, viewDescribe, ordersDescribe } from './fixtures/exampleMemory.js';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 1, 1) + (clock++) * 60000).toISOString();
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-fn-mem-'));
const profile = 'exampledb';

test('describe_functions records one file per schema and name with every overload', () => {
  const mem = new SchemaMemory(tempDir(), { now });
  const res = mem.recordFunctions(profile, exampleFunctions());
  assert.deepEqual(res.map(r => [r.function, r.recorded, r.changesSinceLast]), [
    ['example.order_total', 'first time', []],
    ['example.order_report', 'first time', []],
  ]);
  const file = path.join(mem.root, profile, 'functions', 'example', 'order_total.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.overloads.length, 2);
  assert.deepEqual(rec.overloads.map(o => o.arguments), ['p_order_id bigint', 'p_order_id bigint, p_currency text']);
  const [o] = rec.overloads;
  assert.ok(rec.describedAt && rec.firstSeen && rec.lastSeen);
  assert.match(o.definitionHash, /^[0-9a-f]{16}$/);
  assert.deepEqual(o.touches, { inferred: true, reads: ['example.order_items'], writes: [] });
  assert.equal(o.truncated, false);
  assert.deepEqual(rec.history, []);
});

test('re-describe reports overload, definition and property changes and keeps a capped history', () => {
  const mem = new SchemaMemory(tempDir(), { now });
  const [a, b, report] = exampleFunctions();
  mem.recordFunctions(profile, [a, b, report]);
  const changed = [
    { ...a, definition: a.definition.replace('sum(amount)', 'sum(amount) * 2'), volatility: 'volatile', config: ['search_path=example'] },
    { ...a, arguments: 'p_order_id integer' },
  ];
  const [res] = mem.recordFunctions(profile, changed);
  assert.equal(res.recorded, 'updated');
  assert.deepEqual(res.changesSinceLast.sort(), [
    'definition of (p_order_id bigint) changed',
    'overload (p_order_id bigint, p_currency text) removed',
    'overload (p_order_id integer) added',
    'properties of (p_order_id bigint) changed: volatility, config',
  ]);
  for (let i = 0; i < 55; i++) mem.recordFunctions(profile, [{ ...changed[0], owner: `owner_${i % 2}` }, changed[1]]);
  const rec = mem.readFunction(profile, 'example', 'order_total');
  assert.equal(rec.history.length, 50, 'history is capped like tables');
  assert.deepEqual(rec.history.at(-1).changes, [{ change: 'flags-changed', arguments: 'p_order_id bigint', fields: ['owner'] }]);
});

test('a pattern result cut at its limit never reports the missing overloads as removed', () => {
  const mem = new SchemaMemory(tempDir(), { now });
  const [a, b] = exampleFunctions();
  mem.recordFunctions(profile, [a, b]);
  const [res] = mem.recordFunctions(profile, [a], { partial: new Set(['example.order_total']) });
  assert.deepEqual(res.changesSinceLast, []);
  assert.equal(mem.readFunction(profile, 'example', 'order_total').overloads.length, 2);
});

test('list_functions records seen overloads and never overwrites a described definition', () => {
  const mem = new SchemaMemory(tempDir(), { now });
  const [a] = exampleFunctions();
  mem.recordFunctions(profile, [a]);
  const before = mem.readFunction(profile, 'example', 'order_total');
  const listed = mem.recordListedFunctions(profile, [
    { schema: 'example', name: 'order_total', arguments: 'p_order_id bigint', returns: 'numeric', kind: 'function', language: 'plpgsql', volatility: 'volatile' },
    { schema: 'example', name: 'order_total', arguments: 'p_order_id integer', returns: 'numeric', kind: 'function', language: 'plpgsql', volatility: 'stable' },
    { schema: 'example', name: 'order_count', arguments: '', returns: 'bigint', kind: 'function', language: 'sql', volatility: 'stable' },
  ]);
  assert.deepEqual(listed, { functionsAdded: 1, overloadsAdded: 1 });
  const after = mem.readFunction(profile, 'example', 'order_total');
  assert.deepEqual(after.overloads[0], before.overloads[0], 'the described overload is unchanged (volatility too)');
  assert.equal(after.describedAt, before.describedAt);
  assert.deepEqual(after.overloads[1], {
    arguments: 'p_order_id integer', returns: 'numeric', kind: 'function', language: 'plpgsql', volatility: 'stable',
    returnsTrigger: false, usedByTriggers: [], definition: null, definitionLength: null, truncated: false, definitionHash: null, touches: null, calls: [], callsVersion: 2, listedOnly: true,
  });
  const seen = mem.readFunction(profile, 'example', 'order_count');
  assert.equal(seen.describedAt, null);
  assert.deepEqual(mem.recordListedFunctions(profile, [{ schema: 'example', name: 'order_count', arguments: '' }]), { functionsAdded: 0, overloadsAdded: 0 });
  // Describing a listed overload later: it counts as added since the last describe.
  const [res] = mem.recordFunctions(profile, [a, { ...a, arguments: 'p_order_id integer' }]);
  assert.deepEqual(res.changesSinceLast, ['overload (p_order_id integer) added']);
  assert.equal(mem.recordFunctions(profile, [{ schema: 'example', name: 'order_count', arguments: '', language: 'sql', definition: 'x' }])[0].recorded, 'first time');
});

test('stored definitions are cut at 200000 characters; touches only for sql and plpgsql', () => {
  const long = `CREATE FUNCTION example.f()\n LANGUAGE sql\nAS $function$ SELECT 1 FROM example.orders ${'-- x\n'.repeat(50000)} $function$`;
  const o = overloadFromDescribe({ schema: 'example', name: 'f', arguments: '', language: 'sql', definition: long, definitionLength: long.length });
  assert.equal(o.definition.length, 200000);
  assert.equal(o.truncated, true);
  assert.deepEqual(o.touches.reads, ['example.orders']);
  const hidden = { schema: 'example', name: 'f', arguments: '', language: 'sql', definition: 'short', definitionLength: 5 };
  Object.defineProperty(hidden, 'memoryDefinition', { value: 'stored text', enumerable: false });
  assert.equal(overloadFromDescribe(hidden).definition, 'stored text', 'the memory text wins over the returned one');
  assert.equal(overloadFromDescribe({ schema: 'example', name: 'f', language: 'plperl', definition: 'x' }).touches, null);
  assert.equal(overloadFromDescribe({ schema: 'example', name: 'agg', kind: 'aggregate', language: 'internal', definition: null }).definitionHash, null);
});

test('diffFunction compares definitions only when both are known', () => {
  const o = { arguments: '', definitionHash: 'a', volatility: 'stable', config: [] };
  assert.deepEqual(diffFunction([o], [{ ...o, definitionHash: null }]), []);
  assert.deepEqual(diffFunction([o], [{ ...o, definitionHash: 'b' }]), [{ change: 'definition-changed', arguments: '' }]);
  // A change after the stored 200000 characters only shows in the full length.
  const long = { ...o, definitionLength: 250000 };
  assert.deepEqual(diffFunction([long], [{ ...long, definitionLength: 25010 }]), [{ change: 'definition-changed', arguments: '' }]);
  assert.deepEqual(diffFunction([long], [{ ...long, definitionLength: null }]), [], 'an unknown length is no change');
});

test('view records keep the view fields; sources changes are reported; old records load fine', () => {
  const rec = recordFromDescribe(viewDescribe(profile));
  assert.equal(rec.viewDefinitionTruncated, false);
  assert.equal(rec.viewDefinitionLength, viewDescribe(profile).viewDefinition.length);
  assert.deepEqual(rec.viewOptions, { securityBarrier: false, checkOption: null });
  assert.equal(rec.populated, undefined, 'only for materialized views');
  assert.deepEqual(rec.viewSources.map(s => s.table), ['customers', 'orders']);
  assert.deepEqual(rec.usedByViews, []);
  const next = recordFromDescribe({ ...viewDescribe(profile), viewSources: [{ schema: 'example', table: 'orders', kind: 'table', columns: ['order_id'] }, { schema: 'example', table: 'shipments', kind: 'table', columns: [] }] });
  assert.deepEqual(diffTable(rec, next), [{ change: 'view-sources-changed', added: ['example.shipments'], removed: ['example.customers'] }]);
  const old = { ...rec };
  delete old.viewSources;
  assert.deepEqual(diffTable(old, next), [], 'records without viewSources report no sources change');
  const long = recordFromDescribe({ ...viewDescribe(profile), viewDefinition: 'x'.repeat(250000) });
  assert.deepEqual([long.viewDefinition.length, long.viewDefinitionLength, long.viewDefinitionTruncated], [200000, 250000, true]);
  assert.equal(long.viewHash, recordFromDescribe({ ...viewDescribe(profile), viewDefinition: 'x'.repeat(250000) }).viewHash);
  assert.notEqual(long.viewHash, recordFromDescribe({ ...viewDescribe(profile), viewDefinition: `${'x'.repeat(250000)}y` }).viewHash, 'the hash covers the full text');
  const table = recordFromDescribe(ordersDescribe(profile));
  assert.equal(table.viewSources, undefined);
  assert.equal(table.usedByViews, undefined, 'absent when the describe result has none');
});

test('graph: view nodes with sources and functions, view edges, functions with calledBy, flags and touches', () => {
  const dir = tempDir();
  seedExampleMemory(dir, profile, { now });
  const mem = seedExampleViewsAndFunctions(dir, profile, { now });
  const graph = JSON.parse(fs.readFileSync(path.join(dir, profile, 'graph.json'), 'utf8'));
  const view = graph.nodes.find(n => n.id === 'example.v_order_list');
  assert.equal(view.kind, 'view');
  assert.deepEqual(view.viewSources, ['example.customers', 'example.orders']);
  assert.deepEqual(view.viewFunctions, ['example.order_total']);
  const viewEdges = graph.edges.filter(e => e.level === 'view');
  assert.deepEqual(viewEdges.map(e => `${e.from}>${e.to}`).sort(), [
    'example.mv_order_days>example.orders', 'example.v_order_list>example.customers', 'example.v_order_list>example.orders',
  ]);
  assert.deepEqual(viewEdges.find(e => e.to === 'example.customers'), { level: 'view', from: 'example.v_order_list', to: 'example.customers', columns: ['customer_id'], refColumns: [] });
  assert.ok(graph.edges.some(e => e.level === 'fk'), 'foreign key edges stay');
  assert.equal(graph.nodes.find(n => n.id === 'example.orders').viewSources, undefined);

  assert.deepEqual(graph.functions.map(f => f.id), ['example.order_count', 'example.order_report', 'example.order_total']);
  const [count, report, total] = graph.functions;
  assert.deepEqual(count, {
    id: 'example.order_count', schema: 'example', name: 'order_count', file: 'functions/example/order_count.json', state: 'seen', overloads: 1,
    kinds: ['function'], role: 'function', timings: [], triggerTables: [], language: 'sql', flags: { volatile: false, securityDefiner: false, definerWithoutSearchPath: false }, usedByTriggers: 0,
    calledBy: { views: [], functions: [] }, touches: { reads: [], writes: [] }, changes: 0,
  });
  assert.equal(total.state, 'explored');
  assert.equal(total.overloads, 2, 'the listed overload already existed');
  assert.deepEqual(total.calledBy, { views: ['example.v_order_list'], functions: ['example.order_report'] });
  assert.deepEqual(total.touches, { reads: ['example.order_items'], writes: [] });
  assert.deepEqual(report.flags, { volatile: true, securityDefiner: true, definerWithoutSearchPath: true });
  assert.equal(report.usedByTriggers, 1);
  assert.deepEqual(report.touches, { reads: ['example.orders'], writes: ['example.order_events'] });
  assert.equal(JSON.stringify(graph.functions).includes('CREATE'), false, 'no definitions in the graph');

  // A search_path entry clears the flag.
  const [, , r] = exampleFunctions();
  mem.recordFunctions(profile, [{ ...r, config: ['search_path=example, pg_temp'] }]);
  const again = JSON.parse(fs.readFileSync(path.join(dir, profile, 'graph.json'), 'utf8'));
  assert.equal(again.functions.find(f => f.id === 'example.order_report').flags.definerWithoutSearchPath, false);
  assert.equal(again.functions.find(f => f.id === 'example.order_report').changes, 1);
});

test('a graph without function files has an empty functions array', () => {
  const dir = tempDir();
  seedExampleMemory(dir, profile, { now });
  const graph = JSON.parse(fs.readFileSync(path.join(dir, profile, 'graph.json'), 'utf8'));
  assert.deepEqual(graph.functions, []);
  assert.ok(graph.nodes.length > 0);
});

test('the graph rebuild needs no function bodies: calledBy comes from the stored calls', () => {
  const dir = tempDir();
  const mem = new SchemaMemory(dir, { now });
  mem.recordFunctions(profile, exampleFunctions());
  const graphOf = () => JSON.parse(fs.readFileSync(path.join(dir, profile, 'graph.json'), 'utf8')).functions;
  const before = graphOf();
  const file = mem.functionPath(profile, 'example', 'order_report');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(rec.overloads[0].calls, [{ schema: 'example', name: 'order_total' }], 'stored at describe time');
  // Without its bodies the record still gives the same calledBy.
  fs.writeFileSync(file, JSON.stringify({ ...rec, overloads: rec.overloads.map(o => ({ ...o, definition: null })) }));
  mem.rebuildView(profile);
  assert.deepEqual(graphOf().map(f => f.calledBy), before.map(f => f.calledBy));
  assert.deepEqual(graphOf().find(f => f.name === 'order_total').calledBy.functions, ['example.order_report']);
  // A record from before calls were stored: computed from its definition.
  const old = JSON.parse(fs.readFileSync(path.join(dir, profile, 'functions', 'example', 'order_report.json'), 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...old, overloads: rec.overloads.map(({ calls, ...o }) => o) }));
  mem.rebuildView(profile);
  assert.deepEqual(graphOf().find(f => f.name === 'order_total').calledBy.functions, ['example.order_report']);
  const graph = fs.readFileSync(path.join(dir, profile, 'graph.json'), 'utf8');
  assert.equal(graph.includes('CREATE OR REPLACE FUNCTION'), false);
  assert.equal([...mem.cache.keys()].some(k => k.includes(`${path.sep}functions${path.sep}`)), false, 'no function record (with bodies) in the read cache');
});

test('a definition cut at a lower cap is not reported as changed when the new text continues it', () => {
  const old = { arguments: '', definition: 'x'.repeat(20000), definitionHash: 'a', definitionLength: 25000, truncated: true, config: [] };
  const same = { ...old, definition: 'x'.repeat(25000), definitionHash: 'b', truncated: false };
  assert.deepEqual(diffFunction([old], [same]), []);
  assert.deepEqual(diffFunction([old], [{ ...same, definition: `${'x'.repeat(19999)}y${'x'.repeat(5000)}` }]), [{ change: 'definition-changed', arguments: '' }]);
  assert.deepEqual(diffFunction([old], [{ ...same, definitionLength: 25001 }]), [{ change: 'definition-changed', arguments: '' }]);
});

test('calls stored by an older scanner are recomputed once from the stored definition and written back (#139)', () => {
  const dir = tempDir();
  const mem = new SchemaMemory(dir, { now });
  const total = 'CREATE OR REPLACE FUNCTION example.order_total(integer)\n RETURNS integer\n LANGUAGE plpgsql\nAS $body$\nBEGIN\n  RAISE EXCEPTION \'example.order_total was called\';\nEND\n$body$\n';
  const report = 'CREATE OR REPLACE FUNCTION example.order_report()\n RETURNS integer\n LANGUAGE sql\nAS $body$\n  WITH order_total(total) AS (SELECT 7)\n  SELECT total FROM order_total;\n$body$\n';
  const fn = (name, args, definition, language) => ({ schema: 'example', name, arguments: args, returns: 'integer', kind: 'function', language, volatility: 'volatile', config: [], definition });
  mem.recordFunctions(profile, [fn('order_total', 'integer', total, 'plpgsql'), fn('order_report', '', report, 'sql')]);
  const calledBy = () => mem.graph(profile).functions.find(f => f.name === 'order_total').calledBy.functions;
  assert.deepEqual(calledBy(), [], 'the CTE is no caller');
  // A record written by the old scanner: the CTE stored as a call, no callsVersion.
  const file = mem.functionPath(profile, 'example', 'order_report');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, overloads: rec.overloads.map(({ callsVersion, ...o }) => ({ ...o, calls: [{ schema: null, name: 'order_total' }] })) }));
  assert.deepEqual(calledBy(), []);
  const upgraded = JSON.parse(fs.readFileSync(file, 'utf8')).overloads[0];
  assert.deepEqual([upgraded.calls, upgraded.callsVersion], [[], 2], 'written back once');
  assert.equal(upgraded.definition, report, 'the definition is kept');
  const mtime = fs.statSync(file, { bigint: true }).mtimeNs;
  calledBy();
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, mtime, 'not written again');
});
