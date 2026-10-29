import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaMemory } from '../src/memory/store.js';
import { ordersDescribe, customersDescribe } from './fixtures/exampleMemory.js';

// #145 / EN02: the canonical write is the commit point. A failure in a
// derived step afterwards (graph.json, changelog) returns the committed
// result with a repair field, marks the graph stale, and the next rebuild
// repairs it without repeating the mutation.
const profile = 'exampledb';
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 1) + (clock++) * 60000).toISOString();

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-mem-repair-'));
  const mem = new SchemaMemory(dir, { now });
  mem.recordDescribe(ordersDescribe(profile));
  return { dir, mem, graphFile: path.join(dir, profile, 'graph.json'), staleFile: path.join(dir, profile, 'graph.stale') };
}

// The next graph rebuild fails with a synthetic EACCES, once.
function failNextRebuild(mem) {
  const original = mem.rebuildViewUnlocked;
  mem.rebuildViewUnlocked = function failing() {
    mem.rebuildViewUnlocked = original;
    throw Object.assign(new Error('EACCES: permission denied, open graph.json'), { code: 'EACCES', syscall: 'open' });
  };
}

const graphNotes = file => JSON.parse(fs.readFileSync(file, 'utf8')).notes;
const note = { kind: 'observation', schema: 'example', table: 'orders', text: 'Example observation' };

test('remember add: a failed graph rebuild returns the stored note with repair; a later rebuild repairs it without a second note', () => {
  const { mem, graphFile, staleFile } = setup();
  failNextRebuild(mem);
  const added = mem.addNote(profile, note);
  assert.equal(added.id, 1);
  assert.equal(added.text, 'Example observation');
  assert.deepEqual(added.repair, { graph: 'stale', error: { code: 'DISK_ERROR', message: 'EACCES (open)' } });
  assert.deepEqual(mem.readNotes(profile).notes.map(n => n.id), [1], 'one stored note');
  assert.ok(fs.existsSync(staleFile), 'the graph is marked stale durably');
  assert.deepEqual(graphNotes(graphFile), [], 'graph.json still has the old state');
  assert.ok(!JSON.stringify(added.repair).includes('Example observation'), 'no note text in repair');

  // Self-heal on the next graph read, without repeating the add.
  mem.graph(profile);
  assert.ok(!fs.existsSync(staleFile));
  assert.deepEqual(graphNotes(graphFile).map(n => n.id), [1]);
  assert.deepEqual(mem.readNotes(profile).notes.map(n => n.id), [1]);
});

test('a failure before the commit point throws and stores nothing', () => {
  const { mem, staleFile } = setup();
  const original = mem.writeNotes;
  mem.writeNotes = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  assert.throws(() => mem.addNote(profile, note), /EACCES/);
  mem.writeNotes = original;
  assert.deepEqual(mem.readNotes(profile).notes, []);
  assert.ok(!fs.existsSync(staleFile));
  assert.throws(() => mem.addNote(profile, { ...note, kind: 'nonsense' }), /kind must be/);
  assert.deepEqual(mem.readNotes(profile).notes, []);
});

test('confirm and archive return the changed note with repair after a failed rebuild', () => {
  const { mem } = setup();
  const { id } = mem.addNote(profile, { ...note, kind: 'inference' });
  failNextRebuild(mem);
  const confirmed = mem.confirmNote(profile, id, 'rule');
  assert.equal(confirmed.kind, 'rule');
  assert.equal(confirmed.repair.graph, 'stale');
  failNextRebuild(mem);
  const archived = mem.archiveNote(profile, id, 'Example reason');
  assert.equal(archived.status, 'archived');
  assert.equal(archived.repair.graph, 'stale');
  assert.equal(mem.readNotes(profile).notes[0].status, 'archived');
});

