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
  vm.runInContext(`${block}\nObject.assign(this, { themeTokens, themePresets, themeRecord, themeUpsert, themeExport, themeImport, themeSpecOf, themeBgFrom, contrastRatio, hexRgb, themeIdOf, summaryDefaults, summaryPaletteRecord, summaryGroups, summaryKeys, summaryMinStep, glassRecord, tintsRecord, glassFallback, glassDefaults, themeDuplicate, themeMaterialize, themeAutoFix, themeContrast, themeResolve, themeDefaultId, themeColorKeys, themeColorGroups, themeBodyRecord, bgIsDark, themeMaxCount, themeDialogRecover, themePresetGroup });`, context);
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
    // Selected rows and active buttons: body, secondary and muted text on the accent tint.
    for (const tk of ['--text', '--text-2', '--text-3']) {
      const ratio = contrastRatio(hexRgb(r.tokens[tk]), hexRgb(r.tokens['--accent-soft']));
      assert.ok(ratio >= 4.5, `${spec.bg}/${spec.accent} ${tk} on --accent-soft: ${ratio.toFixed(2)}`);
    }
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

test('ready themes: light, dark and plain are built in, thirty-two in all with the five Auspex themes and twelve glass themes', () => {
  const { themePresets, themeSpecOf } = load();
  assert.equal(themePresets.length, 32);
  assert.deepEqual(plain(themePresets.filter(p => p.auspex).map(p => p.id)), ['auspex', 'forge', 'phosphor', 'verdigris', 'ivory']);
  assert.equal(themeSpecOf('plain', []), null);
  assert.deepEqual(plain(themePresets.filter(p => p.glass).map(p => p.id)), ['glass', 'glassDark', 'glassAurora', 'glassAbyss', 'glassDusk', 'glassEmber', 'glassPomegranate', 'glassSynthwave', 'glassNebula', 'glassEmerald', 'glassPearl', 'glassLagoon']);
  assert.equal(themeSpecOf('light', []), null);
  assert.equal(themeSpecOf('auto', []), null);
  assert.equal(themeSpecOf('midnight', []).bg, '#0e1a2f');
  assert.equal(themeSpecOf('custom:none', []), null);
});

