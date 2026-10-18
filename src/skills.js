import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Workflow skills shipped in <repo>/skills/<name>/SKILL.md (+ references/*.md).
// The same files are installed as agent skills (scripts/installSkills.mjs) and
// served as MCP prompts (src/index.js), so their text exists only once.
export const defaultSkillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

// Skill name -> MCP prompt name. Every listed skill must exist at startup.
export const promptSkills = [
  { prompt: 'explore', skill: 'auspex-explore' },
  { prompt: 'report', skill: 'auspex-report' },
  { prompt: 'ddl', skill: 'auspex-ddl' },
  { prompt: 'columns', skill: 'auspex-columns' },
];

export class SkillError extends Error {}

// Minimal frontmatter reader for the two keys a skill needs. Values may be
// plain or wrapped in double or single quotes.
export function parseSkill(text, file) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0] !== '---') throw new SkillError(`Skill file has no frontmatter: ${file}`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new SkillError(`Skill file frontmatter is not closed: ${file}`);
  const meta = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    meta[m[1]] = value;
  }
  for (const key of ['name', 'description']) {
    if (!meta[key]) throw new SkillError(`Skill file frontmatter has no ${key}: ${file}`);
  }
  return { name: meta.name, description: meta.description, body: lines.slice(end + 1).join('\n').trim() };
}

// Reads one skill with its reference files (sorted by name). Fails with the
// path when the skill file is missing or its name does not match its folder.
export function loadSkill(name, dir = defaultSkillsDir) {
  const file = path.join(dir, name, 'SKILL.md');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new SkillError(`Skill file missing or unreadable: ${file} (${err.code ?? err.message})`);
  }
  const skill = parseSkill(text, file);
  if (skill.name !== name) throw new SkillError(`Skill name "${skill.name}" does not match its folder "${name}": ${file}`);
  const refDir = path.join(dir, name, 'references');
  const references = fs.existsSync(refDir)
    ? fs.readdirSync(refDir).filter(f => f.endsWith('.md')).sort()
      .map(f => ({ file: `references/${f}`, text: fs.readFileSync(path.join(refDir, f), 'utf8').replace(/\r\n/g, '\n').trim() }))
    : [];
  return { ...skill, references };
}

export function loadPromptSkills(dir = defaultSkillsDir) {
  return promptSkills.map(p => ({ ...p, ...loadSkill(p.skill, dir) }));
}

// Prompt text: the user's arguments, the skill body, then its reference
// files under headings that match the links in the body.
export function promptText(skill, { profile, goal } = {}) {
  const head = [
    `Follow the ${skill.name} workflow below.`,
    profile
      ? `Profile: ${profile} (named by the user for this conversation).`
      : 'Profile: not named yet. Call list_profiles, show the profiles and ask the user which one to use before any database call.',
  ];
  if (goal) head.push(`Goal: ${goal}`);
  const refs = skill.references.map(r => `\n\n---\n\n## ${r.file}\n\n${r.text}`).join('');
  return `${head.join('\n')}\n\n${skill.body}${refs}\n`;
}
