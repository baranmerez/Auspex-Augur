import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The data-dictionary block of src/viewer.html in isolation: the model built
// from graph.json and table files, the HTML and Markdown documents, escaping
// and the file name.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ data-dictionary:start[\s\S]*?\/\/ data-dictionary:end/)?.[0];

function load() {
  assert.ok(block, 'data-dictionary block found in viewer.html');
  const context = vm.createContext({ JSON, Map });
  vm.runInContext(`${block}\nthis.dictionaryModel = dictionaryModel; this.dictionaryHtml = dictionaryHtml; this.dictionaryMarkdown = dictionaryMarkdown; this.dictionaryFileName = dictionaryFileName;`, context);
  return context;
}

const evil = '<img src=x onerror=alert(1)>';
const graph = {
  profile: 'exampledb',
  generatedAt: '2026-10-18T08:00:00.000Z',
  nodes: [
    { id: 'example.orders', schema: 'example', table: 'orders', file: 'tables/example/orders.json', state: 'explored', kind: 'table', estimatedRows: 1200, columnCount: 4 },
    { id: 'example.customers', schema: 'example', table: 'customers', file: 'tables/example/customers.json', state: 'explored', kind: 'table', estimatedRows: 40, columnCount: 2 },
    { id: 'example.status_codes', schema: 'example', table: 'status_codes', state: 'unexplored', kind: null, estimatedRows: null, columnCount: 0 },
    { id: `example.${evil}`, schema: 'example', table: evil, file: 'tables/example/x.json', state: 'explored', kind: 'table', estimatedRows: null, columnCount: 1 },
  ],
  edges: [
    { level: 'fk', from: 'example.orders', to: 'example.customers', columns: ['customer_id'], refColumns: ['customer_id'] },
    { level: 'fk', from: 'example.orders', to: 'example.status_codes', columns: ['status_code'], refColumns: ['status_code'] },
    { level: 'suggested', from: 'example.orders', to: 'test.invoices', columns: ['order_id'], refColumns: ['order_id'] },
  ],
  notes: [
    { id: 1, kind: 'rule', schema: 'example', table: 'orders', column: 'status_code', text: 'Cancelled orders have status_code 9.', status: 'active' },
    { id: 2, kind: 'observation', schema: 'example', table: 'orders', column: 'created_at', text: 'created_at is always filled.', status: 'active', asOf: '2026-10-01',
      evidence: { sql: "select count(*) from example.orders where customer_id = 'SECRET-SQL-LITERAL'", figures: { rows: 1200, filled: 1200 } } },
    { id: 3, kind: 'inference', schema: 'example', table: 'orders', column: null, text: 'UNCONFIRMED-INFERENCE', status: 'active' },
    { id: 4, kind: 'rule', schema: 'example', table: 'orders', column: null, text: 'ARCHIVED-RULE', status: 'archived' },
    { id: 5, kind: 'rule', schema: null, table: null, column: null, text: 'Amounts are in EUR.', status: 'active' },
    { id: 6, kind: 'rule', schema: 'example', table: evil, column: null, text: `Text with ${evil} and "quotes" & 'apostrophes'`, status: 'active' },
  ],
};
const tables = new Map([
  ['example.orders', {
    schema: 'example', table: 'orders', kind: 'table', comment: 'Customer orders',
    columns: [
      { name: 'order_id', type: 'bigint', notNull: true, comment: null },
      { name: 'customer_id', type: 'bigint', notNull: true, comment: 'Who ordered' },
      { name: 'status_code', type: 'integer', notNull: false, comment: null },
      { name: 'amount', type: 'numeric', notNull: false, comment: null },
      { name: 'created_at', type: 'timestamptz', notNull: true, comment: null },
    ],
    constraints: [
      { name: 'orders_pkey', type: 'primary key', columns: ['order_id'] },
      { name: 'orders_customer_fk', type: 'foreign key', columns: ['customer_id'], references: { schema: 'example', table: 'customers', columns: ['customer_id'] } },
    ],
    usedColumns: { amount: { count: 3 } },
  }],
  ['example.customers', { schema: 'example', table: 'customers', kind: 'table', comment: null, columns: [{ name: 'customer_id', type: 'bigint', notNull: true }], constraints: [{ type: 'primary key', columns: ['customer_id'] }] }],
  [`example.${evil}`, null],
]);
const model = () => load().dictionaryModel(graph, tables, '2026-10-18T09:30:00.000Z');