test('custom themes: validated records, one per name, export and import round trip', () => {
  const { themeRecord, themeUpsert, themeExport, themeImport, themeSpecOf, themeIdOf } = load();
  assert.equal(themeRecord({ name: '  ', bg: '#000', accent: '#fff' }), null);
  assert.equal(themeRecord({ name: 'Example', bg: 'nope', accent: '#fff' }), null);
  const rec = plain(themeRecord({ name: ' Example night ', bg: '#000', accent: '#FFF', contrast: 'high', extra: 'dropped' }));
  assert.deepEqual(rec, { id: themeIdOf('Example night'), name: 'Example night', bg: '#000000', accent: '#ffffff', contrast: 'high' });
  let list = themeUpsert([], rec);
  list = themeUpsert(list, { name: 'EXAMPLE NIGHT', bg: '#111111', accent: '#ffffff' });
  assert.equal(list.length, 1);
  assert.equal(list[0].bg, '#111111');
  assert.equal(themeSpecOf(list[0].id, list).name, 'EXAMPLE NIGHT');
  list = themeUpsert(list, { name: 'Test day', bg: '#fafafa', accent: '#2a78d6' });
  const text = themeExport(list);
  const back = themeImport(text, []);
  assert.equal(back.added, 2);
  assert.equal(back.skipped, 0);
  assert.deepEqual(plain(back.list), plain(list));
  const mixed = themeImport(JSON.stringify([{ name: 'Example', bg: '#123', accent: '#abc' }, { name: 'bad', bg: 'x' }, 7]), list);
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

// Summary palette (table page, Summary view).
const sumKeys = ['pk', 'fk', 's5', 's4', 's3', 's2', 's1', 'trigger', 'fn', 'report', 'ref', 'dep', 'off'];

test('summary palette: every theme gives background, line and text for each group, text meets the contrast target', () => {
  const { themeTokens, themePresets, contrastRatio, hexRgb } = load();
  const samples = [...themePresets, { bg: '#9a9a9a', accent: '#888888' }, { bg: '#ffffff', accent: '#ffff00' }, { bg: '#3a3a10', accent: '#40ff40' },
    { bg: '#000000', accent: '#ffd400', contrast: 'high', palette: { pk: '#ffff00', score: '#ffff00', off: '#ffffff' } }];
  for (const spec of samples) {
    const r = themeTokens(spec);
    assert.equal(r.warnings.length, 0, `${spec.bg}: ${JSON.stringify(plain(r.warnings))}`);
    assert.deepEqual(Object.keys(r.summary).sort(), sumKeys.flatMap(k => [`--sum-${k}`, `--sum-${k}-line`, `--sum-${k}-ink`]).sort());
    const min = spec.contrast === 'high' ? 7 : 4.5;
    for (const k of sumKeys) {
      assert.match(r.summary[`--sum-${k}`], /^#[0-9a-f]{6}$/);
      const ratio = contrastRatio(hexRgb(r.summary[`--sum-${k}-ink`]), hexRgb(r.summary[`--sum-${k}`]));
      assert.ok(ratio >= min, `${spec.bg} ${k}: ${ratio.toFixed(2)}`);
      assert.ok(r.checks.some(c => c.token === `--sum-${k}-ink`), 'checked with the existing contrast check');
    }
    // Summary tokens stay out of the tokens that embedded reports receive.
    assert.ok(Object.keys(r.tokens).every(k => !k.startsWith('--sum-')));
  }
});

test('summary palette: the score ramp gets stronger from 1 to 5 and a changed color changes the chips', () => {
  const { themeTokens, contrastRatio, hexRgb } = load();
  const base = { bg: '#f4f5f7', accent: '#2a78d6' };
  const r = themeTokens(base);
  const away = k => contrastRatio(hexRgb(r.summary[`--sum-${k}`]), hexRgb(r.tokens['--surface']));
  assert.ok(['s1', 's2', 's3', 's4', 's5'].every((k, i, a) => i === 0 || away(k) >= away(a[i - 1])), 'ramp');
  const own = themeTokens({ ...base, palette: { fk: '#ff0000' } });
  assert.notEqual(own.summary['--sum-fk'], r.summary['--sum-fk']);
  assert.equal(own.summary['--sum-pk'], r.summary['--sum-pk'], 'other groups keep their defaults');
  // The score base follows the accent until the palette sets it.
  assert.notEqual(themeTokens({ ...base, accent: '#cc3366' }).summary['--sum-s4'], r.summary['--sum-s4']);
  assert.equal(themeTokens({ ...base, accent: '#cc3366', palette: { score: '#2a78d6' } }).summary['--sum-s4'], r.summary['--sum-s4']);
});

test('summary palette: records keep only known groups with valid colors', () => {
  const { summaryPaletteRecord, themeRecord, summaryGroups } = load();
  assert.deepEqual(plain(summaryPaletteRecord({ pk: '#ABC', fk: 'red', nope: '#000', __proto__: { off: '#111111' }, off: 'x' })), { pk: '#aabbcc' });
  assert.deepEqual(plain(summaryPaletteRecord(null)), {});
  assert.equal(summaryGroups.length, 9);
  const rec = themeRecord({ name: 'Example', bg: '#000', accent: '#fff', palette: { pk: '#123456' } });
  assert.deepEqual(plain(rec.palette), { pk: '#123456' });
  assert.ok(!('palette' in themeRecord({ name: 'Example', bg: '#000', accent: '#fff', palette: { pk: 'nope' } })), 'an empty palette is not stored');
});

test('summary palette: saved with custom themes, exported, imported, defaults for the rest', () => {
  const { themeUpsert, themeExport, themeImport, themeSpecOf, themeTokens, themePresets, summaryDefaults } = load();
  let list = themeUpsert([], { name: 'Example night', bg: '#101820', accent: '#4c8dff', palette: { trigger: '#ff8800', report: '#00cc99' } });
  list = themeUpsert(list, { name: 'Test day', bg: '#fafafa', accent: '#2a78d6' });
  const text = themeExport(list);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.themes[0].palette, { trigger: '#ff8800', report: '#00cc99' });
  assert.ok(!('palette' in parsed.themes[1]), 'a theme without a palette exports none');
  const back = themeImport(text, []);
  assert.deepEqual([back.added, back.skipped], [2, 0]);
  assert.deepEqual(plain(back.list), plain(list), 'round trip');
  const night = themeSpecOf(back.list[0].id, back.list);
  const r = themeTokens(night);
  const defaults = themeTokens({ bg: night.bg, accent: night.accent });
  assert.notEqual(r.summary['--sum-trigger'], defaults.summary['--sum-trigger']);
  assert.equal(r.summary['--sum-pk'], defaults.summary['--sum-pk'], 'missing groups use the defaults');
  // Invalid palette entries in an import are dropped, the theme is still imported.
  const odd = themeImport(JSON.stringify({ name: 'Odd', bg: '#000', accent: '#fff', palette: { pk: 'nope', fk: '#00f', x: 1 } }), []);
  assert.deepEqual(plain(odd.list[0].palette), { fk: '#0000ff' });
  // Every ready theme has a full palette from the defaults.
  for (const p of themePresets) assert.equal(Object.keys(themeTokens(p).summary).length, sumKeys.length * 3, p.id);
  assert.equal(summaryDefaults('#2a78d6').score, '#2a78d6');
});

test('summary palette: the generator has its section, a reset and a preview; chips use CSS variables only', () => {
  assert.match(page, /t\('Summary palette'\)/);
  assert.match(page, /t\('Reset to derived'\)/);
  assert.match(page, /'Summary palette': 'Özet paleti'/);
  const css = page.match(/\.sum-chip\.c-pk[\s\S]*?\.sum-chip\.off \{[^}]*\}/)[0];
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}/, 'no literal colors in the chip styles');
  // Built-in light, dark and auto set the summary variables too.
  assert.match(page, /function summaryBuiltIn\(th\)/);
  assert.match(page, /light-dark\(\$\{light\[k\]\}, \$\{dark\[k\]\}\)/);
});

