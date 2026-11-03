// Copies the workflow skills in <auspex>/skills/<name>/ into an agent skills
// folder (~/.claude/skills by default, or AUSPEX_SKILLS_TARGET). Shared by
// scripts/installSkills.mjs (npm run skills:install) and the desktop app's
// Setup screen (stageCli.js install-skills).
// When a skill already exists there with different content and force is not
// set, nothing at all is written. Line-ending differences alone do not count
// as different content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const skillsSourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

// The folder the skills go to: an explicit target, else AUSPEX_SKILLS_TARGET,
// else ~/.claude/skills.
export function skillsTarget(target, env = process.env) {
  return path.resolve(target || env.AUSPEX_SKILLS_TARGET || path.join(os.homedir(), '.claude', 'skills'));
}

// Relative paths (with /) of every file below dir, sorted.
function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(path.join(dir, e.name), rel) : [rel];
  }).sort();
}

const normalized = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// Files that differ between two skill folders (missing on either side or
// different content).
function differences(src, dst) {
  const a = listFiles(src);
  const b = listFiles(dst);
  const all = [...new Set([...a, ...b])].sort();
  return all.filter(f => !a.includes(f) || !b.includes(f)
    || normalized(path.join(src, ...f.split('/'))) !== normalized(path.join(dst, ...f.split('/'))));
}

// One entry per skill: { name, src, dst, action: install | replace | unchanged, diff? }.
export function planSkillInstall(target, sourceDir = skillsSourceDir) {
  const skills = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(sourceDir, e.name, 'SKILL.md')))
    .map(e => e.name).sort();
  return skills.map(name => {
    const src = path.join(sourceDir, name);
    const dst = path.join(target, name);
    if (!fs.existsSync(dst)) return { name, src, dst, action: 'install' };
    const diff = differences(src, dst);
    return { name, src, dst, diff, action: diff.length ? 'replace' : 'unchanged' };
  });
}

// Writes the plan. Returns { conflicts } without writing anything when a
// skill differs and force is false, else { done: [{ name, dst, result }] }.
export function applySkillInstall(target, plan, { force = false } = {}) {
  const conflicts = plan.filter(p => p.action === 'replace');
  if (conflicts.length && !force) return { conflicts };
  fs.mkdirSync(target, { recursive: true });
  const done = [];
  for (const p of plan) {
    if (p.action === 'replace') fs.rmSync(p.dst, { recursive: true, force: true });
    if (p.action !== 'unchanged') fs.cpSync(p.src, p.dst, { recursive: true });
    done.push({ name: p.name, dst: p.dst, result: { install: 'installed', replace: 'replaced', unchanged: 'unchanged' }[p.action] });
  }
  return { done };
}
