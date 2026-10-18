import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaMemory, MemoryError, diffTable, changeText, recordFromDescribe, validateScoreInput } from '../src/memory/store.js';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1) + (clock++) * 60000).toISOString();
const col = (column, attnum, type = 'integer') => ({ column, attnum, type, not_null: false, default: null, comment: null });

// Shape of catalog.triggerFromRow.
const trigger = (name, extra = {}) => ({
  name, timing: 'BEFORE', events: ['INSERT', 'UPDATE'], level: 'ROW', enabled: 'enabled', function: 'example.orders_before_write',
  whenCondition: null, definition: `CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON example.orders FOR EACH ROW EXECUTE FUNCTION example.orders_before_write()`, ...extra,
});

function ordersDescribe(triggers) {
  return {
    profile: 'example', relation: 'example.orders', schema: 'example', table: 'orders', kind: 'table', oid: 3001, estimated_rows: 10, comment: null,
    columns: [col('order_id', 1), col('status_code', 2)],
    constraints: [], indexes: [], referencedBy: [],
    ...(triggers ? { triggers } : {}),
  };
}

const memory = () => new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-trg-')), { now });
const summaryInput = (triggers, columns) => ({ schema: 'example', table: 'orders', triggers, ...(columns ? { columns } : {}) });

test('the record keeps trigger fields from describe_table', () => {
  const rec = recordFromDescribe(ordersDescribe([trigger('orders_check', { whenCondition: '(new.status_code IS NOT NULL)', constraintTrigger: true })]));
  assert.deepEqual(rec.triggers, [{
    name: 'orders_check', timing: 'BEFORE', events: ['INSERT', 'UPDATE'], level: 'ROW', enabled: 'enabled', function: 'example.orders_before_write',
    when: '(new.status_code IS NOT NULL)', definition: trigger('orders_check').definition, constraintTrigger: true,
  }]);
  assert.equal('triggers' in recordFromDescribe(ordersDescribe()), false, 'no field when the describe result had none');
});

test('trigger changes are diffed: added, dropped, changed and enabled-changed', () => {
  const before = recordFromDescribe(ordersDescribe([trigger('a'), trigger('b'), trigger('c')]));
  const after = recordFromDescribe(ordersDescribe([
    trigger('a', { definition: 'CREATE TRIGGER a AFTER INSERT ON example.orders FOR EACH ROW EXECUTE FUNCTION example.log_order()' }),
    trigger('b', { enabled: 'disabled' }),
    trigger('d'),
  ]));
  const changes = diffTable(before, after);
  assert.deepEqual(changes.map(c => c.change).sort(), ['trigger-added', 'trigger-changed', 'trigger-dropped', 'trigger-enabled-changed']);
  const texts = changes.map(changeText);
  assert.ok(texts.includes('trigger b enabled -> disabled'));
  assert.ok(texts.includes('trigger d added'));
  assert.ok(texts.includes('trigger c dropped'));
  assert.ok(texts.includes('trigger a changed'));
});

test('a legacy record without triggers produces no false change, and the next describe stores them', () => {
  const mem = memory();
  mem.recordDescribe(ordersDescribe());
  const legacy = mem.readTable('example', 'example', 'orders');
  assert.equal(legacy.triggers, undefined);
  const result = mem.recordDescribe(ordersDescribe([trigger('orders_check')]));
  assert.equal(result.changesSinceLast, undefined, 'no "trigger added" for a legacy record');
  assert.equal(mem.readTable('example', 'example', 'orders').triggers.length, 1);
  const dropped = mem.recordDescribe(ordersDescribe([]));
  assert.deepEqual(dropped.changesSinceLast, ['trigger orders_check dropped']);
});

test('trigger summaries are validated: one line, at most 200 characters, known keys only', () => {
  const bad = [
    [summaryInput([{ name: 'orders_check', summary: 'line one\nline two' }]), /one line/],
    [summaryInput([{ name: 'orders_check', summary: 'x'.repeat(201) }]), /longer than 200/],
    [summaryInput([{ name: 'orders_check', summary: ' ' }]), /summary must be a non-empty/],
    [summaryInput([{ name: 'orders_check', summary: 'ok', source: 'BEGIN ... END' }]), /unknown keys: source/],
    [summaryInput([{ name: 'orders_check', summary: 'a' }, { name: 'orders_check', summary: 'b' }]), /listed twice/],
  ];
  for (const [value, message] of bad) assert.throws(() => validateScoreInput(value), err => err instanceof MemoryError && message.test(err.message), message.source);
});

test('summaries need recorded triggers, are kept across describes, marked stale on change and never store function source', () => {
  const mem = memory();
  mem.recordDescribe(ordersDescribe());
  assert.throws(() => mem.scoreColumns('example', summaryInput([{ name: 'orders_check', summary: 'Checks the status code.' }])), err => err.errorCode === 'PRECONDITION_FAILED');
  mem.recordDescribe(ordersDescribe([trigger('orders_check')]));
  assert.throws(() => mem.scoreColumns('example', summaryInput([{ name: 'missing_trigger', summary: 'x' }])), /missing_trigger/);

  const saved = mem.scoreColumns('example', summaryInput([{ name: 'orders_check', summary: 'Rejects rows whose status code is not in the lookup table.' }]));
  assert.equal(saved.triggersSummarized, 1);
  assert.equal(saved.scored, 0);
  const rec = mem.readTable('example', 'example', 'orders');
  assert.equal(rec.columnScores, undefined, 'a summary-only call scores no column');

  let k = mem.knowledge('example', 'example', 'orders');
  assert.equal(k.triggers[0].summary, 'Rejects rows whose status code is not in the lookup table.');
  assert.equal(k.triggers[0].summaryStale, undefined);
  const view = JSON.parse(fs.readFileSync(path.join(mem.root, 'example', 'graph.json'), 'utf8'));
  assert.equal(view.nodes.find(n => n.id === 'example.orders').triggers[0].summary, k.triggers[0].summary);

  mem.recordDescribe(ordersDescribe([trigger('orders_check', { definition: 'CREATE TRIGGER orders_check AFTER INSERT ON example.orders FOR EACH ROW EXECUTE FUNCTION example.other()' })]));
  k = mem.knowledge('example', 'example', 'orders');
  assert.equal(k.triggers[0].summaryStale, true);
  assert.equal(k.triggers[0].summary, 'Rejects rows whose status code is not in the lookup table.');

  const stored = fs.readFileSync(mem.tablePath('example', 'example', 'orders'), 'utf8');
  assert.ok(!/\$\$|BEGIN|RETURN NEW/i.test(stored), 'no function source in the record');
});

test('a trigger change recorded through describe_tables shows in changesSinceLast', () => {
  const mem = memory();
  mem.recordDescribeMany('example', [ordersDescribe([trigger('orders_check')])]);
  const [result] = mem.recordDescribeMany('example', [ordersDescribe([trigger('orders_check', { enabled: 'disabled' }), trigger('orders_audit')])]);
  assert.deepEqual(result.changesSinceLast.sort(), ['trigger orders_audit added', 'trigger orders_check enabled -> disabled']);
});
