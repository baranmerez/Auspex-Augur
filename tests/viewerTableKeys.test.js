import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { tableKey as storeTableKey } from '../src/memory/store.js';

// Table identities and column-name keys in src/viewer.html, with its blocks
// run in isolation: names like constructor or toString are ordinary column
// names, and a schema or table name with a dot keeps its own table id.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const tableKeyLines = page.match(/^const tableKey = .*\r?\n^const splitTableKey = .*$/m)[0];
const blockOf = name => page.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`))?.[0];

function run(names, exports) {
  for (const name of names) assert.ok(blockOf(name), `${name} block found`);
  const context = vm.createContext({ JSON, Map });
  vm.runInContext(`${tableKeyLines}\n${names.map(blockOf).join('\n')}\nObject.assign(this, { ${exports.join(', ')} });`, context);
  return context;
}

const builtInColumns = ['id', 'constructor', 'toString', '__proto__', 'total'];
const ordersRec = usedColumns => ({
  columns: builtInColumns.map(name => ({ name, type: 'integer' })),
  constraints: [{ name: 'orders_pkey', type: 'primary key', columns: ['id'] }],
  usedColumns,
});

test('columns named like object built-ins are not tagged used before any usage', () => {
  const { centerColumns, dictionaryModel } = run(['roles', 'data-dictionary'], ['centerColumns', 'dictionaryModel']);
  const data = { nodes: [{ id: 'example.orders', schema: 'example', table: 'orders', state: 'explored' }], edges: [], notes: [] };
  const fresh = centerColumns(data, 'example.orders', ordersRec({}));
  assert.deepEqual(Array.from(fresh.keyCols, c => c.name), ['id']);
  const used = JSON.parse('{"constructor":{"count":1},"__proto__":{"count":2}}');
  const after = centerColumns(data, 'example.orders', ordersRec(used));
  assert.deepEqual(Array.from(after.keyCols, c => [c.name, Array.from(after.tagsOf(c.name)).join(',')]), [['id', 'PK'], ['constructor', 'U'], ['__proto__', 'U']]);

  const dictionary = rec => dictionaryModel({ profile: 'exampledb', ...data }, new Map([['example.orders', rec]]), '2026-10-18T00:00:00.000Z');
  const tagged = model => Array.from(model.tables[0].keyColumns, c => [c.name, Array.from(c.tags).join(',')]);
  assert.deepEqual(tagged(dictionary(ordersRec({}))), [['id', 'pk']]);
  assert.deepEqual(tagged(dictionary(ordersRec(used))), [['id', 'pk'], ['constructor', 'used'], ['__proto__', 'used']]);
});

// Ids as src/memory/store.js writes them for example."orders.history" and
// "example.orders".history: two different tables.
const dottedTable = '"example.orders".history';
const dottedName = 'example."orders.history"';
const dottedGraph = () => ({
  nodes: [
    { id: 'example.customers', schema: 'example', table: 'customers', state: 'explored' },
    { id: dottedName, schema: 'example', table: 'orders.history', state: 'explored' },
    { id: dottedTable, schema: 'example.orders', table: 'history', state: 'explored' },
  ],
  edges: [{ level: 'fk', from: dottedName, to: 'example.customers', columns: ['customer_id'], refColumns: ['id'] }],
  notes: [
    { id: 1, kind: 'rule', schema: 'example', table: 'orders.history', column: 'customer_id', text: 'Rule on the dotted table name.', status: 'active' },
    { id: 2, kind: 'rule', schema: 'example.orders', table: 'history', column: 'note', text: 'Rule on the dotted schema name.', status: 'active' },
    { id: 3, kind: 'rule', schema: 'example', table: 'customers', column: null, text: 'Rule on an ordinary table.', status: 'active' },
  ],
});

test('viewer table ids match the store keys for dotted names and stay plain otherwise', () => {
  const { tableKey, splitTableKey } = run([], ['tableKey', 'splitTableKey']);
  assert.equal(tableKey('example', 'orders'), 'example.orders');
  assert.equal(tableKey('Example', 'Order Lines'), 'Example.Order Lines');
  assert.equal(tableKey('example.orders', 'history'), dottedTable);
  assert.equal(tableKey('example', 'orders.history'), dottedName);
  assert.equal(tableKey('x"y', 'a'), '"x""y".a');
  for (const [schema, table] of [['example', 'orders'], ['example.orders', 'history'], ['example', 'orders.history'], ['x"y', 'a.b']]) {
    assert.deepEqual({ ...splitTableKey(tableKey(schema, table)) }, { schema, table });
    assert.equal(tableKey(schema, table), storeTableKey(schema, table), 'same text as the store');
  }
});

test('centerColumns and join labels keep dotted tables apart', () => {
  const { centerColumns, joinLabels, roleGroups, tableOf } = run(['roles'], ['centerColumns', 'joinLabels', 'roleGroups', 'tableOf']);
  const data = dottedGraph();
  const rec = { columns: [{ name: 'note', type: 'text' }], constraints: [], usedColumns: {} };
  const other = centerColumns(data, dottedTable, rec);
  assert.deepEqual(Array.from(other.notes, n => n.id), [2], 'only the notes of "example.orders".history');
  assert.deepEqual(Array.from(other.keyCols, c => c.name), ['note']);
  assert.deepEqual(Array.from(centerColumns(data, dottedName, { columns: [{ name: 'customer_id', type: 'integer' }], constraints: [] }).notes, n => n.id), [1]);

  const dep = roleGroups(data, 'example.customers').dep;
  assert.deepEqual(Array.from(dep, g => g.id), [dottedName]);
  assert.deepEqual(Array.from(joinLabels(dep[0], 'example.customers')), ['customer_id → customers.id']);
  const ref = roleGroups(data, dottedName).ref;
  assert.deepEqual(Array.from(joinLabels(ref[0], dottedName)), ['customer_id → customers.id']);
  assert.equal(tableOf(dottedName), 'orders.history');
  assert.equal(tableOf(dottedTable), 'history');
  assert.equal(tableOf(dottedTable, { table: 'history' }), 'history');
  assert.equal(tableOf('example.orders'), 'orders');
});

test('Rules targets and groups use the table id with schema and table fields', () => {
  const { filterRules, groupRules } = run(['report-filter', 'rules-list'], ['filterRules', 'groupRules']);
  const groups = groupRules(filterRules(dottedGraph().notes, {}));
  assert.deepEqual(Array.from(groups, g => [g.key, g.schema, g.table]), [
    ['"example.orders".history', 'example.orders', 'history'],
    ['example."orders.history"', 'example', 'orders.history'],
    ['example.customers', 'example', 'customers'],
  ]);
});

test('the table page model of a dotted table links to the right ids', () => {
  const { tablePageModel } = run(['report-filter', 'table-page'], ['tablePageModel']);
  const data = dottedGraph();
  const rec = {
    describedAt: '2026-01-01T00:00:00.000Z', columns: [{ name: 'id', type: 'integer' }, { name: 'customer_id', type: 'integer' }],
    constraints: [{ name: 'history_customer_fk', type: 'foreign key', columns: ['customer_id'], references: { schema: 'example', table: 'customers', columns: ['id'] } }],
    referencedBy: [{ name: 'notes_history_fk', schema: 'example.orders', table: 'history', columns: ['history_id'], refColumns: ['id'] }],
    indexes: [],
  };
  const m = tablePageModel(data, dottedName, rec);
  assert.deepEqual([m.schema, m.table], ['example', 'orders.history']);
  const customerId = m.columns.find(c => c.name === 'customer_id');
  assert.deepEqual(Array.from(customerId.notes, n => n.id), [1], 'only the notes of example."orders.history"');
  assert.deepEqual({ ...customerId.fk }, { id: 'example.customers', column: 'id' });
  assert.deepEqual(Array.from(m.keys.outgoing, k => k.id), ['example.customers']);
  assert.deepEqual(Array.from(m.keys.incoming, k => k.id), [dottedTable]);
  // An id without a node falls back to the parsed key, not the first dot.
  const bare = tablePageModel({ nodes: [], edges: [], notes: [] }, dottedTable, null);
  assert.deepEqual([bare.schema, bare.table], ['example.orders', 'history']);
});