test('summary palette: score steps are clearly apart in light and dark, for defaults and custom base colors', () => {
  const { themeTokens, themePresets, contrastRatio, hexRgb, summaryMinStep } = load();
  const samples = [...themePresets, { bg: '#ffffff', accent: '#2a78d6' }, { bg: '#121211', accent: '#3987e5' }, { bg: '#0e1a2f', accent: '#1f3a8a', palette: { score: '#223366' } },
    { bg: '#f4f5f7', accent: '#2a78d6', palette: { score: '#e0b000' } }, { bg: '#1b1b1b', accent: '#2a78d6', palette: { score: '#bb2244' } }];
  for (const spec of samples) {
    const r = themeTokens(spec);
    const steps = ['s1', 's2', 's3', 's4', 's5'].map(k => hexRgb(r.summary[`--sum-${k}`]));
    for (let i = 1; i < steps.length; i++) {
      const ratio = contrastRatio(steps[i], steps[i - 1]);
      assert.ok(ratio >= summaryMinStep - 0.01, `${spec.bg}/${spec.palette?.score ?? spec.accent} s${i}->s${i + 1}: ${ratio.toFixed(2)}`);
    }
    assert.ok(contrastRatio(steps[4], steps[0]) >= 2.4, `${spec.bg}: s5 against s1`);
    assert.equal(r.warnings.length, 0);
  }
  assert.ok(summaryMinStep >= 1.4);
});

// Glass and Plain presets, region tints, glass strength.
test('glass presets: light and dark variants load and pass the contrast check on the glass panel', () => {
  const { themeTokens, themePresets, contrastRatio, hexRgb } = load();
  const variants = themePresets.filter(p => p.glass);
  assert.deepEqual(plain(variants.slice(0, 2).map(v => themeTokens(v).base)), ['light', 'dark']);
  for (const spec of variants) {
    const r = themeTokens(spec);
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 0, JSON.stringify(plain(r.warnings)));
    assert.deepEqual(plain(Object.keys(r.glass).sort()), ['--glass-bg', '--glass-blur', '--glass-hi', '--glass-line', '--glass-sat', '--page-bg']);
    assert.match(r.glass['--glass-blur'], /^\d+px$/);
    // Glass tokens stay out of the tokens that embedded reports receive.
    assert.ok(Object.keys(r.tokens).every(k => !k.startsWith('--glass') && k !== '--page-bg'));
    for (const tk of ['--text', '--text-2', '--text-3', '--accent-ink', '--role-ref-1', '--role-dep-1']) {
      assert.ok(contrastRatio(hexRgb(r.tokens[tk]), hexRgb(r.tokens['--surface'])) >= 4.5, spec.id + ' ' + tk);
    }
  }
  // Worst case: the panel at its lowest opacity over strong backdrop colors.
  const low = themeTokens({ bg: '#e8ecf7', accent: '#ff00aa', glass: { opacity: 20 } });
  assert.ok(low.checks.some(c => c.token === '--text' && c.ok));
  assert.equal(themeTokens({ bg: '#e8ecf7', accent: '#4f5fe0' }).glass, null);
});

test('built-in light and dark: text on the tinted side panels reaches 4.5:1', () => {
  const { contrastRatio, hexRgb } = load();
  const css = page.match(/<style>[\s\S]*?<\/style>/)[0];
  const pick = (block, name) => block.match(new RegExp(name + ': (#[0-9a-f]{6})', 'i'))[1];
  const lightRoot = css.match(/:root \{[\s\S]*?\n  \}/)[0], darkRoot = css.match(/:root\[data-theme="dark"\] \{[\s\S]*?\n  \}/)[0];
  const pair = (name, i) => css.match(new RegExp(name + ': light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\)'))[i + 1];
  const mix = (a, b, w) => a.map((x, i) => x + (b[i] - x) * w);
  assert.ok(css.includes('.tp-side { --text-3: var(--text-2); }') || css.includes('--text-3: var(--text-2);'));
  [[lightRoot, 0], [darkRoot, 1]].forEach(([block, i]) => {
    const surface = hexRgb(pick(block, '--surface'));
    for (const pct of [0.07, 0.12]) for (const role of ['--role-ref-1', '--role-dep-1']) {
      const hue = hexRgb(pair(role, i)), tint = mix(surface, hue, pct);
      // Hints take --text-2 inside the tinted panels; --text and the role heading colors sit there too.
      for (const fg of [pick(block, '--text'), pick(block, '--text-2'), pair(role, i)]) {
        assert.ok(contrastRatio(hexRgb(fg), tint) >= 4.5, `${i ? 'dark' : 'light'} ${role} ${pct} ${fg}`);
      }
    }
  });
});

test('plain is a built-in choice, flat and uncoloured, with a two-mode swatch', () => {
  assert.match(page, /:root\.plain \.tp-side \{[^}]*border-top: 1px solid var\(--line\)/);
  assert.ok(page.includes("root.classList.toggle('plain', th === 'plain' && !studio)"));
  assert.ok(page.includes("t('Plain') : custom && spec"));
  assert.ok(page.includes("if (spec.id === 'plain')"));
  assert.ok(page.includes('body::before { content: ""; position: fixed; inset: 0; z-index: -1; background: var(--page-bg)'));
  assert.ok(!page.includes('background-attachment: fixed'));
});

test('plain is a built-in choice and has no glass', () => {
  const { themePresets, themeTokens } = load();
  const plainSpec = themePresets.find(p => p.id === 'plain');
  assert.equal(plainSpec.builtin, true);
  assert.equal(themeTokens(plainSpec).glass, null);
});

