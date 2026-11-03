import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the setup-screen block of src/viewer.html: the desktop app's first-run
// Setup screen (step states, the MCP entry to copy, the first-run switch).
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ setup-screen:start[\s\S]*?\/\/ setup-screen:end/)?.[0];

function load() {
  assert.ok(block, 'setup-screen block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nObject.assign(this, { setupMcpEntry, setupSteps, setupAttention, setupShouldOpen, setupPgpassFormat, setupPgpassExample });`, context);
  return context;
}
const plain = x => JSON.parse(JSON.stringify(x));
const script = 'C:\\Users\\example\\AppData\\Local\\Programs\\Auspex Augur\\server\\src\\index.js';
const ready = {
  home: 'C:\\Users\\example\\.auspex', homeExists: true, profilesFile: 'C:\\Users\\example\\.auspex\\profiles.json', profilesExists: true,
  root: { path: 'C:\\Users\\example\\AppData\\Local\\Programs\\Auspex Augur\\server', source: 'installed', error: null },
  serverScript: script,
  node: { found: true, ok: true, version: '22.11.0', path: 'C:\\Program Files\\nodejs\\node.exe', minimum: 20, downloadUrl: 'https://nodejs.org/', problem: null },
  pgpass: { file: 'C:\\Users\\example\\AppData\\Roaming\\postgresql\\pgpass.conf', fromEnv: false, exists: true },
  skills: { target: 'C:\\Users\\example\\.claude\\skills', available: ['auspex-explore', 'auspex-report'], present: ['auspex-explore', 'auspex-report'] },
};

test('the MCP entry carries the installed server script, escaped as JSON', () => {
  const { setupMcpEntry } = load();
  const entry = setupMcpEntry(script);
  assert.deepEqual(JSON.parse(entry), { mcpServers: { auspex: { command: 'node', args: [script] } } });
  assert.match(entry, /Auspex Augur\\\\server\\\\src\\\\index\.js/, 'backslashes are escaped for pasting into a JSON file');
  for (const none of [null, undefined, '', 42]) assert.equal(setupMcpEntry(none), null);
});

test('step states: Node, the Auspex folder and the program files are needed; pgpass, the entry and skills are optional', () => {
  const { setupSteps, setupAttention } = load();
  const states = s => Object.fromEntries(plain(setupSteps(s)).map(x => [x.key, x.state]));
  assert.deepEqual(states(ready), { node: 'ok', home: 'ok', root: 'ok', pgpass: 'ok', mcp: 'info', skills: 'ok' });
  assert.equal(setupAttention(ready), 0);
  const fresh = { ...ready, homeExists: false, profilesExists: false, pgpass: { ...ready.pgpass, exists: false }, skills: { ...ready.skills, present: [] } };
  assert.deepEqual(states(fresh), { node: 'ok', home: 'todo', root: 'ok', pgpass: 'info', mcp: 'info', skills: 'info' });
  const noNode = { ...ready, node: { found: false, ok: false, version: null, path: null, problem: 'Node was not found on PATH' } };
  assert.equal(states(noNode).node, 'todo');
  const oldNode = { ...ready, node: { found: true, ok: false, version: '18.19.1', problem: 'Node 18.19.1 is too old' } };
  assert.equal(setupAttention(oldNode), 1);
  const noRoot = { ...ready, root: { path: null, source: null, error: { code: 'AUSPEX_ROOT_INVALID', message: 'x' } }, serverScript: null };
  assert.deepEqual([states(noRoot).root, states(noRoot).mcp], ['todo', 'todo']);
  assert.equal(setupAttention({ ...noRoot, node: noNode.node, homeExists: false }), 4);
  assert.deepEqual(plain(setupSteps(null)), []);
  assert.deepEqual(plain(setupSteps({})).map(x => x.state), ['todo', 'todo', 'todo', 'info', 'todo', 'info'], 'a partial answer never reads as done');
});

test('the screen opens by itself only while there is no profiles file', () => {
  const { setupShouldOpen } = load();
  assert.equal(setupShouldOpen({ ...ready, profilesExists: false }), true);
  assert.equal(setupShouldOpen(ready), false);
  assert.equal(setupShouldOpen({ ...ready, node: { ok: false } }), false, 'a Node problem shows on the tab count, it does not take over the window');
  assert.equal(setupShouldOpen(null), false);
  assert.equal(setupShouldOpen({}), false, 'an unknown answer does not switch screens');
});

test('the pgpass guidance shows the format and an invented example without a real password', () => {
  const { setupPgpassFormat, setupPgpassExample } = load();
  assert.equal(setupPgpassFormat, 'hostname:port:database:username:password');
  assert.equal(setupPgpassExample.split(':').length, 5);
  assert.match(setupPgpassExample, /^db\.example\.test:5432:exampledb:report_reader:<password>$/);
});

test('the Setup tab is desktop-only and the screen has no password field', () => {
  assert.match(page, /<button data-tab="setup" hidden>/);
  assert.match(page, /if \(tauriCore\) document\.querySelector\('#tabs button\[data-tab="setup"\]'\)\.hidden = false;/);
  assert.ok(page.includes("(tab === 'setup' && !tauriCore)) tab = 'overview'"), 'the browser viewer never opens the Setup tab');
  const render = page.match(/function renderSetup\(\) \{[\s\S]*?\r?\n\}\r?\n/)?.[0];
  assert.ok(render, 'renderSetup found');
  assert.doesNotMatch(render, /type: 'password'|h\('input'|h\('textarea'/, 'no input fields at all');
  assert.doesNotMatch(render, /invoke\('(?!api')/, 'writes go through setupAction only');
  const actions = [...page.matchAll(/setupAction\('([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(actions)].sort(), ['install_skills', 'setup_init']);
});
