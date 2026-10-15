import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spreadsheetSafe } from '../src/db.js';

// The viewer page is standalone (served as one file and copied into the
// desktop app), so it keeps its own copy of the spreadsheet rule. These tests
// run the real block from src/viewer.html next to src/db.js over the same
// fixtures, so the two copies cannot drift.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ csv-export:start[\s\S]*?\/\/ csv-export:end/)?.[0];
const sourceLine = page.match(/^const sourceOf = .*$/m)?.[0];

function loadViewer() {
  assert.ok(block, 'csv-export block found in viewer.html');
  assert.ok(sourceLine, 'sourceOf found in viewer.html');
  const downloads = [];
  const context = vm.createContext({ download: (name, text, type) => downloads.push({ name, text, type }) });
  vm.runInContext(`${sourceLine}\n${block}\nthis.spreadsheetSafe = spreadsheetSafe; this.exportRows = exportRows;`, context);
  return { ...context, downloads };
}

const fixtures = [
  '=1+1', '+1+1', '-2+3', '@SUM(1,1)', '\tTAB', '\rCR', '=HYPERLINK("http://x","y")',
  'plain', 'Şükrü Öz ığüşöç', 'a;b', 'a,b', 'say "hi"', 'line\nbreak', '', ' =1+1', "'=already",
  null, undefined, -5, 0, 3.5,
];

test('viewer and export use the same spreadsheet rule', () => {
  const viewer = loadViewer();
  for (const value of fixtures) assert.equal(viewer.spreadsheetSafe(value), spreadsheetSafe(value), JSON.stringify(value));
});

test('the spreadsheet rule neutralizes formula prefixes and leaves other values alone', () => {
  for (const value of ['=1+1', '+1+1', '-2+3', '@SUM(1,1)', '\tTAB', '\rCR']) assert.equal(spreadsheetSafe(value), `'${value}`);
  for (const value of ['plain', 'Şükrü Öz ığüşöç', 'say "hi"', '', null, -5, 0]) assert.equal(spreadsheetSafe(value), value);
});

test('Operations CSV download neutralizes text cells and keeps numbers', () => {
  const viewer = loadViewer();
  const rows = [
    { _id: 1, ts: '2026-10-15T10:00:00.000Z', source: 'mcp', tool: 'query', profile: 'local', ms: -5, rowCount: 0,
      error: '=1+1 rejected', sql: '=1+1', params: ['=x'] },
    { _id: 2, ts: '2026-10-15T10:00:01.000Z', tool: '@tool', profile: '+p', ms: 12, rowCount: null,
      error: '-bad; "quoted"\nnext', sql: 'select \'Şükrü\' as ad', params: null },
    { _id: 3, ts: '2026-10-15T10:00:02.000Z', source: 'script', tool: 'query', profile: 'local', ms: 3, rowCount: 1,
      error: '\tTAB', sql: '\rselect 1', params: [] },
  ];
  viewer.exportRows(rows, 'csv');
  const [csv] = viewer.downloads;
  assert.equal(csv.type, 'text/csv');
  assert.match(csv.name, /^auspex-log-.*\.csv$/);
  assert.ok(csv.text.startsWith('﻿'));
  const lines = csv.text.slice(1).split('\r\n');
  assert.equal(lines[0], 'ts;source;tool;profile;ms;rowCount;error;sql;params');
  assert.equal(lines[1], `2026-10-15T10:00:00.000Z;mcp;query;local;-5;0;'=1+1 rejected;'=1+1;"[""=x""]"`);
  assert.equal(lines[2], `2026-10-15T10:00:01.000Z;old;'@tool;'+p;12;;"'-bad; ""quoted""\nnext";select 'Şükrü' as ad;`);
  assert.equal(lines[3], `2026-10-15T10:00:02.000Z;script;query;local;3;1;'\tTAB;"'\rselect 1";[]`);
});

test('Operations JSON download stays exact', () => {
  const viewer = loadViewer();
  const rows = [{ _id: 1, tool: 'query', sql: '=1+1', error: '+x', ms: -5 }];
  viewer.exportRows(rows, 'json');
  const [json] = viewer.downloads;
  assert.equal(json.type, 'application/json');
  assert.deepEqual(JSON.parse(json.text), [{ tool: 'query', sql: '=1+1', error: '+x', ms: -5 }]);
});
