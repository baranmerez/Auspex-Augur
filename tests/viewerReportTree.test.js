import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the report-tree block of src/viewer.html (the Reports list as a
// topic -> subtopic -> report tree) in isolation.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ report-tree:start[\s\S]*?\/\/ report-tree:end/)?.[0];
const filterBlock = page.match(/\/\/ report-filter:start[\s\S]*?\/\/ report-filter:end/)?.[0];

function load() {
  assert.ok(block, 'report-tree block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${filterBlock}\n${block}\nthis.buildReportTree = buildReportTree; this.isNodeOpen = isNodeOpen; this.ancestorKeys = ancestorKeys; this.categoryLevels = categoryLevels; this.reportMatches = reportMatches; this.inStageTab = inStageTab; this.stageTabCount = stageTabCount; this.stageTabFor = stageTabFor;`, context);
  return context;
}

const r = (category, title, extra = {}) => ({ db: 'exampledb', schema: 'example', stage: 'draft', category, name: title.toLowerCase().replace(/\s+/g, '-'), title, ...extra });
const reports = [
  r('Orders/Delivery', 'Late deliveries'),
  r('Orders', 'Order totals'),
  r('Invoices', 'Unpaid invoices'),
  r('Orders/Delivery/Weekly', 'Weekly deliveries', { categoryPath: ['Orders', 'Delivery', 'Weekly'] }),
  r('Orders/Delivery', 'Delivery summary', { db: 'other', schema: 'test' }),
  r('İadeler', 'Returns'),
];
// Plain JSON so arrays built inside the vm context compare by value.
const plain = x => JSON.parse(JSON.stringify(x));
const shape = n => ({ label: n.label, count: n.count, reports: n.reports.map(x => x.title), children: n.children.map(shape) });

test('reports are grouped by category level with counts per node, sorted by name (Turkish collation: I before İ)', () => {
  const { buildReportTree } = load();
  const tree = buildReportTree(reports);
  assert.equal(tree.count, reports.length);
  assert.deepEqual(plain(tree.children.map(shape)), [
    { label: 'Invoices', count: 1, reports: ['Unpaid invoices'], children: [] },
    { label: 'İadeler', count: 1, reports: ['Returns'], children: [] },
    {
      label: 'Orders', count: 4, reports: ['Order totals'], children: [{
        label: 'Delivery', count: 3, reports: ['Delivery summary', 'Late deliveries'], children: [
          { label: 'Weekly', count: 1, reports: ['Weekly deliveries'], children: [] },
        ],
      }],
    },
  ]);
  const weekly = tree.children[2].children[0].children[0];
  assert.deepEqual(plain([weekly.key, weekly.path]), ['Orders/Delivery/Weekly', ['Orders', 'Delivery', 'Weekly']]);
});

test('db and schema are not tree levels: the same category of two databases is one node', () => {
  const { buildReportTree } = load();
  const delivery = buildReportTree(reports).children.find(n => n.label === 'Orders').children[0];
  assert.deepEqual(plain(delivery.reports.map(x => x.db).sort()), ['exampledb', 'other']);
});

test('a filter opens every node of the tree it leaves; otherwise the remembered state counts', () => {
  const { buildReportTree, isNodeOpen, reportMatches } = load();
  const matches = reports.filter(x => reportMatches(x, 'weekly'));
  const tree = buildReportTree(matches);
  const nodes = [];
  const walk = n => { nodes.push(n); n.children.forEach(walk); };
  tree.children.forEach(walk);
  assert.deepEqual(plain(nodes.map(n => n.key)), ['Orders', 'Orders/Delivery', 'Orders/Delivery/Weekly']);
  assert.ok(nodes.every(n => isNodeOpen(n, {}, true)), 'every ancestor of a match is open while filtering');
  assert.ok(nodes.every(n => !isNodeOpen(n, {}, false)), 'closed by default');
  assert.deepEqual(plain(nodes.map(n => isNodeOpen(n, { Orders: true }, false))), [true, false, false]);
  assert.equal(isNodeOpen(nodes[0], null, false), false, 'missing stored state is closed');
});

test('a filter on a category level matches the reports below it', () => {
  const { reportMatches } = load();
  assert.deepEqual(reports.filter(x => reportMatches(x, 'delivery')).map(x => x.title).sort(), ['Delivery summary', 'Late deliveries', 'Weekly deliveries']);
});

test('ancestor keys reveal a selected report; categories without categoryPath are split on "/"', () => {
  const { ancestorKeys, categoryLevels } = load();
  assert.deepEqual(plain(ancestorKeys(['Orders', 'Delivery', 'Weekly'])), ['Orders', 'Orders/Delivery', 'Orders/Delivery/Weekly']);
  assert.deepEqual(plain(categoryLevels({ category: 'Orders/Delivery' })), ['Orders', 'Delivery']);
  assert.deepEqual(plain(categoryLevels({ category: 'Example Reports' })), ['Example Reports']);
  assert.deepEqual(plain(categoryLevels({ category: 'a/b', categoryPath: ['a', 'b'] })), ['a', 'b']);
});

test('the page keeps change scripts out of "All" and gives tree nodes aria-expanded', () => {
  assert.match(page, /const badge = stageTabCount\(all, 'all'\)/, 'the Reports tab badge counts what "All" shows');
  assert.match(page, /'aria-expanded': open \? 'true' : 'false'/);
  assert.match(page, /repTreeOpen: state\.repTreeOpen/, 'the open state is remembered');
});

test('"All" and the Reports badge leave change scripts out; each stage tab counts its own', () => {
  const { stageTabCount, inStageTab } = load();
  const items = [r('Orders', 'Draft one'), r('Orders', 'Approved one', { stage: 'approved' }), r('Orders/Fixes', 'Fix status', { stage: 'execute' })];
  assert.equal(stageTabCount(items, 'all'), 2);
  assert.equal(stageTabCount(items, 'draft'), 1);
  assert.equal(stageTabCount(items, 'approved'), 1);
  assert.equal(stageTabCount(items, 'execute'), 1);
  assert.equal(inStageTab(items[2], 'all'), false);
});

test('a change script selected while "All" is on switches to the change-script tab', () => {
  const { stageTabFor } = load();
  const script = r('Orders/Fixes', 'Fix status', { stage: 'execute' });
  assert.equal(stageTabFor(script, 'all'), 'execute');
  assert.equal(stageTabFor(r('Orders', 'Draft one'), 'all'), 'all', 'a report keeps "All"');
  assert.equal(stageTabFor(undefined, 'all'), 'all', 'no selection keeps the tab');
  assert.equal(stageTabFor(script, 'draft'), 'draft', 'another chosen tab is left alone');
});
