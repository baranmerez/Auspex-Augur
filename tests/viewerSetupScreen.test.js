import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the setup-screen block of src/viewer.html: the desktop app's first-run
// Setup screen (step states, the MCP entry to copy, the first-run switch, the
// connection form and the .auspex-connection file).
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ setup-screen:start[\s\S]*?\/\/ setup-screen:end/)?.[0];

function load() {
  assert.ok(block, 'setup-screen block found in viewer.html');
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(`${block}\nObject.assign(this, { setupMcpEntry, setupSteps, setupAttention, setupShouldOpen, setupPgpassFormat, setupPgpassExample, setupFormProblem, setupParseConnectionFile, setupHasConnection, setupCheckRequest });`, context);
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
const own = [{ name: 'exampledb', host: 'db.example.test' }, { name: 'testdb', host: 'db2.example.test' }];

test('the page script parses (the Setup texts and translations included)', () => {
  const script = page.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, 'main script found');
  assert.doesNotThrow(() => new Function(script));
});

test('the MCP entry carries the installed server script, escaped as JSON', () => {
  const { setupMcpEntry } = load();
  const entry = setupMcpEntry(script);
  assert.deepEqual(JSON.parse(entry), { mcpServers: { auspex: { command: 'node', args: [script] } } });
  assert.match(entry, /Auspex Augur\\\\server\\\\src\\\\index\.js/, 'backslashes are escaped for pasting into a JSON file');
  for (const none of [null, undefined, '', 42]) assert.equal(setupMcpEntry(none), null);
});

