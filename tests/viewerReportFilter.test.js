import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the report-filter block of src/viewer.html (the filter box of the
// Reports list) in isolation.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ report-filter:start[\s\S]*?\/\/ report-filter:end/)?.[0];

function load() {
  assert.ok(block, 'report-filter block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nthis.reportMatches = reportMatches; this.foldText = foldText;`, context);
  return context;
}

const reports = [
  { name: 'order-status-summary', title: 'Order status summary', category: 'Sipariş İşlemleri', stage: 'draft', db: 'example', schema: 'app', description: 'ignored' },
  { name: 'invoice-match', title: 'Invoice match', category: 'IRSALIYE kontrol', stage: 'approved', db: 'example', schema: 'app' },
  { name: 'example-00-preflight', title: 'example-00-preflight', category: 'Integration', stage: 'execute', db: 'example', schema: 'app' },
];
const pick = (q, labels = { draft: 'taslak', approved: 'onaylı', execute: 'execute' }) => {
  const { reportMatches } = load();
  return reports.filter(r => reportMatches(r, q, labels[r.stage])).map(r => r.name);
};

test('an empty query keeps every report', () => {
  assert.deepEqual(pick(''), reports.map(r => r.name));
  assert.deepEqual(pick('   '), reports.map(r => r.name));
});

test('name, title, category and stage match case-insensitively', () => {
  assert.deepEqual(pick('PREFLIGHT'), ['example-00-preflight']);
  assert.deepEqual(pick('status summary'), ['order-status-summary'], 'every word must match');
  assert.deepEqual(pick('integration'), ['example-00-preflight']);
  assert.deepEqual(pick('execute'), ['example-00-preflight'], 'stage key');
  assert.deepEqual(pick('taslak'), ['order-status-summary'], 'stage label');
  assert.deepEqual(pick('ONAYLI'), ['invoice-match'], 'stage label, dotless i');
  assert.deepEqual(pick('ignored'), [], 'the description is not searched');
  assert.deepEqual(pick('status nope'), []);
});

test('Turkish İ, I, ı and i all match each other', () => {
  const { foldText } = load();
  assert.equal(foldText('İŞLEMLERİ'), foldText('işlemleri'));
  assert.equal(foldText('IRSALIYE'), foldText('ırsalıye'));
  assert.equal(foldText('irsaliye'), foldText('IRSALİYE'));
  assert.deepEqual(pick('işlemleri'), ['order-status-summary']);
  assert.deepEqual(pick('İŞLEMLERİ'), ['order-status-summary']);
  assert.deepEqual(pick('islemleri'), [], 'ş stays ş');
  assert.deepEqual(pick('irsaliye'), ['invoice-match']);
  assert.deepEqual(pick('ırsalıye'), ['invoice-match']);
  assert.deepEqual(pick('İRSALİYE'), ['invoice-match']);
});