test('the model lists explored tables with key columns, relations and active rules and observations', () => {
  const m = JSON.parse(JSON.stringify(model()));
  assert.equal(m.profile, 'exampledb');
  assert.deepEqual(m.tables.map(t => t.id), [`example.${evil}`, 'example.customers', 'example.orders'], 'explored only, sorted');
  const orders = m.tables.find(t => t.id === 'example.orders');
  assert.equal(orders.comment, 'Customer orders');
  assert.deepEqual(orders.keyColumns.map(c => [c.name, c.tags.join(',')]),
    [['order_id', 'pk'], ['customer_id', 'fk'], ['status_code', 'note'], ['amount', 'used'], ['created_at', 'note']]);
  assert.deepEqual(orders.notes.map(n => n.id), [1, 2], 'rules before observations; no inference, no archived note');
  assert.deepEqual(orders.notes[1].figures, { rows: 1200, filled: 1200 }, 'observations keep their aggregate figures');
  assert.deepEqual(orders.references.map(r => r.table), ['example.customers', 'example.status_codes'], 'no suggested relations');
  const customers = m.tables.find(t => t.id === 'example.customers');
  assert.deepEqual(customers.referencedBy.map(r => [r.table, r.columns.join(',')]), [['example.orders', 'customer_id']]);
  assert.deepEqual(m.databaseNotes.map(n => n.id), [5]);
});

test('the HTML is self-contained, escapes every name and text and leaves out evidence SQL, inferences and archived notes', () => {
  const html = load().dictionaryHtml(model());
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
  assert.ok(!/<script|<link|src="http|href="http/i.test(html), 'no scripts or external resources');
  assert.ok(!html.includes(evil), 'raw markup never appears');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&quot;quotes&quot; &amp; &#39;apostrophes&#39;'));
  for (const left of ['SECRET-SQL-LITERAL', 'UNCONFIRMED-INFERENCE', 'ARCHIVED-RULE']) assert.ok(!html.includes(left), left);
  assert.ok(html.includes('rows: 1200 · filled: 1200'));
  assert.ok(html.includes('Data dictionary: exampledb'));
  assert.ok(html.includes('2026-10-18 09:30 UTC'));
  assert.ok(html.includes('Amounts are in EUR.'));
  assert.ok(html.includes('Customer orders'));
  assert.ok(html.includes('customer_id → example.customers (customer_id)'));
  assert.match(html, /<a href="#t2">example\.customers<\/a>/);
});

test('the Markdown has the same content, escaped against markup and inline HTML', () => {
  const md = load().dictionaryMarkdown(model());
  assert.match(md, /^# Data dictionary: exampledb\n/);
  assert.ok(!md.includes(evil), 'raw markup never appears');
  assert.ok(md.includes('\\<img src=x onerror=alert\\(1\\)\\>'));
  for (const left of ['SECRET-SQL-LITERAL', 'UNCONFIRMED-INFERENCE', 'ARCHIVED-RULE']) assert.ok(!md.includes(left), left);
  assert.ok(md.includes('## example.orders'));
  assert.ok(md.includes('| order\\_id | bigint NOT NULL | pk |  |'));
  assert.ok(md.includes('- **rule** `status_code`: Cancelled orders have status\\_code 9.'));
  assert.ok(md.includes('rows: 1200 · filled: 1200'));
  const table = load().dictionaryMarkdown(load().dictionaryModel({ ...graph, notes: [] }, new Map([['example.orders', { ...tables.get('example.orders'), comment: 'a | b\nc' }]]), 'x'));
  assert.ok(table.includes('a \\| b c'), 'pipes and new lines cannot break the document');
});

test('an empty memory still gives a valid document, and the file name is fixed and safe', () => {
  const { dictionaryModel, dictionaryHtml, dictionaryMarkdown, dictionaryFileName } = load();
  const empty = dictionaryModel({ profile: 'exampledb', nodes: [], edges: [], notes: [] }, new Map(), '2026-10-18T00:00:00.000Z');
  assert.ok(dictionaryHtml(empty).includes('No explored tables yet.'));
  assert.ok(dictionaryMarkdown(empty).includes('No explored tables yet.'));
  assert.equal(dictionaryFileName('exampledb', '2026-10-18', 'html'), 'auspex-data-dictionary-exampledb-2026-10-18.html');
  assert.equal(dictionaryFileName('exampledb', '2026-10-18', 'md'), 'auspex-data-dictionary-exampledb-2026-10-18.md');
  assert.equal(dictionaryFileName('../evil.bat', '2026-10-18', 'exe'), 'auspex-data-dictionary-___evil_bat-2026-10-18.html');
  const tr = (s, v = {}) => `TR:${s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '')}`;
  assert.ok(dictionaryHtml(empty, tr, 'tr').startsWith('<!doctype html>\n<html lang="tr">'));
  assert.ok(dictionaryHtml(empty, tr, 'tr').includes('TR:Data dictionary: exampledb'));
});
