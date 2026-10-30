import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaMemory } from '../src/memory/store.js';

// Regression tests for the external review of the memory repair model
// (F2, F5, F8).
const P = 'exampledb';
const mk = () => new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-mem-review-')));
const graphFile = m => path.join(m.profileDir(P), 'graph.json');

test('F2: an unreadable record fails recordSeen and relation_stats before any write', () => {
  const m = mk();
  m.recordSeen(P, [{ schema: 'example', table: 'orders', columns: ['order_id'] }]);
  const graphBefore = fs.readFileSync(graphFile(m), 'utf8');
  fs.mkdirSync(m.tablePath(P, 'example', 'customers'), { recursive: true }); // unreadable record
  const rels = [{ schema: 'example', table: 'orders', columns: ['customer_id'] }, { schema: 'example', table: 'customers', columns: ['customer_id'] }];
  assert.throws(() => m.recordSeen(P, rels), /EISDIR/);
  assert.equal(m.readTable(P, 'example', 'orders').usedColumns.customer_id, undefined, 'nothing written');
  assert.equal(fs.readFileSync(graphFile(m), 'utf8'), graphBefore);
  assert.equal(m.isGraphStale(P), false, 'nothing changed, nothing stale');
  assert.throws(() => m.recordRelationStats(P, [{ schema: 'example', table: 'orders', estRows: 5, instance: [{ schema: 'example', table: 'customers', tableEstRows: 3 }], dependent: [] }]), /EISDIR/);
  assert.equal(m.readTable(P, 'example', 'orders').estRows, undefined);
});

test('F2: a write that fails after others were written marks the graph stale and says how many were written', () => {
  const m = mk();
  m.recordSeen(P, [{ schema: 'example', table: 'orders', columns: ['order_id'] }]);
  const original = m.writeJson.bind(m);
  let tableWrites = 0;
  m.writeJson = (file, value) => {
    if (file.includes(`${path.sep}tables${path.sep}`) && ++tableWrites === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC', syscall: 'write' });
    return original(file, value);
  };
  const rels = [{ schema: 'example', table: 'orders', columns: ['customer_id'] }, { schema: 'example', table: 'customers', columns: ['customer_id'] }];
  assert.throws(() => m.recordSeen(P, rels), err => err.errorCode === 'DISK_ERROR' && /Only 1 of 2 table records were written/.test(err.message) && err.partialCommit.written === 1);
  m.writeJson = original;
  assert.equal(m.readTable(P, 'example', 'orders').usedColumns.customer_id.count, 1);
  assert.equal(m.isGraphStale(P), true, 'the graph does not look current');
  m.knowledge(P, 'example', 'orders');
  assert.equal(m.isGraphStale(P), false, 'healed by the next read');
});

test('F5: when the rebuild, the marker and the graph removal all fail, this process still treats the graph as stale', () => {
  const m = mk();
  m.addNote(P, { kind: 'rule', schema: 'example', table: 'orders', text: 'old note' });
  const before = fs.readFileSync(graphFile(m), 'utf8');
  const { openSync, rmSync } = fs;
  fs.openSync = (f, ...a) => {
    if (/graph\.(json|stale)/.test(String(f))) throw Object.assign(new Error('EACCES'), { code: 'EACCES', syscall: 'open' });
    return openSync(f, ...a);
  };
  fs.rmSync = (f, ...a) => {
    if (/graph\.json$/.test(String(f))) throw Object.assign(new Error('EPERM'), { code: 'EPERM', syscall: 'unlink' });
    return rmSync(f, ...a);
  };
  let added;
  try {
    added = m.addNote(P, { kind: 'rule', schema: 'example', table: 'orders', text: 'new note' });
  } finally {
    fs.openSync = openSync;
    fs.rmSync = rmSync;
  }
  assert.deepEqual([added.repair.graph, added.repair.marker], ['stale', 'failed']);
  assert.equal(fs.readFileSync(graphFile(m), 'utf8'), before, 'the old graph is still on disk');
  assert.equal(fs.existsSync(m.graphStalePath(P)), false);
  assert.equal(m.isGraphStale(P), true, 'known stale in this process');
  m.knowledge(P, 'example', 'orders');
  assert.equal(m.isGraphStale(P), false);
  assert.ok(JSON.parse(fs.readFileSync(graphFile(m), 'utf8')).notes.some(n => n.text === 'new note'));
});

test('F8: an unreadable older table file after the canonical write never fails the change', () => {
  const m = mk();
  const table = 'orders\u{1F600}';
  m.recordSeen(P, [{ schema: 'example', table, columns: ['order_id'] }]);
  const legacy = m.legacyTablePath(P, 'example', table);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '{ torn');
  const seen = m.recordSeen(P, [{ schema: 'example', table, columns: ['order_id'] }]);
  assert.equal(m.readTable(P, 'example', table).usedColumns.order_id.count, 2);
  assert.equal(seen.repair?.graph, 'stale', 'the torn file only stops the derived graph');
  const described = m.recordDescribeMany(P, [{ schema: 'example', table, kind: 'table', oid: 1, columns: [{ column: 'order_id', type: 'integer' }], constraints: [], indexes: [], referencedBy: [] }]);
  assert.equal(described[0].recorded, 'first time');
  assert.ok(m.readTable(P, 'example', table).describedAt);
  m.scoreColumns(P, { schema: 'example', table, columns: [{ name: 'order_id', score: 5, roles: ['key'], reason: 'Main key', sources: 1 }] });
  assert.equal(m.readTable(P, 'example', table).columnScores.order_id.agent.score, 5);
});

