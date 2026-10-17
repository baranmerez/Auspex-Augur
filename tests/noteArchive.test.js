import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaMemory } from '../src/memory/store.js';
import { validateArchiveInput, archiveNoteFor, reasonProblem, maxReasonLength } from '../src/memory/noteArchive.js';

// The shared archive logic (src/memory/noteArchive.js) and the desktop path
// through src/stageCli.js archive-note.
const profile = 'exampledb';
const cli = fileURLToPath(new URL('../src/stageCli.js', import.meta.url));

function seeded() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-note-archive-'));
  const memory = new SchemaMemory(path.join(home, 'memory'));
  memory.addNote(profile, { kind: 'rule', schema: 'example', table: 'orders', text: 'Only status_code 1 to 5 are live orders.' });
  memory.addNote(profile, { kind: 'observation', schema: 'example', table: 'customers', text: 'customer_id is unique.', evidence: { figures: { rows: 40, distinct: 40 } } });
  return { home, memory };
}

test('archive input: exactly profile, id and reason, each in its format', () => {
  assert.deepEqual(validateArchiveInput({ profile, id: 3, reason: 'Outdated' }), { profile, id: 3, reason: 'Outdated' });
  const bad = [null, [], 'x', {}, { profile, id: 3 }, { profile, id: 3, reason: 'x', by: 'me' }, { profile: 'Example', id: 3, reason: 'x' },
    { profile, id: '3', reason: 'x' }, { profile, id: 0, reason: 'x' }, { profile, id: 2 ** 53, reason: 'x' }, { profile, id: 3, reason: '' }];
  for (const b of bad) assert.throws(() => validateArchiveInput(b), err => err.status === 400, JSON.stringify(b));
  assert.equal(reasonProblem('a'.repeat(maxReasonLength)), null);
  assert.equal(reasonProblem('Eski kural; İade süreci değişti'), null, 'Turkish text is fine');
  for (const r of ['a'.repeat(maxReasonLength + 1), ' x', 'x ', 'a\nb', 'a\tb', 'a\u0085b', 'a\u007fb', ' ', null]) {
    assert.notEqual(reasonProblem(r), null, JSON.stringify(r));
  }
});

test('the store archive runs inside the profile lock, with the view rebuilt', () => {
  const { home, memory } = seeded();
  try {
    let depth = 0;
    const calls = [];
    const locked = memory.locked.bind(memory);
    memory.locked = (p, fn) => locked(p, () => { depth++; try { return fn(); } finally { depth--; } });
    const archive = memory.archiveNoteUnlocked.bind(memory);
    memory.archiveNoteUnlocked = (...args) => { calls.push(depth); return archive(...args); };
    const note = archiveNoteFor(memory, { profile, id: 1, reason: 'Outdated' });
    assert.equal(note.status, 'archived');
    assert.deepEqual(calls, [1], 'archiveNoteUnlocked called once, under the lock');
    const view = JSON.parse(fs.readFileSync(path.join(home, 'memory', profile, 'graph.json'), 'utf8'));
    assert.equal(view.notes.find(n => n.id === 1).status, 'archived');
    assert.equal(view.summary.notes, 1);
    assert.throws(() => archiveNoteFor(memory, { profile, id: 1, reason: 'Again' }), err => err.status === 409 && err.errorCode === 'PRECONDITION_FAILED');
    assert.throws(() => archiveNoteFor(memory, { profile, id: 9, reason: 'Outdated' }), err => err.status === 404 && err.errorCode === 'NOT_FOUND');
    assert.throws(() => archiveNoteFor(memory, { profile: 'testdb', id: 1, reason: 'Outdated' }), err => err.status === 404);
    assert.equal(fs.existsSync(path.join(home, 'memory', 'testdb')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function run(home, args) {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json') };
  for (const k of ['AUSPEX_LIBRARY_DIR', 'AUSPEX_LOG_DIR', 'AUSPEX_MEMORY_DIR', 'AUSPEX_DATA_DIR']) delete env[k];
  const res = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `one JSON line: ${res.stdout}${res.stderr}`);
  return { status: res.status, out: JSON.parse(lines[0]) };
}
function auditEntries(home) {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)).map(l => JSON.parse(l));
}

test('stageCli archive-note validates its arguments, archives once and audits as desktop', () => {
  const { home, memory } = seeded();
  try {
    const bad = [
      [],
      ['--profile', profile, '--id', '1'],
      ['--profile', profile, '--id', '1', '--reason', 'x', '--by', 'me'],
      ['--profile', profile, '--id', '1', '--reason', 'x', '--id', '2'],
      ['--profile', profile, '--id', '01', '--reason', 'x'],
      ['--profile', profile, '--id', '1e3', '--reason', 'x'],
      ['--profile', profile, '--id', '-1', '--reason', 'x'],
      ['--profile', '../x', '--id', '1', '--reason', 'x'],
      ['--profile', profile, '--id', '1', '--reason', ''],
      ['--profile', profile, '--id', '1', '--reason', 'a'.repeat(201)],
      ['--profile', profile, '--id', '1', '--reason', 'a\nb'],
      ['--profile', profile, 'positional', '--id', '1', '--reason', 'x'],
    ];
    for (const args of bad) {
      const { status, out } = run(home, ['archive-note', ...args]);
      assert.equal(status, 1, JSON.stringify(args));
      assert.equal(out.ok, false);
      assert.ok(['INVALID_INPUT', 'PROFILE_INVALID'].includes(out.code), `${out.code} ${JSON.stringify(args)}`);
    }
    assert.equal(memory.readNotes(profile).notes[0].status, 'active');
    const ok = run(home, ['archive-note', `--profile=${profile}`, '--id=1', '--reason=Replaced by a newer rule']);
    assert.equal(ok.status, 0, JSON.stringify(ok.out));
    assert.deepEqual([ok.out.ok, ok.out.note.id, ok.out.note.status], [true, 1, 'archived']);
    assert.equal(memory.readNotes(profile).notes[0].archivedReason, 'Replaced by a newer rule');
    assert.equal(run(home, ['archive-note', '--profile', profile, '--id', '1', '--reason', 'Again']).out.code, 'PRECONDITION_FAILED');
    assert.equal(run(home, ['archive-note', '--profile', profile, '--id', '7', '--reason', 'Outdated']).out.code, 'NOT_FOUND');
    const entries = auditEntries(home);
    assert.equal(entries.length, bad.length + 3);
    assert.ok(entries.every(e => e.source === 'desktop' && e.actor === 'desktop' && e.tool === 'remember' && e.action === 'archive'));
    const done = entries.find(e => !e.error);
    assert.deepEqual([done.profile, done.noteId, done.noteStatus], [profile, 1, 'archived']);
    assert.ok(!JSON.stringify(entries).includes('Replaced by a newer rule'), 'the reason is not logged');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
