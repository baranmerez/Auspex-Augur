import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spreadsheetSafe } from '../src/db.js';

// Runs the preview-helpers block of the report template in isolation: the
// pure parts of the detail screen (header names, sorting, filter, totals, CSV,
// description split, run parameters).
const template = fs.readFileSync(new URL('../src/reports/template.html', import.meta.url), 'utf8');
const viewerPage = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = template.match(/\/\/ preview-helpers:start[\s\S]*?\/\/ preview-helpers:end/)?.[0];

function load() {
  assert.ok(block, 'preview-helpers block found in template.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nthis.api = { humanizeHeader, compareValues, sortPreviewRows, filterPreviewRows, previewTotals, csvSafeCell, previewCsv, splitDescription, paramsText, paramCountOf, isNumericType, isIdentifierColumn };`, context);
  return context.api;
}
const api = load();
const cols = [{ name: 'order_id', type: 'int4' }, { name: 'status_code', type: 'text' }, { name: 'amount', type: 'numeric' }];

test('headers are humanized and keep odd names usable', () => {
  assert.equal(api.humanizeHeader('order_id'), 'Order id');
  assert.equal(api.humanizeHeader('created_at'), 'Created at');
  assert.equal(api.humanizeHeader('__status__code_'), 'Status code');
  assert.equal(api.humanizeHeader('amount'), 'Amount');
  assert.equal(api.humanizeHeader('ALREADY_UPPER'), 'ALREADY UPPER');
  assert.equal(api.humanizeHeader('___'), '___');
  assert.equal(api.humanizeHeader(''), '');
});

test('comparison is numeric-aware', () => {
  assert.ok(api.compareValues(9, 10) < 0);
  assert.ok(api.compareValues('9', '10') < 0, 'numeric text compares by value');
  assert.ok(api.compareValues('1.5', 1.25) > 0);
  assert.ok(api.compareValues('item 2', 'item 10') < 0, 'digit runs in natural order');
  assert.ok(api.compareValues('Apple', 'banana') < 0);
  assert.equal(api.compareValues('a', 'A'), 0);
});

test('sorting asc/desc keeps empty values last and ties stable', () => {
  const rows = [[3, 'b', '10'], [1, 'a', null], [2, 'c', '9'], [1, 'd', '9']];
  const names = r => r.map(x => x[1]);
  assert.deepEqual(names(api.sortPreviewRows(rows, 0, 'asc')), ['a', 'd', 'c', 'b']);
  assert.deepEqual(names(api.sortPreviewRows(rows, 0, 'desc')), ['b', 'c', 'a', 'd']);
  assert.deepEqual(names(api.sortPreviewRows(rows, 2, 'asc')), ['c', 'd', 'b', 'a'], 'numeric text 9 < 10, null last');
  assert.deepEqual(names(api.sortPreviewRows(rows, 2, 'desc')), ['b', 'c', 'd', 'a'], 'null still last');
  assert.deepEqual(names(api.sortPreviewRows(rows, -1, 'asc')), names(rows));
  assert.deepEqual(names(api.sortPreviewRows(rows, 0, 'none')), names(rows));
  assert.notEqual(api.sortPreviewRows(rows, 0, 'asc'), rows, 'a copy');
  assert.deepEqual(names(rows), ['b', 'a', 'c', 'd'], 'input untouched');
});

test('the quick filter matches any cell, case-insensitively', () => {
  const rows = [[1, 'OPEN', '5'], [2, 'closed', null], [3, 'open', '7']];
  assert.equal(api.filterPreviewRows(rows, 'open').length, 2);
  assert.equal(api.filterPreviewRows(rows, ' CLOSED ').length, 1);
  assert.equal(api.filterPreviewRows(rows, '7').length, 1);
  assert.equal(api.filterPreviewRows(rows, 'null').length, 0, 'empty cells never match');
  assert.equal(api.filterPreviewRows(rows, '').length, 3);
});

test('totals sum numeric columns only; masked, text and empty columns have none', () => {
  const tc = [{ name: 'quantity', type: 'int4' }, cols[1], cols[2]];
  const rows = [[1, 'a', '10.10'], [2, 'b', 20.2], [3, 'c', null]];
  assert.deepEqual(Array.from(api.previewTotals(tc, rows)), [6, null, 30.3], 'no float noise');
  assert.deepEqual(Array.from(api.previewTotals(tc, rows, new Set(['amount']))), [6, null, null], 'masked stays masked');
  assert.deepEqual(Array.from(api.previewTotals(tc, [[null, 'a', null]])), [null, null, null]);
  assert.deepEqual(Array.from(api.previewTotals(tc, [])), [null, null, null]);
  assert.deepEqual(Array.from(api.previewTotals(tc, [[1, 'x', 'n/a']])), [1, null, null], 'non-numeric text is skipped');
});

test('identifier and code columns are not summed', () => {
  for (const n of ['id', 'order_id', 'customerId', 'status_code', 'statusCode', 'teslim_durum_kodu', 'invoice_no', 'invoiceNo', 'ORDER_ID']) assert.ok(api.isIdentifierColumn(n), n);
  for (const n of ['amount', 'quantity', 'total_price', 'amount_paid', 'prepaid', 'total_paid', 'casino', 'decode_count']) assert.ok(!api.isIdentifierColumn(n), n);
  const c = [{ name: 'order_id', type: 'int4' }, { name: 'status_code', type: 'int4' }, { name: 'invoice_no', type: 'int8' }, { name: 'amount', type: 'numeric' }];
  assert.deepEqual(Array.from(api.previewTotals(c, [[1, 2, 3, '4.5'], [5, 6, 7, 1]])), [null, null, null, 5.5]);
});

test('with ";" numeric columns get a decimal comma; the comma export is unchanged', () => {
  const rows = [[1, 'a.b', '-3.5'], [2, '1.5', 4.25]];
  assert.equal(api.previewCsv(cols, rows, ';').split('\r\n')[1], '1;a.b;-3,5', 'text keeps its dot');
  assert.equal(api.previewCsv(cols, rows, ';').split('\r\n')[2], '2;1.5;4,25');
  assert.equal(api.previewCsv(cols, rows, ',').split('\r\n')[1], '1,a.b,-3.5');
  assert.equal(api.previewCsv(cols, rows, ',').split('\r\n')[2], '2,1.5,4.25');
  assert.equal(api.previewCsv(cols, [[1, 'a', '=1.5']], ';').split('\r\n')[1], "1;a;'=1.5", 'a formula stays neutralized');
});

test('CSV cells follow the spreadsheet rule of src/db.js', () => {
  for (const v of ['=1+1', '+1+1', '-2+3', '@SUM(1,1)', '\tTAB', '\rCR', 'plain', 'Şükrü', '']) {
    assert.equal(api.csvSafeCell(v, false), spreadsheetSafe(v), JSON.stringify(v));
  }
  assert.equal(api.csvSafeCell('-5', true), '-5', 'a negative number in a numeric column stays exact');
  assert.equal(api.csvSafeCell(-5, false), '-5');
  assert.equal(api.csvSafeCell('-5', false), "'-5", 'text that looks numeric is neutralized');
  assert.equal(api.csvSafeCell('=2*2', true), "'=2*2", 'a formula in a numeric column is still neutralized');
  assert.equal(api.csvSafeCell(null, false), '');
});

test('CSV text has raw headers, quotes special fields and neutralizes formulas', () => {
  const rows = [[1, '=HYPERLINK("x")', '-3.5'], [2, 'a,b', null], [3, 'say "hi"\nnow', '4']];
  const csv = api.previewCsv(cols, rows, ',');
  assert.equal(csv, ['order_id,status_code,amount', '1,"\'=HYPERLINK(""x"")",-3.5', '2,"a,b",', '3,"say ""hi""\nnow",4'].join('\r\n'));
  assert.equal(api.previewCsv(cols, [[1, 'a;b', '2']], ';').split('\r\n')[1], '1;"a;b";2');
  assert.equal(api.previewCsv([{ name: '=bad', type: 'text' }], [], ','), "'=bad", 'a header cannot run as a formula');
});

test('description: first sentence or paragraph, the rest and a parameters line', () => {
  const one = api.splitDescription('Orders per customer. Includes cancelled ones. Updated daily.');
  assert.deepEqual({ ...one }, { first: 'Orders per customer.', rest: 'Includes cancelled ones. Updated daily.', params: null });
  const paras = api.splitDescription('First paragraph, no stop\n\nSecond paragraph.\n\nThird.');
  assert.equal(paras.first, 'First paragraph, no stop');
  assert.equal(paras.rest, 'Second paragraph.\n\nThird.');
  const withParams = api.splitDescription('Totals by status.\nParameters: $1 = from date, $2 = to date');
  assert.deepEqual({ ...withParams }, { first: 'Totals by status.', rest: '', params: '$1 = from date, $2 = to date' });
  const inline = api.splitDescription('Orders by status. Parameters: $1 = from date');
  assert.deepEqual({ ...inline }, { first: 'Orders by status.', rest: '', params: '$1 = from date' });
  assert.equal(api.splitDescription('Intro line\nParameters: $1 = a\nSecond line').rest, '', 'a removed parameters line does not split the paragraph');
  assert.equal(api.splitDescription('Version 1.2 of the list').rest, '', 'a dot inside a number is no sentence end');
  assert.deepEqual({ ...api.splitDescription('') }, { first: '', rest: '', params: null });
});

test('run parameters: values when stored, otherwise the count from the SQL', () => {
  assert.equal(api.paramsText(['2026-01-01', 5, null]), "$1 = '2026-01-01', $2 = 5, $3 = NULL");
  assert.equal(api.paramsText(null), null);
  assert.equal(api.paramsText([]), null);
  assert.ok(api.paramsText(['x'.repeat(100)]).length < 60, 'long values are cut');
  assert.equal(api.paramCountOf('select 1 where a = $1 and b = $3 and c = $1'), 3);
  assert.equal(api.paramCountOf('select 1'), 0);
  assert.equal(api.paramCountOf(null), 0);
});

test('numeric column types', () => {
  for (const t of ['int4', 'int8', 'numeric', 'float8', 'money']) assert.ok(api.isNumericType(t), t);
  for (const t of ['text', 'date', 'bool', undefined]) assert.ok(!api.isNumericType(t), String(t));
});

test('the report stays usable standalone: embed-only hiding lives in the viewer, not in the template', () => {
  assert.doesNotMatch(template, /#lang, #theme \{ display: none/);
  assert.match(viewerPage, /\.head h1, \.head \.crumbs \.loc, #lang, #theme \{ display: none !important; \}/);
  assert.match(template, /function downloadCsv/, 'standalone download exists');
  assert.match(template, /function rememberPerf/, 'standalone remembers the toggle');
  assert.match(template, /tab: 'preview'/, 'preview is the tab shown first');
});