test('a partial multi-record change reaches the report run as memoryError with its code and partialCommit', async () => {
  const { ReportService } = await import('../src/reports/service.js');
  const { MemoryError } = await import('../src/memory/store.js');
  const memory = {
    readTable: () => null,
    recordSeen: () => { throw Object.assign(new MemoryError('Only 1 of 2 table records were written (ENOSPC (write)); the graph is marked stale.', 'DISK_ERROR'), { partialCommit: { written: 1, total: 2 } }); },
  };
  const svc = new ReportService({ resolveProfile: n => n }, fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-mem-review-lib-')), memory);
  const res = svc.learn(P, [{ Plan: { 'Node Type': 'Result' } }], { joins: [] });
  assert.equal(res.memoryErrorCode, 'DISK_ERROR');
  assert.deepEqual(res.partialCommit, { written: 1, total: 2 });
  assert.match(res.memoryError, /Only 1 of 2/);
});

test('N4: an older copy of a table that could not be removed is not listed next to the current record', () => {
  const m = mk();
  const table = 'orders\u{1F600}';
  m.recordSeen(P, [{ schema: 'example', table, columns: ['order_id'] }]);
  const legacy = m.legacyTablePath(P, 'example', table);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const rec = m.readTable(P, 'example', table);
  fs.writeFileSync(legacy, JSON.stringify({ ...rec, constraints: [{ name: 'fk_old', type: 'foreign key', columns: ['customer_id'], references: { schema: 'example', table: 'customers', columns: ['customer_id'] } }] }));
  const { rmSync } = fs;
  fs.rmSync = (f, ...a) => {
    if (String(f) === legacy) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY', syscall: 'unlink' });
    return rmSync(f, ...a);
  };
  try {
    m.recordSeen(P, [{ schema: 'example', table, columns: ['order_id'] }]);
  } finally {
    fs.rmSync = rmSync;
  }
  assert.ok(fs.existsSync(legacy), 'the older copy is still there');
  assert.deepEqual(m.listTables(P).map(t => t.table), [table]);
  const graph = JSON.parse(fs.readFileSync(graphFile(m), 'utf8'));
  assert.deepEqual(graph.edges, [], 'no edge from the older copy\'s foreign key');
});

test('N5: the in-process stale fallback is shared by every instance on the same memory folder, and only that folder', () => {
  const a = mk();
  a.addNote(P, { kind: 'rule', schema: 'example', table: 'orders', text: 'note' });
  const b = mk();
  b.addNote(P, { kind: 'rule', schema: 'example', table: 'orders', text: 'note' });
  a.staleProfiles.add(P);
  assert.equal(new SchemaMemory(a.root).isGraphStale(P), true, 'a second instance on folder A sees it');
  assert.equal(b.isGraphStale(P), false, 'folder B is not stale');
  b.knowledge(P, 'example', 'orders'); // a read on B
  b.rebuildView(P); // and a rebuild on B
  assert.equal(a.isGraphStale(P), true, 'rebuilding B does not clear A');
  assert.equal(new SchemaMemory(a.root).isGraphStale(P), true);
  const other = new SchemaMemory(a.root);
  other.knowledge(P, 'example', 'orders');
  assert.equal(a.isGraphStale(P), false, 'a rebuild on A clears it for every instance on A');
});

test('N6: run_report audit fields carry the memory error code and partial-commit counts, never text', async () => {
  const { memoryAudit } = await import('../src/memory/repairAudit.js');
  const fields = memoryAudit({ memoryError: 'Only 1 of 2 table records were written', memoryErrorCode: 'DISK_ERROR', partialCommit: { written: 1, total: 2 }, memoryRepair: { graph: 'stale', error: { code: 'DISK_ERROR', message: 'EACCES (open)' } } });
  assert.deepEqual(fields, { repair: { graph: 'stale' }, repairErrorCode: 'DISK_ERROR', memoryErrorCode: 'DISK_ERROR', partialCommit: { written: 1, total: 2 } });
  assert.deepEqual(memoryAudit({ stage: 'approved' }), {});
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /sqlHash: r\.sqlHash, \.\.\.memoryAudit\(r\)/, 'the run_report audit projection uses it');
});
