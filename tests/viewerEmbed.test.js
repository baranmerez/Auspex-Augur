import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the embed block of src/viewer.html (how the viewer embeds an HTML
// report and which messages it accepts from it) in isolation.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const template = fs.readFileSync(new URL('../src/reports/template.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ embed:start[\s\S]*?\/\/ embed:end/)?.[0];

function loadEmbed() {
  assert.ok(block, 'embed block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nthis.embedReport = embedReport; this.reportMessage = reportMessage; this.reportFrameOf = reportFrameOf; this.css = reportEmbedCss; this.js = reportEmbedJs; this.reportCopyMax = reportCopyMax;`, context);
  return context;
}
const count = (s, part) => s.split(part).length - 1;

test('CSS and script are injected once, right before the real </head> and </body>', () => {
  const { embedReport, css, js } = loadEmbed();
  // Report data escapes "<" (src/reports/service.js), as in a real report.
  const data = JSON.stringify({ sql: 'select \'</body></head>\'' }).replace(/</g, '\\u003c');
  const html = template.replace('"__AUSPEX_DATA__"', () => data);
  const out = embedReport(html);
  assert.equal(count(out, css), 1);
  assert.equal(count(out, js), 1);
  assert.equal(out.indexOf(css) + css.length, out.indexOf('</head>'));
  assert.equal(out.indexOf(js) + js.length, out.lastIndexOf('</body>'));
  assert.equal(count(out, '</body>'), 1);
  assert.equal(out.replace(css, '').replace(js, ''), html, 'nothing else changes');
  assert.ok(out.includes('\\u003c/body>'), 'escaped data stays as it was');
});

test('a literal </body> before the real one does not receive the script', () => {
  const { embedReport, js } = loadEmbed();
  const html = '<html><head></head><body><pre>&lt;/body&gt;</pre><!-- </body> --><p>x</p></body></html>';
  const out = embedReport(html);
  assert.equal(count(out, js), 1);
  assert.ok(out.endsWith(`<p>x</p>${js}</body></html>`));
});

test('HTML without </head> or </body>, or with them out of order, is returned unchanged', () => {
  const { embedReport } = loadEmbed();
  for (const html of ['<html><body>x</body></html>', '<html><head></head>x', '<body></body><head></head>', 'plain text']) {
    assert.equal(embedReport(html), html);
  }
});

test('the embed hides the report toast and relays it; the script cannot close early', () => {
  const { css, js } = loadEmbed();
  assert.match(css, /#toast \{ display: none !important; \}/);
  assert.match(js, /auspexReportToast/);
  assert.equal(count(js, '</script>'), 1, 'one closing tag, at the end');
  assert.ok(js.endsWith('</script>'));
});

test('height messages are clamped; anything malformed is ignored', () => {
  const { reportMessage } = loadEmbed();
  assert.deepEqual({ ...reportMessage({ auspexReportHeight: 1234.4 }) }, { height: 1234 });
  assert.deepEqual({ ...reportMessage({ auspexReportHeight: 3 }) }, { height: 240 });
  assert.deepEqual({ ...reportMessage({ auspexReportHeight: -50 }) }, { height: 240 });
  assert.deepEqual({ ...reportMessage({ auspexReportHeight: 1e9 }) }, { height: 200000 });
  for (const bad of [null, undefined, 'x', 42, {}, { auspexReportHeight: '900' }, { auspexReportHeight: NaN },
    { auspexReportHeight: Infinity }, { auspexReportToast: '' }, { auspexReportToast: '   ' }, { auspexReportToast: 5 }]) {
    assert.equal(reportMessage(bad), null, JSON.stringify(bad));
  }
});

test('toast messages carry text only, capped in length', () => {
  const { reportMessage } = loadEmbed();
  assert.deepEqual({ ...reportMessage({ auspexReportToast: 'SQL copied' }) }, { toast: 'SQL copied' });
  assert.equal(reportMessage({ auspexReportToast: 'x'.repeat(500) }).toast.length, 200);
});

test('only a report frame of the page is accepted as the message source', () => {
  const { reportFrameOf } = loadEmbed();
  const winA = {}, winB = {}, other = {};
  const frames = [{ contentWindow: winA }, { contentWindow: winB }];
  assert.equal(reportFrameOf(frames, winB), frames[1]);
  assert.equal(reportFrameOf(frames, other), null);
  assert.equal(reportFrameOf(frames, null), null);
  assert.equal(reportFrameOf([], winA), null);
});

test('copy messages carry the text and a short label; oversized or malformed ones are ignored', () => {
  const { reportMessage, reportCopyMax } = loadEmbed();
  assert.deepEqual({ ...reportMessage({ auspexReportCopy: 'select 1', auspexReportCopyWhat: 'SQL' }) }, { copy: 'select 1', what: 'SQL' });
  assert.deepEqual({ ...reportMessage({ auspexReportCopy: '' }) }, { copy: '', what: '' });
  assert.equal(reportMessage({ auspexReportCopy: 'x', auspexReportCopyWhat: 'w'.repeat(99) }).what.length, 40);
  assert.equal(reportMessage({ auspexReportCopy: 'x', auspexReportCopyWhat: { a: 1 } }).what, '');
  assert.equal(reportMessage({ auspexReportCopy: 'x'.repeat(reportCopyMax) }).copy.length, reportCopyMax);
  assert.deepEqual({ ...reportMessage({ auspexReportCopy: 'x'.repeat(reportCopyMax + 1) }) }, { copyTooLarge: true }, 'reported, not ignored');
  assert.equal(reportMessage({ auspexReportCopy: 5 }), null);
  assert.equal(reportMessage({ auspexReportCopy: ['a'] }), null);
});

test('inside the viewer the report copy() posts its text to the parent instead of the clipboard', () => {
  const { js } = loadEmbed();
  const code = js.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  const posted = [];
  const win = {
    copy: async () => { throw new Error('the frame clipboard must not be used'); },
    parent: { postMessage: (m, o) => posted.push([m, o]) },
    document: { querySelectorAll: () => [], getElementById: () => null, body: { getBoundingClientRect: () => ({ height: 300 }) } },
    MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} }, addEventListener() {},
  };
  win.window = win;
  const context = vm.createContext(win);
  vm.runInContext(code, context);
  posted.length = 0;
  vm.runInContext("copy('select 1', 'SQL')", context);
  assert.equal(JSON.stringify(posted), JSON.stringify([[{ auspexReportCopy: 'select 1', auspexReportCopyWhat: 'SQL' }, '*']]));
});

test('the embed hides the report title, location chips and language/theme controls only inside the viewer', () => {
  const { css } = loadEmbed();
  assert.match(css, /\.head h1, \.head \.crumbs \.loc, #lang, #theme \{ display: none !important; \}/);
  assert.ok(!template.includes('#lang, #theme { display: none'), 'the saved file keeps them');
});

test('download and performance-toggle messages are relayed; malformed ones are ignored', () => {
  const { reportMessage, reportCopyMax } = loadEmbed();
  const dl = reportMessage({ auspexReportDownload: { name: 'a b/../c.csv', text: 'x,y' } });
  assert.deepEqual({ ...dl.download }, { name: 'a_b_.._c.csv', text: 'x,y' });
  assert.deepEqual({ ...reportMessage({ auspexReportDownload: { name: '', text: '' } }).download }, { name: 'report.csv', text: '' });
  assert.deepEqual({ ...reportMessage({ auspexReportDownload: { name: 'a.csv', text: 'x'.repeat(reportCopyMax + 1) } }) }, { copyTooLarge: true });
  for (const bad of [{ auspexReportDownload: 'x' }, { auspexReportDownload: { name: 1, text: 'x' } }, { auspexReportDownload: { name: 'a', text: 5 } }, { auspexReportPerf: 'yes' }]) {
    assert.equal(reportMessage(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual({ ...reportMessage({ auspexReportPerf: true }) }, { perf: true });
  assert.deepEqual({ ...reportMessage({ auspexReportPerf: false }) }, { perf: false });
});

test('inside the viewer the report posts its CSV and toggle state to the parent', () => {
  const { js } = loadEmbed();
  const code = js.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  const posted = [];
  const win = {
    downloadCsv: () => { throw new Error('the frame cannot download'); }, rememberPerf: () => {},
    parent: { postMessage: (m, o) => posted.push([m, o]) },
    document: { querySelectorAll: () => [], getElementById: () => null, body: { getBoundingClientRect: () => ({ height: 300 }) } },
    MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} }, addEventListener() {},
  };
  win.window = win;
  const context = vm.createContext(win);
  vm.runInContext(code, context);
  posted.length = 0;
  vm.runInContext("downloadCsv('a.csv', 'x,y'); rememberPerf(true)", context);
  assert.equal(JSON.stringify(posted), JSON.stringify([[{ auspexReportDownload: { name: 'a.csv', text: 'x,y' } }, '*'], [{ auspexReportPerf: true }, '*']]));
});
