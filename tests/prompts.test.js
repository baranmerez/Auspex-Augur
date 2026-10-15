import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadSkill, loadPromptSkills, parseSkill, promptSkills, defaultSkillsDir, SkillError } from '../src/skills.js';

// Starts the real MCP server over stdio with a temporary home; prompts need
// no database.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-prompts-test-'));
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
let client;

before(async () => {
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_DB_SHOP: 'postgresql://auspex@127.0.0.1:1/shop' };
  for (const k of Object.keys(env)) if (/^AUSPEX_DB_/i.test(k) && k !== 'AUSPEX_DB_SHOP') delete env[k];
  client = new Client({ name: 'prompts-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
});
after(async () => { await client?.close(); });

test('the three workflow prompts are listed with the skill descriptions and their arguments', async () => {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name).sort(), ['ddl', 'explore', 'report']);
  for (const p of prompts) {
    const skill = loadSkill(promptSkills.find(s => s.prompt === p.name).skill);
    assert.equal(p.description, skill.description);
    assert.deepEqual(p.arguments.map(a => [a.name, a.required ?? false]), [['profile', false], ['goal', false]]);
  }
});

test('a prompt returns the skill body and references, with the profile and goal', async () => {
  const skill = loadSkill('auspex-report');
  const r = await client.getPrompt({ name: 'report', arguments: { profile: 'shop', goal: 'December orders by region' } });
  assert.equal(r.messages.length, 1);
  const text = r.messages[0].content.text;
  assert.equal(r.messages[0].role, 'user');
  assert.match(text, /^Follow the auspex-report workflow below\.\nProfile: shop \(named by the user/);
  assert.match(text, /Goal: December orders by region/);
  assert.ok(text.includes(skill.body), 'skill body is included unchanged');
  for (const ref of skill.references) {
    assert.ok(text.includes(`## ${ref.file}`) && text.includes(ref.text), `${ref.file} is included`);
  }
  assert.ok(!text.startsWith('---') && !text.includes('description: "'), 'no frontmatter');

  const noProfile = await client.getPrompt({ name: 'explore', arguments: {} });
  assert.match(noProfile.messages[0].content.text, /Profile: not named yet\. Call list_profiles/);
});

test('every shipped skill is valid: frontmatter, size, and links that resolve', () => {
  for (const s of loadPromptSkills()) {
    assert.ok(s.description.length <= 1024, `${s.skill} description fits`);
    assert.ok(s.body.split('\n').length <= 150, `${s.skill} SKILL.md stays short`);
    const links = [...s.body.matchAll(/\]\((references\/[^)]+)\)/g)].map(m => m[1]);
    for (const link of links) assert.ok(s.references.some(r => r.file === link), `${s.skill} links ${link}`);
    for (const ref of s.references) assert.ok(links.includes(ref.file), `${s.skill} links every reference (${ref.file})`);
  }
});

test('a missing or malformed skill file fails with its path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-skills-missing-'));
  assert.throws(() => loadSkill('auspex-explore', dir), err => err instanceof SkillError
    && err.message.includes(path.join(dir, 'auspex-explore', 'SKILL.md')) && /missing/.test(err.message));
  fs.mkdirSync(path.join(dir, 'auspex-explore'));
  fs.writeFileSync(path.join(dir, 'auspex-explore', 'SKILL.md'), '---\nname: other\ndescription: x\n---\nbody');
  assert.throws(() => loadSkill('auspex-explore', dir), /does not match its folder/);
  assert.throws(() => parseSkill('no frontmatter', 'f.md'), /no frontmatter: f\.md/);
  assert.throws(() => parseSkill('---\nname: a\n---\n', 'f.md'), /no description: f\.md/);
  assert.equal(parseSkill('---\r\nname: a\r\ndescription: "d: e"\r\n---\r\nbody\r\n', 'f.md').description, 'd: e');
  assert.ok(fs.existsSync(defaultSkillsDir));
});
