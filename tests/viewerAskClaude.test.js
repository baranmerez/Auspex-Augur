import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the ask-claude block of src/viewer.html (the prompt the "Ask Claude"
// button copies, and preset labels) in isolation.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ ask-claude:start[\s\S]*?\/\/ ask-claude:end/)?.[0];

function load() {
  assert.ok(block, 'ask-claude block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nObject.assign(this, { buildAskPrompt, reportDataOf, presetLabel, lastRunInfo, paramText, offeredPresets });`, context);
  return context;
}

const r = { db: 'exampledb', schema: 'example', category: 'Orders/Delivery', name: 'late-orders', stage: 'draft', title: 'Late\norders' };
const secret = 'Example Customer Private Name';
const data = {
  report: {
    runs: [{ at: '2026-10-01T08:00:00.000Z', rows: 12, preset: 'last_month', params: ['2026-09-01', '2026-10-01'] }],
    last: {
      columns: ['order_id', 'customer_id', 'status_code', 'created_at', 'delivered_at', 'amount', 'customer_name', 'note'].map(name => ({ name, type: 'text' })),
      preview: [[1, 2, 'X', '2026-09-02', null, 10, secret, secret]],
    },
  },
};

test('the prompt holds the location, title, last run, preset, params, rows and first columns, never row values', () => {
  const { buildAskPrompt } = load();
  const text = buildAskPrompt(r, data, 'en');
  assert.match(text, /Report: exampledb\/example\/Orders\/Delivery\/late-orders/);
  assert.match(text, /Title: Late orders/);
  assert.match(text, /Last run: 2026-10-01T08:00:00.000Z/);
  assert.match(text, /Preset: Last month \(last_month\)/);
  assert.match(text, /Parameters: 2026-09-01, 2026-10-01/);
  assert.match(text, /Rows: 12/);
  assert.match(text, /First columns: order_id, customer_id, status_code, created_at, delivered_at, amount \(\+2 more\)/);
  assert.ok(!text.includes(secret), 'no preview values');
  assert.ok(!text.includes('customer_name'), 'only the first columns');
});

test('the prompt follows the UI language and handles reports that never ran', () => {
  const { buildAskPrompt } = load();
  const tr = buildAskPrompt(r, data, 'tr');
  assert.match(tr, /Bu Auspex raporu/);
  assert.match(tr, /Hazır ayar: Geçen ay \(last_month\)/);
  assert.match(tr, /İlk kolonlar: .* \(\+2 kolon daha\)/);
  const never = buildAskPrompt(r, { report: { runs: [] } }, 'en');
  assert.match(never, /Last run: not run yet/);
  assert.ok(!/Parameters:/.test(never));
  const custom = buildAskPrompt(r, { report: { runs: [{ at: 'x', rows: 1, preset: 'April 2023 trial', params: ['2023-04-01', null, 5, true] }] } }, 'en');
  assert.match(custom, /Preset: April 2023 trial \(April 2023 trial\)/);
  assert.match(custom, /Parameters: 2023-04-01, null, 5, true/);
  assert.match(buildAskPrompt(r, { report: { runs: [{ at: 'x', params: null }] } }, 'en'), /Parameters: none/);
});

test('embedded report data is read from the auspex-report script; anything else gives null', () => {
  const { reportDataOf, presetLabel } = load();
  const html = `<html><script id="auspex-report" type="application/json">${JSON.stringify({ report: { name: 'x' }, presets: { builtIn: [] } })}</script></html>`;
  assert.equal(reportDataOf(html).report.name, 'x');
  assert.equal(reportDataOf('<html></html>'), null);
  assert.equal(reportDataOf('<script id="auspex-report" type="application/json">{bad</script>'), null);
  assert.equal(presetLabel('this_year', 'tr'), 'Bu yıl');
  assert.equal(presetLabel('this_year', 'de'), 'This year');
  assert.equal(presetLabel('Custom name', 'en'), 'Custom name');
});

test('preset chips: built-in labels, custom values, and custom presets that no longer fit the SQL marked stale', () => {
  const { offeredPresets } = load();
  const plain = x => JSON.parse(JSON.stringify(x));
  const chips = offeredPresets({ builtIn: ['last_month'], custom: [{ name: 'Q1', params: ['2026-01-01', '2026-04-01'] }, { name: 'Old', params: [1] }], mismatched: ['Old'] }, 'tr');
  assert.deepEqual(plain(chips), [
    { label: 'Geçen ay', title: 'last_month', stale: false },
    { label: 'Q1', title: '2026-01-01, 2026-04-01', stale: false },
    { label: 'Old', title: '1', stale: true },
  ]);
  assert.deepEqual(plain(offeredPresets(null, 'en')), []);
  assert.equal(offeredPresets({ custom: [{ name: 'A', params: [] }] }, 'en')[0].stale, false, 'older HTML without mismatched');
});
