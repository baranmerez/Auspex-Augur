import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { appendTrend, readTrend, trendFile, trendPoint } from '../src/schedule/store.js';
import { previewTotals, columnTotals } from '../src/reports/totals.js';

const ref = { db: 'exampledb', schema: 'example', category: 'Orders/Delivery', name: 'example-report' };

test('trend points are appended and bounded to the newest ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-trend-'));
  try {
    for (let i = 0; i < 7; i++) appendTrend(root, ref, { v: 1, slot: `2026-10-${String(i + 1).padStart(2, '0')}T08:00`, rows: i }, { maxPoints: 5 });
    const file = trendFile(root, ref);
    assert.equal(file, path.join(root, 'exampledb', 'example', 'Orders', 'Delivery', 'example-report.jsonl'));
    const points = readTrend(file);
    assert.deepEqual(points.map(p => p.rows), [2, 3, 4, 5, 6]);
    fs.appendFileSync(file, '{broken\n');
    assert.equal(readTrend(file).length, 5, 'a torn line is skipped');
    assert.throws(() => trendFile(root, { ...ref, schema: '..' }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a trend point holds aggregates only and is ready for thresholds', () => {
  const last = {
    summary: { analyzed: true, rows: 2, planningMs: 1, executionMs: 2 },
    columns: [{ name: 'status_code', type: 'text' }, { name: 'amount', type: 'numeric' }],
    preview: [['A', '1'], ['B', '2']], previewExecuted: true, previewTruncated: false,
  };
  const p = trendPoint({ scheduleId: 's', slot: '2026-10-12T08:00', ranAt: 'x', preset: 'last_7_days', params: ['2026-10-06', '2026-10-13'], last, sqlHash: 'abcdefabcdef', version: 2, totals: [{ column: 'amount', total: 3 }] });
  assert.deepEqual(Object.keys(p).sort(), ['durationMs', 'params', 'preset', 'previewComplete', 'ranAt', 'rows', 'scheduleId', 'slot', 'sqlHash', 'totals', 'v', 'version']);
  assert.equal(p.rows, 2);
  assert.ok(!JSON.stringify(p).includes('"A"'), 'no preview values');
  // A cut preview without ANALYZE: no exact row count and no totals.
  const cut = trendPoint({ last: { ...last, summary: { analyzed: false, rows: 900 }, previewTruncated: true }, totals: [{ column: 'amount', total: 3 }] });
  assert.equal(cut.rows, null);
  assert.equal(cut.estimatedRows, 900);
  assert.equal(cut.totals, null);
  assert.equal(cut.previewComplete, false);
});

test('totals match the report page: identifier, code and masked columns stay out', () => {
  const template = fs.readFileSync(new URL('../src/reports/template.html', import.meta.url), 'utf8');
  const block = template.match(/\/\/ preview-helpers:start[\s\S]*?\/\/ preview-helpers:end/)?.[0];
  assert.ok(block);
  const context = vm.createContext({});
  vm.runInContext(`${block}\nthis.previewTotals = previewTotals;`, context);
  const fixtures = [
    [[{ name: 'order_id', type: 'int4' }, { name: 'status_code', type: 'int4' }, { name: 'amount', type: 'numeric' }, { name: 'customerId', type: 'int8' }, { name: 'teslim_durum_kodu', type: 'int2' }, { name: 'orders', type: 'bigint' }],
      [[1, 2, '10.5', 7, 3, '4'], [2, 3, null, 8, 4, '5'], [3, 4, 'x', 9, 5, '6']]],
    [[{ name: 'amount', type: 'numeric' }, { name: 'name', type: 'text' }], []],
    [[{ name: 'amount', type: 'double precision' }], [['0.1'], ['0.2']]],
  ];
  for (const [cols, rows] of fixtures) {
    assert.deepEqual(previewTotals(cols, rows), JSON.parse(JSON.stringify(context.previewTotals(cols, rows))));
    assert.deepEqual(previewTotals(cols, rows, new Set(['amount'])), JSON.parse(JSON.stringify(context.previewTotals(cols, rows, new Set(['amount'])))));
  }
  assert.deepEqual(columnTotals(fixtures[0][0], fixtures[0][1]), [{ column: 'amount', total: 10.5 }, { column: 'orders', total: 15 }]);
  assert.deepEqual(columnTotals(fixtures[0][0], fixtures[0][1], ['amount']), [{ column: 'orders', total: 15 }]);
  assert.deepEqual(columnTotals([{ name: '__proto__', type: 'int4' }, { name: '__proto__', type: 'int4' }], [[1, 2]]), [{ column: '__proto__', total: 1 }]);
});

test('integer and numeric totals are exact in both copies; float columns keep the rounded sum', () => {
  const template = fs.readFileSync(new URL('../src/reports/template.html', import.meta.url), 'utf8');
  const block = template.match(/\/\/ preview-helpers:start[\s\S]*?\/\/ preview-helpers:end/)?.[0];
  const context = vm.createContext({});
  vm.runInContext(`${block}\nthis.previewTotals = previewTotals;`, context);
  const amount = [{ name: 'amount', type: 'numeric' }];
  const cases = [
    [amount, [['9007199254740993']], ['9007199254740993']],
    [amount, [['12345678901234.56'], ['0.01']], ['12345678901234.57']],
    [amount, [['99999999999999.99'], ['-0.99']], [99999999999999]],
    [amount, [['0.1'], ['0.2']], [0.3]],
    [amount, [['-5.50'], ['5.5']], [0]],
    [amount, [['-1.25'], ['0.5'], [null], ['']], [-0.75]],
    [amount, [['.5'], ['2.'], ['+1e1'], ['1e-3']], [12.501]],
    [[{ name: 'orders', type: 'int8' }], [['9223372036854775807'], ['1']], ['9223372036854775808']],
    [[{ name: 'amount', type: 'double precision' }], [[0.1], [0.2]], [0.3]],
    [amount, [[null]], [null]],
  ];
  for (const [cols, rows, expected] of cases) {
    assert.deepEqual(previewTotals(cols, rows), expected, JSON.stringify(rows));
    assert.deepEqual(JSON.parse(JSON.stringify(context.previewTotals(cols, rows))), expected, `template copy: ${JSON.stringify(rows)}`);
  }
  assert.deepEqual(columnTotals(amount, [['12345678901234.56'], ['0.01']]), [{ column: 'amount', total: '12345678901234.57' }]);
});
