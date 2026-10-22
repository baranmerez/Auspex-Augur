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
  vm.runInContext(`${block}\nObject.assign(this, { buildAskPrompt, reportDataOf, presetLabel, lastRunInfo, paramText, offeredPresets, buildPresetPrompt, openedVersion });`, context);
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
    { key: 'last_month', label: 'Geçen ay', title: 'last_month', stale: false },
    { key: 'Q1', label: 'Q1', title: '2026-01-01, 2026-04-01', stale: false },
    { key: 'Old', label: 'Old', title: '1', stale: true },
  ]);
  assert.deepEqual(plain(offeredPresets(null, 'en')), []);
  assert.equal(offeredPresets({ custom: [{ name: 'A', params: [] }] }, 'en')[0].stale, false, 'older HTML without mismatched');
});

test('preset chip request: names the report path and the preset key run_report takes, in the UI language', () => {
  const { offeredPresets, buildPresetPrompt } = load();
  const r = { db: 'exampledb', schema: 'example', category: 'Orders/Delivery', name: 'late_orders', title: 'Late\norders' };
  const [builtIn, custom] = offeredPresets({ builtIn: ['last_month'], custom: [{ name: 'Q1', params: ['2026-01-01'] }] }, 'en');
  assert.equal(buildPresetPrompt(r, builtIn, 'en'),
    'Run the Auspex report "Late orders" (exampledb/example/Orders/Delivery/late_orders) with run_report and the preset "Last month" ("last_month"), then show me the summary and the HTML file path.');
  assert.match(buildPresetPrompt(r, custom, 'en'), /the preset "Q1", then/);
  const tr = buildPresetPrompt(r, offeredPresets({ builtIn: ['last_month'] }, 'tr')[0], 'tr');
  assert.match(tr, /"Geçen ay" \("last_month"\) hazır ayarıyla çalıştır/);
  assert.match(buildPresetPrompt(r, builtIn, 'de'), /^Run the Auspex report/, 'unknown language falls back to English');
});

test('preset chip request: the key is copied exactly and title or name text is never read as a placeholder or $ pattern', () => {
  const { offeredPresets, buildPresetPrompt } = load();
  const r = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'late', title: 'Orders {path} $&' };
  const [spaced, dollar] = offeredPresets({ custom: [{ name: 'Q1  2026', params: [1] }, { name: 'FY26 $& {title}', params: [1] }] }, 'en');
  const a = buildPresetPrompt(r, spaced, 'en'), b = buildPresetPrompt(r, dollar, 'en');
  assert.ok(a.startsWith('Run the Auspex report "Orders {path} $&" (exampledb/example/Orders/late) '), a);
  assert.ok(a.includes('the preset "Q1  2026", then'), 'two spaces kept');
  assert.ok(b.includes('the preset "FY26 $& {title}", then'), b);
  assert.equal(JSON.parse(a.match(/the preset (".*?"), then/)[1]), 'Q1  2026');
});

test('#138: the preset request names the stage of the opened copy, so an approved page never runs a newer draft', () => {
  const { offeredPresets, buildPresetPrompt } = load();
  const base = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'order-total', title: 'Order total' };
  const [preset] = offeredPresets({ custom: [{ name: 'Example', params: [100] }] }, 'en');
  assert.equal(buildPresetPrompt({ ...base, stage: 'approved', approvedVersion: 1 }, preset, 'en', 1),
    'Run the Auspex report "Order total" (exampledb/example/Orders/order-total) with run_report (stage: "approved", version: 1) and the preset "Example", then show me the summary and the HTML file path.');
  assert.match(buildPresetPrompt({ ...base, stage: 'draft' }, preset, 'en', 2), /with run_report \(stage: "draft", version: 2\) and the preset/);
  assert.match(buildPresetPrompt({ ...base, stage: 'draft', activeVersion: 5 }, preset, 'en'), /with run_report \(stage: "draft"\) and the preset/, 'no version unless the opened content gives one');
  assert.match(buildPresetPrompt({ ...base, stage: 'approved' }, preset, 'en', 0), /\(stage: "approved"\) and/, 'only versions from 1 up');
  assert.match(buildPresetPrompt({ ...base, stage: 'approved' }, preset, 'tr', 3), /run_report ile \(stage: "approved", version: 3\) "Example" hazır ayarıyla çalıştır/);
  assert.match(buildPresetPrompt({ ...base, stage: 'execute' }, preset, 'en'), /with run_report and the preset/, 'no stage for anything else');
  assert.match(buildPresetPrompt({ ...base, title: 'T {stage}', stage: 'approved' }, preset, 'en'), /"T \{stage\}"/, 'a title is never read as a placeholder');
});

test('#138: the version comes from the opened content (its SQL hash), not from the live list entry', () => {
  const { openedVersion, buildPresetPrompt, offeredPresets } = load();
  // The opened approved copy is version 1; a live refresh moved the list entry to version 2.
  const report = { approvedVersion: 1, sqlVersions: [{ version: 1, hash: 'aaaaaaaaaaaa' }, { version: 2, hash: 'bbbbbbbbbbbb' }] };
  assert.equal(openedVersion(report, 'aaaaaaaaaaaa'), 1);
  assert.equal(openedVersion(report, 'cccccccccccc'), null, 'an unknown hash gives no version');
  assert.equal(openedVersion({ approvedVersion: 4 }, 'aaaaaaaaaaaa'), null, 'never approvedVersion alone');
  assert.equal(openedVersion(report, null), null);
  const listEntry = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'order-total', title: 'Order total', stage: 'approved', approvedVersion: 2, activeHash: 'bbbbbbbbbbbb' };
  const [preset] = offeredPresets({ custom: [{ name: 'Example', params: [100] }] }, 'en');
  assert.match(buildPresetPrompt(listEntry, preset, 'en', openedVersion(report, 'aaaaaaaaaaaa')), /\(stage: "approved", version: 1\)/);
  // The chips always take the version from the opened content, also when the list moved on,
  // so the server refuses a changed copy instead of running SQL the page does not show.
  assert.match(page, /const version = doc \? openedVersion\(data\?\.report, doc\.sqlHash\) : null;/);
  assert.doesNotMatch(page, /const version = doc && stageBlocked/, 'a moved-on list must not drop the version');
  assert.match(page, /onclick: \(\) => copyPresetPrompt\(r, o, version\)/);
  assert.match(page, /presetMeta\(data, r, doc\)/);
});
