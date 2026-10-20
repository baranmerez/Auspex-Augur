import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaMemory } from '../src/memory/store.js';

const modeOf = file => fs.statSync(file).mode & 0o777;

test('schema memory files and parent directories stay private on Unix', { skip: process.platform === 'win32' }, () => {
  const previousUmask = process.umask(0o022);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-example-memory-'));
  try {
    const root = path.join(temporary, 'memory');
    const memory = new SchemaMemory(root);
    const tableFile = memory.tablePath('exampledb', 'example', 'orders');
    const notesFile = path.join(memory.profileDir('exampledb'), 'notes.json');
    const logFile = path.join(memory.profileDir('exampledb'), 'changelog.jsonl');
    const dirs = [root, memory.profileDir('exampledb'), path.join(memory.profileDir('exampledb'), 'tables'), path.dirname(tableFile)];
    const files = [tableFile, notesFile, logFile];

    memory.writeJson(tableFile, { schema: 'example', table: 'orders', description: 'synthetic' });
    memory.writeNotes('exampledb', { nextId: 1, notes: [] });
    memory.appendChangelog('exampledb', { event: 'synthetic', table: 'example.orders' });
    for (const dir of dirs) assert.equal(modeOf(dir), 0o700, `private directory: ${dir}`);
    for (const file of files) assert.equal(modeOf(file), 0o600, `private file: ${file}`);

    // A later write must also repair older permissive memory folders and files.
    for (const dir of dirs) fs.chmodSync(dir, 0o755);
    fs.chmodSync(tableFile, 0o644);
    fs.chmodSync(logFile, 0o644);
    memory.writeJson(tableFile, { schema: 'example', table: 'orders', description: 'updated' });
    memory.appendChangelog('exampledb', { event: 'updated' });

    for (const dir of dirs) assert.equal(modeOf(dir), 0o700, `repaired directory: ${dir}`);
    assert.equal(modeOf(tableFile), 0o600);
    assert.equal(modeOf(logFile), 0o600);
    assert.deepEqual(memory.readChangelog('exampledb').map(item => item.event), ['synthetic', 'updated']);
  } finally {
    process.umask(previousUmask);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