test('score_columns: scores stay stored, repair reports the graph and a failed scanned-files write', () => {
  const { mem, graphFile, staleFile } = setup();
  failNextRebuild(mem);
  mem.recordScannedUnlocked = () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC', syscall: 'write' }); };
  const res = mem.scoreColumns(profile, {
    schema: 'example', table: 'orders',
    columns: [{ name: 'order_id', score: 5, roles: ['key'], reason: 'Main key', sources: 3 }],
    scannedFiles: [{ root: 'example_scripts', path: 'example/reports/example_01.sql', sha256: 'a'.repeat(64) }],
  });
  assert.equal(res.scored, 1);
  assert.deepEqual(res.repair, { scannedFiles: 'failed', graph: 'stale', error: { code: 'DISK_ERROR', message: 'ENOSPC (write)' } });
  assert.equal(mem.readTable(profile, 'example', 'orders').columnScores.order_id.agent.score, 5);
  assert.ok(fs.existsSync(staleFile));
  // The next change rebuilds the graph and clears the mark.
  mem.addNote(profile, note);
  assert.ok(!fs.existsSync(staleFile));
  const node = JSON.parse(fs.readFileSync(graphFile, 'utf8')).nodes.find(n => n.id === 'example.orders');
  assert.equal(node.columnScores.order_id.score, 5);
});

test('describe: the record is stored and changesSinceLast returned; changelog and graph failures go into repair', () => {
  const { mem, staleFile } = setup();
  failNextRebuild(mem);
  const res = mem.recordDescribe(customersDescribe(profile));
  assert.equal(res.recorded, 'first time');
  assert.equal(res.repair.graph, 'stale');
  assert.ok(mem.readTable(profile, 'example', 'customers').describedAt);
  assert.ok(fs.existsSync(staleFile));

  const many = new SchemaMemory(mem.root, { now });
  failNextRebuild(many);
  const list = many.recordDescribeMany(profile, [ordersDescribe(profile), customersDescribe(profile)]);
  assert.deepEqual(list.map(r => [r.recorded, r.repair?.graph]), [['updated', 'stale'], ['updated', 'stale']]);

  const changelog = path.join(mem.root, profile, 'changelog.jsonl');
  fs.rmSync(changelog, { force: true });
  fs.mkdirSync(changelog); // appending to a folder fails
  const third = mem.recordDescribe({ ...customersDescribe(profile), table: 'shipments', relation: 'example.shipments', oid: 2003 });
  assert.equal(third.recorded, 'first time');
  assert.equal(third.repair.changelog, 'failed');
  assert.equal(third.repair.graph, 'stale', 'the unreadable changelog also stops the rebuild');
  assert.match(third.repair.error.message, /^E[A-Z]+/, JSON.stringify(third.repair.error));
  assert.ok(mem.readTable(profile, 'example', 'shipments').describedAt, 'the record is stored');
  // Once the changelog is readable again, the next graph read repairs the graph.
  fs.rmSync(changelog, { recursive: true });
  mem.graph(profile);
  assert.ok(!fs.existsSync(staleFile));
  assert.ok(JSON.parse(fs.readFileSync(path.join(mem.root, profile, 'graph.json'), 'utf8')).nodes.some(n => n.id === 'example.shipments'));
});

test('derived result sections that cannot be computed are omitted, not thrown', () => {
  const { mem } = setup();
  mem.notesSection = () => { throw new SyntaxError('Unexpected token in JSON: "secret note"'); };
  const res = mem.recordSeen(profile, [{ schema: 'example', table: 'orders', columns: ['order_id'] }]);
  assert.deepEqual(res.repair, { sections: 'omitted', error: { code: 'INTERNAL', message: 'a memory file is not valid JSON' } });
  assert.equal(mem.readTable(profile, 'example', 'orders').usedColumns.order_id.count, 1);
});

test('when even the stale mark cannot be written, graph.json is removed so it never looks current', () => {
  const { mem, graphFile } = setup();
  failNextRebuild(mem);
  mem.markGraphStale = function markFails(p, error) {
    fs.rmSync(graphFile, { force: true });
    return false;
  };
  const added = mem.addNote(profile, note);
  assert.deepEqual([added.repair.graph, added.repair.marker], ['stale', 'failed']);
  assert.ok(!fs.existsSync(graphFile));
});
