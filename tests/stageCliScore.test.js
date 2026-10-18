import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaMemory } from '../src/memory/store.js';
import { validateUserScoreInput } from '../src/memory/userScore.js';
import { seedExampleMemory } from './fixtures/exampleMemory.js';

// src/stageCli.js score-column as the desktop app runs it (the Rust command
// score_column passes --key=value arguments after the same checks; see
// score_requests_are_checked_before_spawning in desktop/src-tauri/src/main.rs).
const cli = fileURLToPath(new URL('../src/stageCli.js', import.meta.url));
let home;
const profile = 'exampledb';

function run(args) {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json') };
  for (const k of ['AUSPEX_LIBRARY_DIR', 'AUSPEX_LOG_DIR', 'AUSPEX_MEMORY_DIR', 'AUSPEX_DATA_DIR']) delete env[k];
  const res = spawnSync(process.execPath, [cli, 'score-column', ...args], { env, encoding: 'utf8' });
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `one JSON line: ${res.stdout}${res.stderr}`);
  return { status: res.status, out: JSON.parse(lines[0]) };
}
const base = (column = 'amount') => [`--profile=${profile}`, '--schema=example', '--table=orders', `--column=${column}`];
const scoreOf = column => new SchemaMemory(path.join(home, 'memory')).readTable(profile, 'example', 'orders').columnScores[column];
function auditEntries() {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)).map(l => JSON.parse(l));
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-stage-cli-score-'));
  seedExampleMemory(path.join(home, 'memory'), profile);
});

after(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

// The Rust checks (score_column_args) and these must agree: each case is
// refused by the CLI with the same code the Rust test expects.
test('validation parity with the desktop command: the same requests are refused', () => {
  const before = JSON.stringify(new SchemaMemory(path.join(home, 'memory')).readTable(profile, 'example', 'orders').columnScores);
  const cases = [
    [['--profile=Example', '--schema=example', '--table=orders', '--column=amount', '--score=3'], 'PROFILE_INVALID'],
    ...['', 'two\nlines', 'del\u007fx', 'c1\u0085x', 'a'.repeat(64), 'ş'.repeat(32)].flatMap(bad => [
      [[`--profile=${profile}`, '--schema=example', `--table=${bad}`, '--column=amount', '--score=3'], 'INVALID_INPUT'],
      [[...base(bad), '--score=3'], 'INVALID_INPUT'],
    ]),
    [[...base(), '--score=0'], 'INVALID_INPUT'], [[...base(), '--score=6'], 'INVALID_INPUT'], [[...base(), '--score=-1'], 'INVALID_INPUT'],
    [[...base(), '--score=2.5'], 'INVALID_INPUT'], [[...base(), '--score=03'], 'INVALID_INPUT'],
    [base(), 'INVALID_INPUT'],
    [[...base(), '--score=3', '--clear=true'], 'INVALID_INPUT'],
    [[...base(), '--clear=false'], 'INVALID_INPUT'],
    [[...base(), '--clear=true', '--roles='], 'INVALID_INPUT'],
    [[...base(), '--score=3', '--roles=owner'], 'INVALID_INPUT'],
    [[...base(), '--score=3', '--roles=join,join'], 'INVALID_INPUT'],
    [[...base(), '--score=3', '--reason=free text'], 'INVALID_INPUT'],
    [[...base(), '--score=3', '--score=4'], 'INVALID_INPUT'],
    [[`--profile=${profile}`, '--schema=example', '--table=orders', '--score=3'], 'INVALID_INPUT'],
  ];
  for (const [args, code] of cases) {
    const { status, out } = run(args);
    assert.equal(status, 1, JSON.stringify(args));
    assert.deepEqual([out.ok, out.code], [false, code], JSON.stringify(args));
  }
  assert.equal(JSON.stringify(new SchemaMemory(path.join(home, 'memory')).readTable(profile, 'example', 'orders').columnScores), before);
});

test('the accepted forms match the desktop command: 62-byte names, empty roles, clear', () => {
  assert.deepEqual({ ...validateUserScoreInput({ profile, schema: 'example', table: 'orders', column: 'ş'.repeat(31), score: 3 }) }.column, 'ş'.repeat(31));
  assert.throws(() => validateUserScoreInput({ profile, schema: 'example', table: 'orders', column: 'ş'.repeat(32), score: 3 }));
  const { status, out } = run([...base(), '--score=1', '--roles=']);
  assert.equal(status, 0, JSON.stringify(out));
  assert.deepEqual([out.ok, out.score, out.scoreBy], [true, 1, 'user']);
  assert.deepEqual(scoreOf('amount').user.roles, [], 'an empty roles list is stored as given');
});

test('score-column writes the user layer only and clear removes it; 404 and 409 like the viewer', () => {
  const agentBefore = JSON.stringify(scoreOf('order_id').agent);
  let res = run([...base('order_id'), '--score=3', '--roles=filter,key']);
  assert.equal(res.status, 0, JSON.stringify(res.out));
  assert.deepEqual(scoreOf('order_id').user.roles, ['key', 'filter']);
  assert.equal(JSON.stringify(scoreOf('order_id').agent), agentBefore);
  res = run([...base('order_id'), '--clear=true']);
  assert.deepEqual([res.status, res.out.score, res.out.scoreBy], [0, 5, 'agent']);
  assert.equal(run([...base('order_id'), '--clear=true']).out.code, 'PRECONDITION_FAILED');
  assert.equal(run([...base('missing_column'), '--score=3']).out.code, 'NOT_FOUND');
  assert.equal(run(['--profile=otherdb', '--schema=example', '--table=orders', '--column=amount', '--score=3']).out.code, 'NOT_FOUND');
  assert.equal(run([`--profile=${profile}`, '--schema=example', '--table=order_items', '--column=order_id', '--score=3']).out.code, 'PRECONDITION_FAILED');
  assert.equal(fs.existsSync(path.join(home, 'memory', 'otherdb')), false);
});

test('audited as score_columns, layer user, actor desktop, without free text', () => {
  const entries = auditEntries();
  assert.ok(entries.length > 5);
  for (const e of entries) {
    assert.deepEqual([e.tool, e.source, e.actor, e.layer], ['score_columns', 'desktop', 'desktop', 'user']);
    assert.ok(!JSON.stringify(e).includes('free text'), JSON.stringify(e));
  }
  assert.deepEqual(entries.filter(e => !e.error).map(e => [e.action, e.column, e.score ?? null]),
    [['set', 'amount', 1], ['set', 'order_id', 3], ['clear', 'order_id', null]]);
});