test('glass strength: numbers clamped, junk replaced by defaults', () => {
  const { glassRecord, glassDefaults } = load();
  assert.equal(glassRecord(null), null);
  assert.equal(glassRecord('x'), null);
  assert.deepEqual(plain(glassRecord({ blur: 500, opacity: -4 })), { blur: 40, opacity: 20, strength: 50 });
  assert.deepEqual(plain(glassRecord({ blur: -1, opacity: 999, strength: 400 })), { blur: 0, opacity: 95, strength: 100 });
  assert.deepEqual(plain(glassRecord({ blur: 'abc', opacity: '30.4' })), { blur: glassDefaults.blur, opacity: 30, strength: 50 });
  assert.deepEqual(plain(glassRecord({ blur: null, opacity: true })), plain(glassDefaults));
  assert.deepEqual(plain(glassRecord({})), plain(glassDefaults));
  assert.deepEqual(plain(glassRecord({ blur: 8, opacity: 50, extra: 1 })), { blur: 8, opacity: 50, strength: 50 });
});

test('region tints: hex only, known keys only', () => {
  const { tintsRecord } = load();
  assert.deepEqual(plain(tintsRecord({ ref: '#ABC', dep: 'url(x)', other: '#000000' })), { ref: '#aabbcc' });
  assert.deepEqual(plain(tintsRecord({ dep: '#112233; color: red' })), {});
  assert.deepEqual(plain(tintsRecord(null)), {});
  assert.deepEqual(plain(tintsRecord(JSON.parse('{"__proto__": "#fff"}'))), {});
});

test('custom themes: glass strength and tints round trip through export and import with validation', () => {
  const { themeRecord, themeUpsert, themeExport, themeImport } = load();
  const rec = plain(themeRecord({ name: 'Example glass', bg: '#e8ecf7', accent: '#4f5fe0', glass: { blur: 99, opacity: 10 }, tints: { ref: '#112233', dep: 'red' } }));
  assert.deepEqual(rec.glass, { blur: 40, opacity: 20, strength: 50 });
  assert.deepEqual(rec.tints, { ref: '#112233' });
  assert.equal('glass' in plain(themeRecord({ name: 'Flat', bg: '#fff', accent: '#00f' })), false);
  const list = themeUpsert(themeUpsert([], rec), { name: 'Test flat', bg: '#fafafa', accent: '#2a78d6' });
  const back = themeImport(themeExport(list), []);
  assert.deepEqual(plain(back.list), plain(list));
  const hostile = themeImport(JSON.stringify({ themes: [{ name: 'Bad', bg: '#000', accent: '#fff', glass: { blur: '1e9', opacity: null }, tints: { ref: '#zzz' } }] }), []);
  assert.deepEqual(plain(hostile.list[0].glass), { blur: 40, opacity: 68, strength: 50 });
  assert.equal('tints' in hostile.list[0], false);
});

test('tints change the side panel colors and stay readable', () => {
  const { themeTokens, contrastRatio, hexRgb } = load();
  const a = themeTokens({ bg: '#f4f5f7', accent: '#2a78d6' }), b = themeTokens({ bg: '#f4f5f7', accent: '#2a78d6', tints: { ref: '#00aa00', dep: '#aa00aa' } });
  assert.notEqual(a.tokens['--tint-ref-hue'], b.tokens['--tint-ref-hue']);
  assert.equal(b.tokens['--tint-ref-hue'], '#00aa00');
  assert.equal(b.warnings.length, 0);
  assert.ok(contrastRatio(hexRgb(b.tokens['--role-ref-1']), hexRgb(b.tokens['--surface'])) >= 4.5);
});

test('fallback to opaque panels when reduced transparency is requested or backdrop-filter is missing', () => {
  const { glassFallback } = load();
  const cssYes = { supports: () => true }, cssNo = { supports: () => false };
  const mm = reduce => q => ({ matches: reduce && q.includes('prefers-reduced-transparency') });
  assert.equal(glassFallback({ matchMedia: mm(false), CSS: cssYes }), false);
  assert.equal(glassFallback({ matchMedia: mm(true), CSS: cssYes }), true);
  assert.equal(glassFallback({ matchMedia: mm(false), CSS: cssNo }), true);
  assert.equal(glassFallback({ matchMedia: () => { throw new Error('unsupported'); }, CSS: cssYes }), false);
  assert.equal(glassFallback({}), true);
  assert.equal(glassFallback(undefined), true);
});

test('page: glass classes, fallback hook, region tints and generator controls exist', () => {
  assert.ok(page.includes("root.classList.toggle('glass-flat', !!gl && glassFallback(window))"));
  assert.ok(page.includes('prefers-reduced-transparency: reduce'));
  assert.match(page, /:root\.glass:not\(\.glass-flat\) \.panel \{[^}]*backdrop-filter: blur\(var\(--glass-blur\)\)/);
  assert.ok(page.includes('.tp-refs { --tint-hue: var(--tint-ref-hue, var(--role-ref-1)); }'));
  assert.match(page, /'Glass': 'Cam'[\s\S]*'Plain': 'Sade'/);
  assert.ok(page.includes("t('Blur'), glassLimits.blur[0]"));
  assert.ok(page.includes("t('Strength'), glassLimits.strength[0]"));
  assert.ok(page.includes("themeBuiltinIds = ['auto', 'light', 'dark', 'plain']"));
});