test('step states: Node, the Auspex folder, a connection and the program files are needed; pgpass, the entry and skills are optional', () => {
  const { setupSteps, setupAttention: attention } = load();
  const setupAttention = s => attention(s, own);
  const states = s => Object.fromEntries(plain(setupSteps(s, own)).map(x => [x.key, x.state]));
  assert.deepEqual(states(ready), { node: 'ok', home: 'ok', connection: 'ok', root: 'ok', pgpass: 'ok', mcp: 'info', skills: 'ok' });
  assert.equal(setupAttention(ready), 0);
  assert.equal(attention(ready, [{ name: 'exampledb', host: 'db.example.test' }]), 1, 'only the example profile: the connection step is needed');
  assert.equal(attention(ready, undefined), 1);
  const fresh = { ...ready, homeExists: false, profilesExists: false, pgpass: { ...ready.pgpass, exists: false }, skills: { ...ready.skills, present: [] } };
  assert.deepEqual(states(fresh), { node: 'ok', home: 'todo', connection: 'ok', root: 'ok', pgpass: 'info', mcp: 'info', skills: 'info' });
  const noNode = { ...ready, node: { found: false, ok: false, version: null, path: null, problem: 'Node was not found on PATH' } };
  assert.equal(states(noNode).node, 'todo');
  const oldNode = { ...ready, node: { found: true, ok: false, version: '18.19.1', problem: 'Node 18.19.1 is too old' } };
  assert.equal(setupAttention(oldNode), 1);
  const noRoot = { ...ready, root: { path: null, source: null, error: { code: 'AUSPEX_ROOT_INVALID', message: 'x' } }, serverScript: null };
  assert.deepEqual([states(noRoot).root, states(noRoot).mcp], ['todo', 'todo']);
  assert.equal(setupAttention({ ...noRoot, node: noNode.node, homeExists: false }), 4);
  assert.deepEqual(plain(setupSteps(null)), []);
  assert.deepEqual(plain(setupSteps({})).map(x => x.state), ['todo', 'todo', 'todo', 'todo', 'info', 'todo', 'info'], 'a partial answer never reads as done');
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

test('the connection form: field rules, messages never hold the value', () => {
  const { setupFormProblem } = load();
  const form = { profileName: 'exampledb', host: 'db.example.test', port: '5432', database: 'exampledb', user: 'report_reader' };
  assert.equal(setupFormProblem(form, 'pw'), null);
  assert.equal(setupFormProblem({ ...form, host: '::1', database: 'örnek db', port: ' 5433 ' }, 'p:w\\x'), null);
  for (const [patch, re] of [
    [{ profileName: 'Example' }, /^Profile name/], [{ host: 'db.example.test/x' }, /^Host/], [{ host: '[::1]' }, /^Host/],
    [{ port: '0' }, /^Port/], [{ port: '70000' }, /^Port/], [{ port: '54x' }, /^Port/], [{ port: '' }, /^Port/],
    [{ database: '' }, /^Database: required/], [{ user: ' report_reader' }, /^User: one line/], [{ user: 'a'.repeat(64) }, /^User: at most 63/],
  ]) assert.match(setupFormProblem({ ...form, ...patch }, 'pw') ?? '', re, JSON.stringify(patch));
  assert.match(setupFormProblem(form, ''), /^Password: required/);
  const twoLines = setupFormProblem(form, 'secret-one\nline');
  assert.match(twoLines, /^Password: one line/);
  assert.ok(!twoLines.includes('secret-one'));
});

test('.auspex-connection files: strict fields, a password is ignored with a warning', () => {
  const { setupParseConnectionFile } = load();
  const file = { profileName: 'exampledb', host: 'db.example.test', port: 5432, database: 'exampledb', user: 'report_reader' };
  assert.deepEqual(plain(setupParseConnectionFile(JSON.stringify(file))), { values: { ...file, port: '5432' }, passwordIgnored: false });
  const withPw = plain(setupParseConnectionFile(JSON.stringify({ ...file, password: 'file-secret' })));
  assert.equal(withPw.passwordIgnored, true);
  assert.ok(!JSON.stringify(withPw).includes('file-secret'), 'the password is not carried over');
  for (const [text, re] of [
    ['{ not json', /not valid JSON/], ['[1]', /one JSON object/], ['null', /one JSON object/],
    [JSON.stringify({ ...file, sslmode: 'require' }), /Unknown field\(s\): sslmode/],
    [JSON.stringify((({ user, ...r }) => r)(file)), /Missing field\(s\): user/],
    [JSON.stringify({ ...file, port: '5432' }), /^Port/], [JSON.stringify({ ...file, port: 5432.5 }), /^Port/],
    [JSON.stringify({ ...file, profileName: 'Example DB' }), /^Profile name/], [JSON.stringify({ ...file, host: 1 }), /^Host/],
    [JSON.stringify({ ...file, database: ['x'] }), /^Database/], [' '.repeat(4097), /larger than 4 KB/],
  ]) assert.match(setupParseConnectionFile(text).error ?? '', re, text.slice(0, 60));
});

test('after saving, the next step asks the agent to run check_profile; the app never tests the connection', () => {
  const { setupCheckRequest, setupHasConnection } = load();
  assert.match(setupCheckRequest('exampledb'), /check_profile on the Auspex profile "exampledb"/);
  assert.equal(setupHasConnection([{ name: 'testdb', host: 'db2.example.test', error: 'x' }]), false, 'a broken profile does not count');
  assert.doesNotMatch(page, /invoke\('check_profile'|test_connection/);
});

test('the Setup tab is desktop-only; the only password field is masked, never prefilled and never kept in state', () => {
  assert.match(page, /<button data-tab="setup" hidden>/);
  assert.match(page, /if \(tauriCore\) document\.querySelector\('#tabs button\[data-tab="setup"\]'\)\.hidden = false;/);
  assert.ok(page.includes("(tab === 'setup' && !tauriCore)) tab = 'overview'"), 'the browser viewer never opens the Setup tab');
  const render = page.match(/function renderSetup\(\{ force = false \} = \{\}\) \{[\s\S]*?\r?\n\}\r?\n/)?.[0];
  assert.ok(render, 'renderSetup found');
  assert.doesNotMatch(render, /type: 'password'|h\('input'|h\('textarea'/, 'the form lives in setupConnectionStep only');
  assert.doesNotMatch(render, /invoke\('(?!api')/, 'writes go through setupAction only');
  const step = page.match(/function setupConnectionStep\([\s\S]*?\r?\n\}\r?\n/)?.[0];
  assert.ok(step, 'setupConnectionStep found');
  const pw = [...step.matchAll(/h\('input', \{[^}]*type: 'password'[^}]*\}/g)].map(m => m[0]);
  assert.equal(pw.length, 1, 'one password field');
  assert.match(pw[0], /autocomplete: 'new-password'/);
  assert.doesNotMatch(pw[0], /value:/, 'never prefilled');
  assert.doesNotMatch(page, /state\.[A-Za-z]+\s*=\s*setupPassword|setupForm\.password|form\.password/, 'the password stays out of state');
  assert.match(page, /if \(state\.setupMsg\?\.ok && busyKey === 'connection'\) \{\r?\n\s*setupPassword = '';/, 'cleared after a save');
  const persist = page.match(/const persist = \(\) => [^\n]*/)?.[0] ?? '';
  assert.doesNotMatch(persist, /setup/i, 'nothing of the Setup screen goes to localStorage');
  const actions = [...page.matchAll(/setupAction\('([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(actions)].sort(), ['install_skills', 'save_connection', 'setup_init']);
});
