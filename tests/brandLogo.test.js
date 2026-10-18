import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = read('../src/viewer.html');
const svgUrl = new URL('../docs/assets/banner.svg', import.meta.url);
const svg = fs.readFileSync(svgUrl, 'utf8');

test('header logo has a decorative radar overlay with a reduced-motion rule', () => {
  const brand = page.match(/<div class="brand">[\s\S]*?<h1>/)?.[0] || '';
  assert.match(brand, /<span class="logo-radar" aria-hidden="true">/);
  assert.match(brand, /class="sweep"/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\) \{\s*\.logo-radar \.sweep \{ animation: none/);
  assert.match(page, /html\.page-hidden \.logo-radar/);
  assert.match(page, /visibilitychange/);
});

const readmeSvgs = ['banner.svg', 'stats.svg', 'divider.svg', 'how-it-works.svg', 'safety-layers.svg', 'handoff.svg', 'example-session.svg', 'desktop-app.svg'];

test('animated README graphics are self-contained, small and respect reduced motion', () => {
  for (const name of readmeSvgs) {
    const url = new URL(`../docs/assets/${name}`, import.meta.url);
    const text = fs.readFileSync(url, 'utf8');
    assert.ok(fs.statSync(url).size < 64 * 1024, name);
    assert.doesNotMatch(text, /<script/i, name);
    assert.doesNotMatch(text, /foreignObject/i, name);
    assert.doesNotMatch(text, /href\s*=\s*["']\s*(https?:)?\/\//i, name);
    assert.match(text, /@keyframes/, name);
    assert.match(text, /@media \(prefers-reduced-motion: reduce\)/, name);
  }
  assert.match(svg, /viewBox="0 0 1200 420"/);
  assert.match(svg, /href="data:image\/png;base64,/);
  assert.ok(fs.existsSync(new URL('../docs/assets/auspex-icon.png', import.meta.url)));
});

test('README references the animated graphics and every docs page', () => {
  const readme = read('../README.md');
  for (const name of readmeSvgs) assert.match(readme, new RegExp(`docs/assets/${name.replace('.', '\\.')}`), name);
  for (const page of ['safety', 'tools', 'reports', 'schema-memory', 'clients', 'viewer', 'configuration', 'testing']) {
    assert.match(readme, new RegExp(`\\(docs/${page}\\.md\\)`), page);
    assert.ok(fs.existsSync(new URL(`../docs/${page}.md`, import.meta.url)), page);
  }
});
