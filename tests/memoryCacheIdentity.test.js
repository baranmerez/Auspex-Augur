import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaMemory } from '../src/memory/store.js';

// A fixed modification time, so two different versions of a file carry the
// same mtime, as they do when two writes land in one clock tick.
const fixed = new Date('2026-01-01T00:00:00Z');
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-mem-cache-'));
const notesFile = root => path.join(root, 'example', 'notes.json');
const freeze = file => fs.utimesSync(file, fixed, fixed);

test('a reader sees a replacement with the same size and mtime (cache keyed on file identity)', () => {
  const root = tempRoot();
  const a = new SchemaMemory(root);
  const b = new SchemaMemory(root);
  a.writeNotes('example', { nextId: 1, notes: [] });
  freeze(notesFile(root));
  assert.equal(a.readNotes('example').nextId, 1, 'A caches the first version');
  b.writeNotes('example', { nextId: 2, notes: [] }); // same length, new file
  freeze(notesFile(root));
  assert.equal(JSON.parse(fs.readFileSync(notesFile(root), 'utf8')).nextId, 2, 'disk has the new version');
  assert.equal(a.readNotes('example').nextId, 2);
});

test('read-modify-write across two instances keeps both notes and unique ids', () => {
  const root = tempRoot();
  const a = new SchemaMemory(root);
  const b = new SchemaMemory(root);
  // Padding lets B add a note without changing the file size.
  a.writeNotes('example', { nextId: 1, notes: [], pad: 'p'.repeat(400) });
  freeze(notesFile(root));
  a.readNotes('example'); // A caches the empty list
  b.locked('example', () => {
    const before = fs.statSync(notesFile(root)).size;
    const data = b.readNotes('example');
    data.notes.push({ id: 1, kind: 'rule', schema: null, table: null, column: null, text: 'Rule from B.', source: 'user', status: 'active', createdAt: fixed.toISOString() });
    data.nextId = 2;
    data.pad = '';
    const grown = Buffer.byteLength(`${JSON.stringify(data, null, 1)}\n`);
    data.pad = 'p'.repeat(before - grown);
    b.writeNotes('example', data);
    assert.equal(fs.statSync(notesFile(root)).size, before, 'same size as the version A cached');
  });
  freeze(notesFile(root));
  const added = a.addNote('example', { kind: 'rule', text: 'Rule from A.' });
  const notes = new SchemaMemory(root).readNotes('example').notes;
  assert.deepEqual(notes.map(n => n.text).sort(), ['Rule from A.', 'Rule from B.']);
  assert.equal(new Set(notes.map(n => n.id)).size, 2, 'ids stay unique');
  assert.equal(added.id, 2);
});
