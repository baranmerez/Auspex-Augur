import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs scripts/installSkills.mjs as `npm run skills:install` would, with a
// temporary home, so the real skills folder is never touched.
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'installSkills.mjs');
const skills = fs.readdirSync(path.join(repo, 'skills')).sort();

function run(home, args = [], extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.AUSPEX_SKILLS_TARGET;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
}
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-install-test-'));

test('installs every skill into the home skills folder, then reports them unchanged', () => {
  const home = tempHome();
  const target = path.join(home, '.claude', 'skills');
  const first = run(home);
  assert.equal(first.status, 0, first.stderr);
  for (const name of skills) {
    assert.match(first.stdout, new RegExp(`installed\\s+${name} -> `));
    assert.equal(fs.readFileSync(path.join(target, name, 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(repo, 'skills', name, 'SKILL.md'), 'utf8'));
    assert.ok(fs.readdirSync(path.join(target, name, 'references')).length > 0, `${name} references copied`);
  }
  const again = run(home);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.match(/unchanged/g).length, skills.length);
});

test('refuses to overwrite a differing skill without --force and writes nothing; --force replaces it', () => {
  const home = tempHome();
  const target = path.join(home, '.claude', 'skills');
  const own = path.join(target, skills[0], 'SKILL.md');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, 'my own edits');
  fs.writeFileSync(path.join(target, skills[0], 'extra.md'), 'extra');

  const refused = run(home);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refused, nothing written/);
  assert.match(refused.stderr, new RegExp(`${skills[0]}: .*SKILL\\.md`));
  assert.match(refused.stderr, /extra\.md/);
  assert.equal(fs.readFileSync(own, 'utf8'), 'my own edits');
  for (const name of skills.slice(1)) assert.ok(!fs.existsSync(path.join(target, name)), `${name} not written`);

  const forced = run(home, ['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, new RegExp(`replaced\\s+${skills[0]} -> `));
  assert.equal(fs.readFileSync(own, 'utf8'), fs.readFileSync(path.join(repo, 'skills', skills[0], 'SKILL.md'), 'utf8'));
  assert.ok(!fs.existsSync(path.join(target, skills[0], 'extra.md')), 'stale files removed on replace');
});

test('line endings alone are not a difference', () => {
  const home = tempHome();
  assert.equal(run(home).status, 0);
  const file = path.join(home, '.claude', 'skills', skills[0], 'SKILL.md');
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(file, text.includes('\r') ? text : text.replace(/\n/g, '\r\n'));
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`unchanged\\s+${skills[0]}`));
});

test('target from --target, a plain argument or AUSPEX_SKILLS_TARGET; bad arguments fail', () => {
  const home = tempHome();
  for (const [args, env, dir] of [
    [['--target', path.join(home, 'a')], {}, 'a'],
    [[`--target=${path.join(home, 'b')}`], {}, 'b'],
    [[path.join(home, 'c')], {}, 'c'],
    [[], { AUSPEX_SKILLS_TARGET: path.join(home, 'd') }, 'd'],
  ]) {
    const r = run(home, args, env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(home, dir, skills[0], 'SKILL.md')), `installed into ${dir}`);
  }
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'home skills folder untouched');
  const bad = run(home, ['--nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown argument: --nope/);
  assert.equal(run(home, ['--target']).status, 2);
});
