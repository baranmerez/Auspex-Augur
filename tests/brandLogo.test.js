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

test('animated README banner is self-contained and small', () => {
  assert.ok(fs.statSync(svgUrl).size < 64 * 1024);
  assert.doesNotMatch(svg, /<script/i);
  assert.doesNotMatch(svg, /foreignObject/i);
  assert.doesNotMatch(svg, /href\s*=\s*["']\s*(https?:)?\/\//i);
  assert.match(svg, /viewBox="0 0 1200 340"/);
  assert.match(svg, /href="data:image\/png;base64,/);
  assert.match(svg, /<animateTransform/);
  assert.ok(fs.existsSync(new URL('../docs/assets/auspex-icon.png', import.meta.url)));
});

test('README references the animated banner', () => {
  assert.match(read('../README.md'), /docs\/assets\/banner\.svg/);
});
