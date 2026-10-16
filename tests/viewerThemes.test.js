import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the themes block of src/viewer.html (theme generator, ready themes and
// the custom theme store) in isolation.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ themes:start[\s\S]*?\/\/ themes:end/)?.[0];

function load() {
  assert.ok(block, 'themes block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nObject.assign(this, { themeTokens, themePresets, themeRecord, themeUpsert, themeExport, themeImport, themeSpecOf, themeBgFrom, contrastRatio, hexRgb, themeIdOf });`, context);
  return context;
}
const plain = v => JSON.parse(JSON.stringify(v));
// Text tokens and the surfaces they sit on.
const textTokens = ['--text', '--text-2', '--text-3', '--accent-ink', '--good-ink', '--warn-ink', '--critical', '--role-ref-1', '--role-dep-1'];
const surfaces = ['--bg', '--surface', '--surface-2'];

test('every ready and sample theme reaches 4.5:1 for text on every surface', () => {
  const { themeTokens, themePresets, contrastRatio, hexRgb } = load();
  const samples = [...themePresets, { bg: '#9a9a9a', accent: '#888888' }, { bg: '#ffffff', accent: '#ffff00' }, { bg: '#000000', accent: '#000080' }, { bg: '#3a3a10', accent: '#40ff40' }];
  for (const spec of samples) {
    const r = themeTokens(spec);
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 0, `${spec.bg}/${spec.accent}: ${JSON.stringify(plain(r.warnings))}`);
    for (const tk of textTokens) for (const sf of surfaces) {
      const ratio = contrastRatio(hexRgb(r.tokens[tk]), hexRgb(r.tokens[sf]));
      assert.ok(ratio >= 4.5, `${spec.bg}/${spec.accent} ${tk} on ${sf}: ${ratio.toFixed(2)}`);
    }
    assert.ok(contrastRatio(hexRgb(r.tokens['--accent-ink']), hexRgb(r.tokens['--accent-soft'])) >= 4.5);
    assert.ok(contrastRatio(hexRgb(r.tokens['--accent']), hexRgb(r.tokens['--surface'])) >= 3);
  }
});

test('high contrast asks 7:1 and reports what it cannot reach', () => {
  const { themeTokens, contrastRatio, hexRgb } = load();
  const r = themeTokens({ bg: '#000000', accent: '#ffd400', contrast: 'high' });
  for (const tk of ['--text', '--text-2', '--text-3', '--accent-ink']) assert.ok(contrastRatio(hexRgb(r.tokens[tk]), hexRgb(r.tokens['--surface'])) >= 7, tk);
  // Mid grey: neither black nor white text reaches 4.5:1 on every surface.
  const mid = themeTokens({ bg: '#777777', accent: '#888888' });
  assert.ok(mid.warnings.some(w => w.token === '--text' && w.min === 4.5 && !w.ok));
  // Mid grey: even black or white text stays below 7:1.
  const grey = themeTokens({ bg: '#767676', accent: '#2a78d6', contrast: 'high' });
  assert.equal(grey.ok, true);
  assert.ok(grey.warnings.length > 0);
  assert.ok(grey.warnings.every(w => w.min === 7 && w.ratio < 7 && !w.ok));
});

test('output is deterministic and picks the base from the background', () => {
  const { themeTokens } = load();
  const a = plain(themeTokens({ bg: '#0e1a2f', accent: '#4c8dff' }));
  const b = plain(themeTokens({ bg: '#0E1A2F', accent: '#4c8dff' }));
  assert.deepEqual(a, b);
  assert.equal(a.base, 'dark');
  assert.equal(themeTokens({ bg: '#f2e8d5', accent: '#9a5b1e' }).base, 'light');
  assert.equal(themeTokens({ bg: '#fff', accent: '#00f' }).tokens['--bg'], '#ffffff');
  for (const v of Object.values(a.tokens)) assert.match(v, /^#[0-9a-f]{6}$|^0 1/);
});

test('invalid input is refused, never thrown', () => {
  const { themeTokens } = load();
  for (const spec of [null, undefined, {}, { bg: 'red', accent: '#000' }, { bg: '#12345', accent: '#000' }, { bg: '#000', accent: 'url(x)' }, { bg: '#000;color:red', accent: '#fff' }]) {
    const r = themeTokens(spec);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid color');
  }
});

test('ready themes: light and dark are built in, six in all', () => {
  const { themePresets, themeSpecOf } = load();
  assert.equal(themePresets.length, 6);
  assert.equal(themeSpecOf('light', []), null);
  assert.equal(themeSpecOf('auto', []), null);
  assert.equal(themeSpecOf('midnight', []).bg, '#0e1a2f');
  assert.equal(themeSpecOf('custom:none', []), null);
});

test('custom themes: validated records, one per name, export and import round trip', () => {
  const { themeRecord, themeUpsert, themeExport, themeImport, themeSpecOf, themeIdOf } = load();
  assert.equal(themeRecord({ name: '  ', bg: '#000', accent: '#fff' }), null);
  assert.equal(themeRecord({ name: 'Mother', bg: 'nope', accent: '#fff' }), null);
  const rec = plain(themeRecord({ name: ' Nostromo night ', bg: '#000', accent: '#FFF', contrast: 'high', extra: 'dropped' }));
  assert.deepEqual(rec, { id: themeIdOf('Nostromo night'), name: 'Nostromo night', bg: '#000000', accent: '#ffffff', contrast: 'high' });
  let list = themeUpsert([], rec);
  list = themeUpsert(list, { name: 'NOSTROMO NIGHT', bg: '#111111', accent: '#ffffff' });
  assert.equal(list.length, 1);
  assert.equal(list[0].bg, '#111111');
  assert.equal(themeSpecOf(list[0].id, list).name, 'NOSTROMO NIGHT');
  list = themeUpsert(list, { name: 'Sulaco day', bg: '#fafafa', accent: '#2a78d6' });
  const text = themeExport(list);
  const back = themeImport(text, []);
  assert.equal(back.added, 2);
  assert.equal(back.skipped, 0);
  assert.deepEqual(plain(back.list), plain(list));
  const mixed = themeImport(JSON.stringify([{ name: 'Mother', bg: '#123', accent: '#abc' }, { name: 'bad', bg: 'x' }, 7]), list);
  assert.deepEqual([mixed.added, mixed.skipped, mixed.list.length], [1, 2, 3]);
  assert.equal(themeImport('{not json', list).error, 'not valid JSON');
  assert.equal(themeImport(JSON.stringify({ name: 'Single', bg: '#000', accent: '#fff' }), []).added, 1);
});

test('the light/dark slider gives a tinted background', () => {
  const { themeBgFrom, themeTokens } = load();
  assert.equal(themeBgFrom(0, '#000000'), '#000000');
  assert.equal(themeBgFrom(100, '#ffffff'), '#ffffff');
  assert.equal(themeTokens({ bg: themeBgFrom(10, '#2a78d6'), accent: '#2a78d6' }).base, 'dark');
  assert.equal(themeTokens({ bg: themeBgFrom(95, '#2a78d6'), accent: '#2a78d6' }).base, 'light');
  assert.equal(themeBgFrom('x', 'nope'), '#080808');
});
