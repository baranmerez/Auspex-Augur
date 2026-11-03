import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// stageCli.js install-skills as the desktop app's Setup screen runs it: a
// temporary home and skills folder, so the real ~/.claude/skills is never touched.
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'stageCli.js');
const skills = fs.readdirSync(path.join(repo, 'skills')).filter(n => fs.existsSync(path.join(repo, 'skills', n, 'SKILL.md'))).sort();

function run(home, args = []) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, AUSPEX_HOME: path.join(home, '.auspex') };
  for (const k of ['AUSPEX_SKILLS_TARGET', 'AUSPEX_LOG_DIR', 'AUSPEX_DATA_DIR', 'AUSPEX_PROFILES_FILE']) delete env[k];
  const res = spawnSync(process.execPath, [cli, 'install-skills', ...args], { env, encoding: 'utf8' });
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `one JSON line: ${res.stdout}${res.stderr}`);
  return { status: res.status, out: JSON.parse(lines[0]) };
}
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-stage-skills-'));
const auditLines = home => {
  const dir = path.join(home, '.auspex', 'logs');
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
};

test('install-skills copies every skill into ~/.claude/skills, then reports them unchanged', () => {
  const home = tempHome();
  const first = run(home);
  assert.equal(first.status, 0, JSON.stringify(first.out));
  assert.equal(first.out.target, path.join(home, '.claude', 'skills'));
  assert.deepEqual(first.out.skills.map(s => [s.name, s.result]), skills.map(n => [n, 'installed']));
  for (const n of skills) assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', n, 'SKILL.md')), n);
  const again = run(home);
  assert.deepEqual(again.out.skills.map(s => s.result), skills.map(() => 'unchanged'));
  const audit = auditLines(home).filter(e => e.tool === 'install_skills');
  assert.equal(audit.length, 2);
  assert.deepEqual([audit[0].source, audit[0].actor, audit[0].installed, audit[1].unchanged], ['desktop', 'desktop', skills.length, skills.length]);
});

test('a differing skill writes nothing without --force true and is replaced with it', () => {
  const home = tempHome();
  const target = path.join(home, '.claude', 'skills');
  const changed = path.join(target, skills[0], 'SKILL.md');
  fs.mkdirSync(path.dirname(changed), { recursive: true });
  fs.writeFileSync(changed, 'my own edits');
  const refused = run(home);
  assert.equal(refused.status, 1);
  assert.equal(refused.out.code, 'SKILLS_CONFLICT');
  assert.deepEqual(refused.out.conflicts.map(c => c.name), [skills[0]]);
  assert.ok(refused.out.conflicts[0].files.includes('SKILL.md'), 'the differing files are named');
  assert.match(refused.out.message, new RegExp(`Nothing written: ${skills[0]} already exist`));
  assert.equal(fs.readFileSync(changed, 'utf8'), 'my own edits', 'the edited skill is kept');
  assert.deepEqual(fs.readdirSync(target), [skills[0]], 'no other skill was written either');
  const forced = run(home, ['--force=true']);
  assert.equal(forced.status, 0, JSON.stringify(forced.out));
  assert.equal(forced.out.skills.find(s => s.name === skills[0]).result, 'replaced');
  assert.equal(fs.readFileSync(changed, 'utf8'), fs.readFileSync(path.join(repo, 'skills', skills[0], 'SKILL.md'), 'utf8'));
});

test('install-skills takes only --force true', () => {
  const home = tempHome();
  for (const args of [['--force=yes'], ['--target=/tmp/x'], ['extra']]) {
    const res = run(home, args);
    assert.equal(res.status, 1, args.join(' '));
    assert.equal(res.out.ok, false);
  }
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'nothing written');
});