// Themes overhaul: Auspex presets, studio (generator), save/load, import validation, default theme.
const auspexPalettes = {
  auspex: { bg: '#14110e', surface: '#1f1a15', text: '#ede6da', muted: '#aca190', accent: '#2fbf71', accent2: '#c9a04f', warning: '#e0a33a', danger: '#e05a4a' },
  forge: { bg: '#17110d', surface: '#22180f', text: '#f1e4d6', muted: '#b09a86', accent: '#d7783a', accent2: '#b8894a', success: '#7fbf6a', danger: '#d9534a' },
  phosphor: { bg: '#060b07', surface: '#0b150e', text: '#b8f5c8', muted: '#7cae8a', accent: '#3ddc84', accent2: '#8fcb9b', warning: '#e8c547', danger: '#ff6b57' },
  verdigris: { bg: '#0e1716', surface: '#152221', text: '#e3efec', muted: '#93aba6', accent: '#3bb3a0', accent2: '#c2a15a', warning: '#e0a33a', danger: '#e06a5a' },
  ivory: { bg: '#f4eee2', surface: '#fffbf3', text: '#2a231b', muted: '#6e6252', accent: '#1e8a55', accent2: '#9a7330', warning: '#b7791f', danger: '#b83a2e' },
};

test('auspex presets: exact base palettes, dark except Ivory, every text and background pair passes', () => {
  const { themePresets, themeTokens, themeContrast, bgIsDark } = load();
  for (const [id, pal] of Object.entries(auspexPalettes)) {
    const spec = themePresets.find(p => p.id === id);
    assert.ok(spec && spec.auspex, id);
    assert.equal(spec.bg, pal.bg);
    assert.equal(spec.accent, pal.accent);
    for (const [k, v] of Object.entries(pal)) if (!['bg', 'accent'].includes(k)) assert.equal(spec.colors[k], v, `${id} ${k}`);
    assert.equal(bgIsDark(spec.bg), id !== 'ivory');
    const r = themeTokens(spec);
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.warnings), [], id);
    assert.equal(r.tokens['--bg'], pal.bg);
    assert.equal(r.tokens['--surface'], pal.surface);
    assert.equal(r.tokens['--text'], pal.text);
    assert.equal(r.tokens['--text-3'], pal.muted);
    const pairs = themeContrast(spec);
    assert.ok(pairs.length >= 12);
    for (const p of pairs) assert.ok(p.pass, `${id} ${p.id}: ${p.ratio}`);
  }
  assert.equal(themePresets.find(p => p.id === 'phosphor').mono, true);
});

test('every preset passes the contrast check, including pairs of the studio panel', () => {
  const { themePresets, themeContrast, themeTokens } = load();
  for (const spec of themePresets) {
    assert.equal(themeTokens(spec).warnings.length, 0, spec.id);
    for (const p of themeContrast(spec)) assert.ok(p.pass, `${spec.id} ${p.id}: ${p.ratio}:1 < ${p.min}`);
  }
});

test('light and dark presets: one light and one dark variant, both pass every contrast check', () => {
  const { themePresets, themeContrast, themeTokens, themeResolve, bgIsDark } = load();
  const pairs = themePresets.filter(p => p.pair);
  assert.deepEqual(plain(pairs.map(p => p.id)), ['contrast', 'fjord', 'nocturne', 'rosewood', 'ocean', 'amber', 'slate', 'moss', 'sunset']);
  for (const spec of pairs) {
    assert.notEqual(bgIsDark(spec.bg), bgIsDark(spec.pair.bg), spec.id);
    for (const dark of [true, false]) {
      const body = themeResolve(spec, dark);
      assert.equal(themeTokens(body).base, dark ? 'dark' : 'light', spec.id);
      assert.equal(themeTokens(body).warnings.length, 0, `${spec.id} ${dark ? 'dark' : 'light'}`);
      for (const p of themeContrast(body)) assert.ok(p.pass, `${spec.id} ${dark ? 'dark' : 'light'} ${p.id}: ${p.ratio}:1 < ${p.min}`);
    }
  }
  // High contrast keeps 7:1 in both variants.
  const hc = themePresets.find(p => p.id === 'contrast');
  assert.equal(hc.pair.contrast, 'high');
});

test('theme menu groups: Auspex, light and dark, ready and accessibility', () => {
  const { themePresets, themePresetGroup } = load();
  const of = g => plain(themePresets.filter(p => themePresetGroup(p) === g).map(p => p.id));
  assert.deepEqual(of('auspex'), ['auspex', 'forge', 'phosphor', 'verdigris', 'ivory']);
  assert.deepEqual(of('access'), ['contrast']);
  assert.deepEqual(of('pair'), ['fjord', 'nocturne', 'rosewood', 'ocean', 'amber', 'slate', 'moss', 'sunset']);
  assert.deepEqual(of('ready'), ['light', 'dark', 'midnight', 'sepia', 'forest', 'plain']);
  assert.equal(of('glass').length, 12);
  assert.deepEqual(of('glass').slice(0, 2), ['glass', 'glassDark']);
});

