import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Table identities and column-name keys in src/viewer.html, with its blocks
// run in isolation: names like constructor or toString are ordinary column
// names, and a schema or table name with a dot keeps its own table id.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const blockOf = name => page.match(new RegExp(`// ${name}:start[\\s\\S]*?// ${name}:end`))?.[0];

function run(names, exports) {
  for (const name of names) assert.ok(blockOf(name), `${name} block found`);
  const context = vm.createContext({ JSON, Map });
  vm.runInContext(`${names.map(blockOf).join('\n')}\nObject.assign(this, { ${exports.join(', ')} });`, context);
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
