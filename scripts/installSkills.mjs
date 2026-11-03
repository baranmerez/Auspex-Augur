#!/usr/bin/env node
// Copies the workflow skills in <repo>/skills/<name>/ into the agent skills
// folder: ~/.claude/skills by default, or AUSPEX_SKILLS_TARGET, or
// --target <dir> (also as the first plain argument).
// When a skill already exists there with different content and --force is
// not given, nothing at all is written and the exit code is 1; --force
// replaces such a skill folder. Line-ending differences alone do not count as
// different content. The copy itself is src/skillsInstall.js, which the
// desktop app's Setup screen uses too.
import { skillsSourceDir, skillsTarget, planSkillInstall, applySkillInstall } from '../src/skillsInstall.js';

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

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`skills:install: ${err.message}\nUsage: npm run skills:install -- [--target <dir>] [--force]\n`);
    return 2;
  }
  const target = skillsTarget(opts.target);
  const plan = planSkillInstall(target);
  if (!plan.length) {
    process.stderr.write(`skills:install: no skills found in ${skillsSourceDir}\n`);
    return 1;
  }
  const { conflicts, done } = applySkillInstall(target, plan, { force: opts.force });
  if (conflicts) {
    process.stderr.write(`skills:install: refused, nothing written. These skills already exist in ${target} with different content:\n`);
    for (const c of conflicts) process.stderr.write(`  ${c.name}: ${c.diff.join(', ')}\n`);
    process.stderr.write('Compare them, then run again with --force to replace them.\n');
    return 1;
  }
  for (const d of done) process.stdout.write(`${d.result.padEnd(9)} ${d.name} -> ${d.dst}\n`);
  return 0;
}

process.exitCode = main();
