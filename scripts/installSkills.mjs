#!/usr/bin/env node
// Copies the workflow skills in <repo>/skills/<name>/ into the agent skills
// folder: ~/.claude/skills by default, or AUSPEX_SKILLS_TARGET, or
// --target <dir> (also as the first plain argument).
// When a skill already exists there with different content and --force is
// not given, nothing at all is written and the exit code is 1; --force
// replaces such a skill folder. Line-ending differences alone do not count as
// different content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

function parseArgs(argv) {
  const opts = { force: false, target: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--target') opts.target = argv[++i];
    else if (a.startsWith('--target=')) opts.target = a.slice('--target='.length);
    else if (!a.startsWith('-') && !opts.target) opts.target = a;
    else throw new Error(`Unknown argument: ${a}`);
    if (opts.target === undefined || opts.target === '') throw new Error('--target needs a directory.');
  }
  return opts;
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

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`skills:install: ${err.message}\nUsage: npm run skills:install -- [--target <dir>] [--force]\n`);
    return 2;
  }
  const target = path.resolve(opts.target || process.env.AUSPEX_SKILLS_TARGET || path.join(os.homedir(), '.claude', 'skills'));
  const skills = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(sourceDir, e.name, 'SKILL.md')))
    .map(e => e.name).sort();
  if (!skills.length) {
    process.stderr.write(`skills:install: no skills found in ${sourceDir}\n`);
    return 1;
  }

  const plan = skills.map(name => {
    const src = path.join(sourceDir, name);
    const dst = path.join(target, name);
    if (!fs.existsSync(dst)) return { name, src, dst, action: 'install' };
    const diff = differences(src, dst);
    return { name, src, dst, diff, action: diff.length ? 'replace' : 'unchanged' };
  });

  const conflicts = plan.filter(p => p.action === 'replace');
  if (conflicts.length && !opts.force) {
    process.stderr.write(`skills:install: refused, nothing written. These skills already exist in ${target} with different content:\n`);
    for (const c of conflicts) process.stderr.write(`  ${c.name}: ${c.diff.join(', ')}\n`);
    process.stderr.write('Compare them, then run again with --force to replace them.\n');
    return 1;
  }

  fs.mkdirSync(target, { recursive: true });
  for (const p of plan) {
    if (p.action === 'replace') fs.rmSync(p.dst, { recursive: true, force: true });
    if (p.action !== 'unchanged') fs.cpSync(p.src, p.dst, { recursive: true });
    const done = { install: 'installed', replace: 'replaced', unchanged: 'unchanged' }[p.action];
    process.stdout.write(`${done.padEnd(9)} ${p.name} -> ${p.dst}\n`);
  }
  return 0;
}

process.exitCode = main();