test('glass backdrop: the glows come from the accent and the theme tints, the status hues without tints', () => {
  const { themeTokens, themePresets } = load();
  const glows = spec => themeTokens(spec).glass['--page-bg'].match(/#[0-9a-f]{6}/g).slice(0, 3);
  const base = { bg: '#0d1122', accent: '#8a98ff', glass: { blur: 16, opacity: 60 } };
  const tinted = glows({ ...base, tints: { ref: '#00e5ff', dep: '#ff4fd8' } });
  assert.equal(tinted[0], glows(base)[0], 'the accent glow does not depend on the tints');
  assert.notEqual(tinted[1], glows(base)[1]);
  assert.notEqual(tinted[2], glows(base)[2]);
  // Twelve glass presets, at least two light ones, each with its own backdrop.
  const glass = themePresets.filter(p => p.glass);
  assert.ok(glass.filter(p => themeTokens(p).base === 'light').length >= 2);
  assert.equal(new Set(glass.map(p => glows(p).join())).size, glass.length);
});

test('studio: every token is editable and listed in a group', () => {
  const { themeColorKeys, themeColorGroups } = load();
  const grouped = themeColorGroups.flatMap(g => g.keys).sort();
  assert.deepEqual(plain(grouped), [...themeColorKeys, 'bg', 'accent'].sort());
  assert.deepEqual(plain(themeColorGroups.map(g => g.id)), ['surfaces', 'text', 'border', 'accent', 'status']);
});

test('studio: duplicating any preset keeps every token and writes all colors out', () => {
  const { themePresets, themeDuplicate, themeTokens, themeColorKeys } = load();
  for (const spec of themePresets) {
    const copy = themeDuplicate(spec, 'Example copy');
    assert.equal(copy.name, 'Example copy');
    assert.deepEqual(Object.keys(copy.colors).sort(), [...themeColorKeys].sort(), spec.id);
    const a = themeTokens(spec), b = themeTokens(copy);
    assert.deepEqual(plain(b.tokens), plain(a.tokens), spec.id);
    assert.deepEqual(plain(b.summary), plain(a.summary), spec.id);
    assert.deepEqual(plain(b.glass), plain(a.glass), spec.id);
    assert.equal(b.base, a.base);
  }
});

test('studio: hex fields accept #rgb and #rrggbb only', () => {
  const { hexRgb, themeBodyRecord } = load();
  assert.deepEqual(plain(hexRgb('#1a2B3c')), [26, 43, 60]);
  assert.deepEqual(plain(hexRgb('#abc')), [170, 187, 204]);
  for (const bad of ['', '#12', '#12345', '#1234567', 'red', 'rgb(1,2,3)', '#ggg', 'url(x)', '#fff;color:red', null, undefined, 12]) assert.equal(hexRgb(bad), null, String(bad));
  assert.equal(themeBodyRecord({ bg: 'red', accent: '#fff' }), null);
  assert.deepEqual(plain(themeBodyRecord({ bg: '#000', accent: '#fff', colors: { text: 'red', surface: '#101010', nope: '#fff' } }).colors), { surface: '#101010' });
});

test('studio: auto-fix moves only failing text colors, by lightness, until the pair passes', () => {
  const { themeContrast, themeAutoFix, themeMaterialize } = load();
  const bad = themeMaterialize({ bg: '#101010', accent: '#2a78d6' });
  bad.colors = { ...bad.colors, text: '#242424', text2: '#303030', muted: '#383838', accentInk: '#1a2a40', onAccent: '#2a2a2a' };
  const before = themeContrast(bad);
  assert.ok(before.some(p => !p.pass), 'starts failing');
  const { body, changed } = themeAutoFix(bad);
  assert.deepEqual(plain(changed.sort()), ['accentInk', 'muted', 'text', 'text2']);
  for (const p of themeContrast(body)) assert.ok(p.pass, `${p.id}: ${p.ratio}`);
  assert.equal(body.bg, bad.bg);
  assert.equal(body.colors.surface, bad.colors.surface, 'surfaces stay');
  // A light theme with pale text works too, and a passing theme is left alone.
  const pale = themeMaterialize({ bg: '#f4f4f0', accent: '#1e8a55' });
  pale.colors = { ...pale.colors, text: '#cfcfc8', muted: '#d0d0c8' };
  for (const p of themeContrast(themeAutoFix(pale).body)) assert.ok(p.pass, p.id);
  const good = themeMaterialize({ bg: '#f4f4f0', accent: '#1e8a55' });
  assert.deepEqual(plain(themeAutoFix(good).changed), []);
});

test('studio: contrast pairs report ratio, grade and the key a fix may change', () => {
  const { themeContrast } = load();
  const pairs = themeContrast({ bg: '#ffffff', accent: '#2a78d6', colors: { text: '#777777' } });
  const t1 = pairs.find(p => p.id === 'text-bg');
  assert.equal(t1.pass, false);
  assert.equal(t1.fixKey, 'text');
  assert.ok(t1.ratio > 4 && t1.ratio < 4.5);
  assert.equal(t1.grade, 'AA large');
  assert.equal(pairs.find(p => p.id === 'accent-ui').min, 3);
  assert.deepEqual(plain(pairs.map(p => p.grade).filter(g => !['AAA', 'AA', 'AA large', 'Fail'].includes(g))), []);
});

test('save and load: every field survives storage and export, including glass, tints, palette and the light/dark pair', () => {
  const { themeRecord, themeUpsert, themeExport, themeImport, themeDuplicate, themePresets } = load();
  const src = themePresets.find(p => p.id === 'glassDark');
  const draft = themeDuplicate(src, 'Example full');
  draft.glass = { blur: 22, opacity: 55, strength: 70 };
  draft.tints = { ref: '#112233', dep: '#443322' };
  draft.palette = { pk: '#aa0000', score: '#00aa00', off: '#777777' };
  draft.mono = true;
  draft.contrast = 'high';
  draft.pair = themeDuplicate(themePresets.find(p => p.id === 'ivory'), '');
  delete draft.pair.name;
  draft.pair.glass = { blur: 3, opacity: 90, strength: 10 };
  const rec = themeRecord(draft);
  for (const k of ['colors', 'glass', 'tints', 'palette', 'mono', 'pair']) assert.ok(rec[k], k);
  assert.deepEqual(plain(rec.glass), { blur: 22, opacity: 55, strength: 70 });
  assert.equal(rec.pair.glass.strength, 10);
  const list = themeUpsert([], rec);
  // localStorage round trip
  const stored = JSON.parse(JSON.stringify(list)).map(themeRecord);
  assert.deepEqual(plain(stored), plain(list));
  // export and import round trip, with a version number
  const text = themeExport(list);
  assert.equal(JSON.parse(text).auspexThemes, 2);
  const back = themeImport(text, []);
  assert.deepEqual([back.added, back.skipped], [1, 0]);
  assert.deepEqual(plain(back.list), plain(list));
  assert.deepEqual(plain(back.list[0].colors), plain(rec.colors));
});

test('light/dark pair: the Auto, Light and Dark choice picks the variant', () => {
  const { themeResolve, themeRecord, bgIsDark } = load();
  const rec = themeRecord({ name: 'Example pair', bg: '#101820', accent: '#4c8dff', pair: { bg: '#f4f5f7', accent: '#2a78d6' } });
  assert.equal(bgIsDark(themeResolve(rec, true).bg), true);
  assert.equal(bgIsDark(themeResolve(rec, false).bg), false);
  assert.equal(themeResolve(rec, false).accent, '#2a78d6');
  assert.ok(!('pair' in themeResolve(rec, true)));
  const single = themeRecord({ name: 'Example single', bg: '#101820', accent: '#4c8dff' });
  assert.equal(themeResolve(single, false).bg, '#101820');
  assert.equal(themeResolve(null, true), null);
  // The page wires the switch to the variant.
  assert.ok(page.includes('if (themeHasPair()) { state.themeMode = b.dataset.v;'));
});

test('import validation: hostile JSON, unknown keys, out-of-range numbers, bad colors, size and version limits', () => {
  const { themeImport, themeExport, themeMaxCount, themeIdOf } = load();
  assert.equal(themeImport('{not json', []).error, 'not valid JSON');
  assert.equal(themeImport('', []).error, 'not valid JSON');
  assert.equal(themeImport('42', []).error, 'nothing to import');
  assert.equal(themeImport('null', []).error, 'nothing to import');
  assert.equal(themeImport('[]', []).error, 'nothing to import');
  assert.equal(themeImport('x'.repeat(200001), []).error, 'too large');
  assert.equal(themeImport(JSON.stringify({ auspexThemes: 99, themes: [{ name: 'Example', bg: '#000', accent: '#fff' }] }), []).error, 'unsupported version');
  assert.equal(themeImport(JSON.stringify({ auspexThemes: 'two', themes: [] }), []).error, 'unsupported version');
  // Hostile content: prototype keys, markup in names, bad colors, huge numbers.
  const hostile = '{"auspexThemes":2,"__proto__":{"polluted":1},"themes":[{"name":"<img src=x onerror=alert(1)>\\u0000bad","bg":"#000","accent":"#fff","__proto__":{"bg":"#123456"},'
    + '"constructor":{"x":1},"colors":{"text":"url(javascript:1)","surface":"#101010","raised":"#12","__proto__":"#fff"},"palette":{"pk":"expression(1)","fk":"#00f"},'
    + '"glass":{"blur":1e99,"opacity":-5,"strength":"7e3"},"tints":{"ref":"#12345678","dep":"#abc"},"extra":{"deep":[1,2,3]},"pair":{"bg":"nope","accent":"#fff"}},'
    + '{"name":"Example ok","bg":"#fff","accent":"#00f","contrast":"extreme","mono":"yes"},5,null,"x",{"name":"No colors"}]}';
  const r = themeImport(hostile, []);
  assert.equal(({}).polluted, undefined);
  assert.deepEqual([r.added, r.skipped], [2, 4]);
  const a = plain(r.list[0]);
  assert.ok(!/[\u0000-\u001f]/.test(a.name) && a.name.length <= 40);
  assert.equal(a.bg, '#000000');
  assert.deepEqual(a.colors, { surface: '#101010' });
  assert.deepEqual(a.palette, { fk: '#0000ff' });
  assert.deepEqual(a.glass, { blur: 40, opacity: 20, strength: 100 });
  assert.deepEqual(a.tints, { dep: '#aabbcc' });
  assert.ok(!('pair' in a) && !('extra' in a));
  const b = plain(r.list[1]);
  assert.equal(b.contrast, 'normal');
  assert.ok(!('mono' in b), 'mono must be literally true');
  // At most 50 themes per import and themeMaxCount in all.
  const many = JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ name: `Example ${i}`, bg: '#000', accent: '#fff' })));
  const m = themeImport(many, []);
  assert.deepEqual([m.added, m.skipped, m.list.length], [50, 30, 50]);
  const full = Array.from({ length: themeMaxCount }, (_, i) => ({ id: themeIdOf(`Example ${i}`), name: `Example ${i}`, bg: '#000000', accent: '#ffffff', contrast: 'normal' }));
  const over = themeImport(JSON.stringify([{ name: 'One more', bg: '#000', accent: '#fff' }, { name: 'Example 3', bg: '#111', accent: '#fff' }]), full);
  assert.equal(over.list.length, themeMaxCount);
  assert.deepEqual([over.added, over.skipped], [1, 1]);
  // Version 1 files and plain arrays still import.
  assert.equal(themeImport(JSON.stringify({ auspexThemes: 1, themes: [{ name: 'Old', bg: '#000', accent: '#fff' }] }), []).added, 1);
  assert.equal(themeExport([]).includes('"auspexThemes": 2'), true);
});

test('default theme is Auspex only when nothing is saved', () => {
  const { themeDefaultId, themeSpecOf } = load();
  assert.equal(themeDefaultId(undefined), 'auspex');
  assert.equal(themeDefaultId(null), 'auspex');
  assert.equal(themeDefaultId(''), 'auspex');
  for (const saved of ['auto', 'light', 'dark', 'plain', 'midnight', 'custom:abc']) assert.equal(themeDefaultId(saved), saved);
  assert.equal(themeSpecOf('auspex', []).id, 'auspex');
  assert.ok(page.includes('state.theme = themeDefaultId(state.theme);'));
});

test('header brand logo is the app icon as a small PNG data URI', () => {
  const m = page.match(/<img class="logo" alt="" width="30" height="30" src="data:image\/png;base64,([A-Za-z0-9+/=]+)">/);
  assert.ok(m, 'img logo in the header');
  const png = Buffer.from(m[1], 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(png.readUInt32BE(16) <= 64 && png.readUInt32BE(16) >= 30, 'width 30-64 px');
  assert.ok(png.length < 16000, 'small');
  assert.doesNotMatch(page, /<svg class="logo"/);
});

test('viewer.html never calls window.prompt, confirm or alert (blocked in the desktop app)', () => {
  // Comments may mention them; code may not call them.
  const code = page.split(/\r?\n/).map(l => l.replace(/(^|\s)\/\/\s.*$/, '').replace(/\/\*.*?\*\//g, '')).join('\n');
  assert.doesNotMatch(code, /(?<![\w.$])(?:window\.)?(?:prompt|confirm|alert)\s*\(/);
  assert.match(page, /function themeConfirm\(/);
  assert.match(page, /id="themeConfirmDlg"/);
});

test('studio dialog: modal, Esc handled, Tab trapped, colors edited in place and never through the menu', () => {
  assert.match(page, /<dialog class="dlg th-studio" id="themeDlg"/);
  assert.ok(page.includes("dlg.addEventListener('cancel', ev => { ev.preventDefault(); requestCloseStudio(); });"));
  assert.ok(page.includes("if (ev.key === 'Tab')"));
  assert.ok(page.includes("pickIn.addEventListener('input'"), 'live input events, not change at picker close');
  assert.ok(page.includes('dlg.showModal()'));
  // The popover menu has no color controls any more.
  const menu = page.match(/function renderThemeMenu\(\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(menu, /type: 'color'/);
});

test('studio lifecycle: a native close while the session is active re-shows the dialog', () => {
  const { themeDialogRecover } = load();
  const dlg = { open: false, shown: 0, showModal() { this.open = true; this.shown++; } };
  assert.equal(themeDialogRecover(true, dlg), true);
  assert.equal(dlg.shown, 1);
  assert.equal(themeDialogRecover(true, dlg), false, 'already open');
  dlg.open = false;
  assert.equal(themeDialogRecover(false, dlg), false, 'no session: stays closed');
  assert.ok(page.includes("dlg.addEventListener('close', () => { themeDialogRecover(!!studio, dlg); });"));
  assert.ok(page.includes("$('themeConfirmDlg').addEventListener('keydown', ev => ev.stopPropagation());"));
  assert.ok(page.includes('studio.origId = studio.snapshotOrigId;'));
});

test('auspex presets: side-panel tints come from each palette and keep contrast', () => {
  const { themePresets, themeTokens, themeContrast } = load();
  const want = { auspex: ['#c9a04f', '#2fbf71'], forge: ['#b8894a', '#d7783a'], phosphor: ['#4f9a67', '#e8c547'], verdigris: ['#3bb3a0', '#c2a15a'], ivory: ['#9a7330', '#1e8a55'] };
  for (const [id, [r, d]] of Object.entries(want)) {
    const spec = themePresets.find(p => p.id === id);
    assert.deepEqual(plain(spec.tints), { ref: r, dep: d });
    const res = themeTokens(spec);
    assert.equal(res.tokens['--tint-ref-hue'], r);
    assert.equal(res.warnings.length, 0, id);
    for (const p of themeContrast(spec)) assert.ok(p.pass, id + ' ' + p.id);
  }
});
