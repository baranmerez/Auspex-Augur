import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SchemaMemory, validateEvidenceCode, maxEvidenceCode } from '../src/memory/store.js';

// Code-derived column meanings: remember evidenceCode (references into a
// configured code root, never code text), stored on the note, carried by
// table_knowledge and graph.json, kept on confirm and left out of the audit.
const ref = (extra = {}) => ({ root: 'example_app', path: 'src/Orders/Order.cs', ...extra });
const roots = ['example_app', 'spare'];

test('evidenceCode: valid references are normalized', () => {
  assert.deepEqual(validateEvidenceCode(undefined), []);
  assert.deepEqual(validateEvidenceCode([]), []);
  assert.deepEqual(validateEvidenceCode([
    ref({ path: 'src\\Orders\\Order.cs', line: 42, symbol: '  Order.Amount  ' }),
    ref({ root: 'spare', path: 'web/orders/order-form.html' }),
  ], roots), [
    { root: 'example_app', path: 'src/Orders/Order.cs', line: 42, symbol: 'Order.Amount' },
    { root: 'spare', path: 'web/orders/order-form.html' },
  ]);
});

const invalid = [
  ['not an array', ref(), /must be an array/],
  ['more than the limit', Array.from({ length: maxEvidenceCode + 1 }, (_, i) => ref({ line: i + 1 })), /At most 5/],
  ['an unknown key', [ref({ code: 'amount = a + b' })], /unknown keys: code/],
  ['a non-object entry', ['src/Orders/Order.cs'], /must be an object/],
  ['an unknown root', [ref({ root: 'other' })], /not a configured code root/],
  ['a root given as a path', [ref({ root: 'C:\\example' })], /name of a configured code root/],
  ['an absolute POSIX path', [ref({ path: '/srv/example_app/src/Order.cs' })], /relative to its code root/],
  ['a drive path', [ref({ path: 'C:\\example\\src\\Order.cs' })], /relative to its code root/],
  ['a drive-relative path', [ref({ path: 'C:src\\Order.cs' })], /relative to its code root/],
  ['a UNC path', [ref({ path: '\\\\db.example.test\\share\\Order.cs' })], /relative to its code root/],
  ['a forward-slash UNC path', [ref({ path: '//db.example.test/share/Order.cs' })], /relative to its code root/],
  ['a parent segment', [ref({ path: 'src/../../secret.cs' })], /"\.\."/],
  ['a dot segment', [ref({ path: './src/Order.cs' })], /"\.\."/],
  ['an empty path', [ref({ path: ' ' })], /path must be a non-empty string/],
  ['a control character in the path', [ref({ path: 'src/Ord\ner.cs' })], /control characters/],
  ['line 0', [ref({ line: 0 })], /line must be an integer between 1/],
  ['a negative line', [ref({ line: -3 })], /line must be an integer/],
  ['a fractional line', [ref({ line: 1.5 })], /line must be an integer/],
  ['a line as text', [ref({ line: '12' })], /line must be an integer/],
  ['a line past the bound', [ref({ line: 10000001 })], /line must be an integer/],
  ['a multi-line symbol', [ref({ symbol: 'Order\nAmount' })], /one line/],
  ['a long symbol', [ref({ symbol: 'x'.repeat(121) })], /longer than 120/],
  ['an empty symbol', [ref({ symbol: '  ' })], /symbol must be a non-empty string/],
  ['a duplicate reference', [ref({ line: 3 }), ref({ line: 3 })], /listed twice/],
];
for (const [name, list, message] of invalid) {
  test(`evidenceCode rejects ${name}`, () => assert.throws(() => validateEvidenceCode(list, roots), message));
}

test('store: evidenceCode only with inference or observation, kept on confirm, carried by table_knowledge and graph.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-code-store-'));
  try {
    const memory = new SchemaMemory(dir);
    assert.throws(() => memory.addNote('exampledb', { kind: 'rule', schema: 'example', table: 'orders', column: 'amount', text: 'x', evidenceCode: [ref()] }, { codeRoots: roots }), /only valid with kind inference or observation/);
    assert.throws(() => memory.addNote('exampledb', { kind: 'inference', schema: 'example', table: 'orders', column: 'amount', text: 'x', evidenceCode: [ref({ root: 'other' })] }, { codeRoots: roots }), /not a configured code root/);
    const note = memory.addNote('exampledb', { kind: 'inference', schema: 'example', table: 'orders', column: 'amount', text: 'Appears to be the order total.', evidenceCode: [ref({ line: 42, symbol: 'Order.Amount' })] }, { codeRoots: roots });
    const plain = memory.addNote('exampledb', { kind: 'inference', schema: 'example', table: 'orders', column: 'status_code', text: 'No code evidence.' });
    assert.deepEqual(note.evidenceCode, [{ root: 'example_app', path: 'src/Orders/Order.cs', line: 42, symbol: 'Order.Amount' }]);
    assert.equal(plain.evidenceCode, undefined);

    const known = memory.knowledge('exampledb', 'example', 'orders');
    assert.deepEqual(known.notes.find(n => n.id === note.id).evidenceCode, note.evidenceCode);
    assert.equal(known.notes.find(n => n.id === plain.id).evidenceCode, undefined);

    const confirmed = memory.confirmNote('exampledb', note.id, 'observation');
    assert.equal(confirmed.kind, 'observation');
    assert.deepEqual(confirmed.evidenceCode, note.evidenceCode);
    const graph = JSON.parse(fs.readFileSync(path.join(dir, 'exampledb', 'graph.json'), 'utf8'));
    assert.deepEqual(graph.notes.find(n => n.id === note.id).evidenceCode, note.evidenceCode);
    assert.ok(!JSON.stringify(graph).includes('amount = '), 'no code text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The real MCP server over stdio, with a code root from the profiles file and
// one from env; no database is needed.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-code-mcp-'));
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const codeRoot = path.join(home, 'example_app');
const spareRoot = path.join(home, 'spare');
let client;
before(async () => {
  const file = path.join(home, 'profiles.json');
  fs.writeFileSync(file, JSON.stringify({ codeRoots: { example_app: codeRoot } }));
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: file, AUSPEX_DB_EXAMPLE: 'postgresql://auspex@127.0.0.1:1/example', AUSPEX_CODE_ROOT_SPARE: spareRoot };
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE|SCRIPT_ROOT|CODE_ROOT)_/i.test(k) && !['AUSPEX_DB_EXAMPLE', 'AUSPEX_CODE_ROOT_SPARE'].includes(k)) delete env[k];
  client = new Client({ name: 'code-evidence-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
});
after(async () => {
  await client?.close();
  fs.rmSync(home, { recursive: true, force: true });
});
const call = (name, args) => client.callTool({ name, arguments: args });
const body = r => JSON.parse(r.content[0].text);
function auditEntries() {
  const dir = path.join(home, 'logs');
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
}

test('MCP: list_profiles shows the code roots', async () => {
  const listed = body(await call('list_profiles', {}));
  assert.deepEqual(listed.codeRoots, [{ name: 'example_app', path: path.resolve(codeRoot), source: 'file' }, { name: 'spare', path: path.resolve(spareRoot), source: 'env' }]);
  assert.deepEqual(listed.profiles.map(p => p.name), ['example']);
});

test('MCP: remember stores code references, confirm keeps them, the audit has no evidence', async () => {
  const marker = 'zqcodesymbolmarker';
  const added = await call('remember', {
    profile: 'example', action: 'add', kind: 'inference', schema: 'example', table: 'orders', column: 'amount',
    text: 'Appears to be the order total.', evidenceCode: [{ root: 'example_app', path: 'src\\Orders\\Order.cs', line: 42, symbol: marker }, { root: 'spare', path: 'zqpathmarker/orders.html' }],
  });
  assert.ok(!added.isError, added.content[0].text);
  const note = body(added).note;
  assert.deepEqual(note.evidenceCode, [{ root: 'example_app', path: 'src/Orders/Order.cs', line: 42, symbol: marker }, { root: 'spare', path: 'zqpathmarker/orders.html' }]);

  const known = body(await call('table_knowledge', { profile: 'example', schema: 'example', table: 'orders' }));
  assert.deepEqual(known.notes.find(n => n.id === note.id).evidenceCode, note.evidenceCode);

  const confirmed = await call('remember', { profile: 'example', action: 'confirm', kind: 'observation', id: note.id });
  assert.ok(!confirmed.isError, confirmed.content[0].text);
  assert.deepEqual(body(confirmed).note.evidenceCode, note.evidenceCode);
  const graph = JSON.parse(fs.readFileSync(path.join(home, 'memory', 'example', 'graph.json'), 'utf8'));
  assert.deepEqual(graph.notes.find(n => n.id === note.id).evidenceCode, note.evidenceCode);

  const refusals = [
    [{ kind: 'inference', evidenceCode: [{ root: 'nope', path: 'src/Order.cs' }] }, /not a configured code root/],
    [{ kind: 'inference', evidenceCode: [{ root: 'example_app', path: 'C:\\example\\Order.cs' }] }, /relative to its code root/],
    [{ kind: 'rule', evidenceCode: [{ root: 'example_app', path: 'src/Order.cs' }] }, /only valid with kind inference or observation/],
    [{ kind: 'inference', evidenceCode: [{ root: 'example_app', path: 'src/Order.cs', code: 'x' }] }, /code|Unrecognized/i],
    [{ kind: 'inference', evidenceCode: Array.from({ length: 6 }, (_, i) => ({ root: 'example_app', path: 'src/Order.cs', line: i + 1 })) }, /5|too_big|Too big/i],
  ];
  for (const [extra, message] of refusals) {
    const r = await call('remember', { profile: 'example', action: 'add', schema: 'example', table: 'orders', column: 'amount', text: 'x', ...extra });
    assert.ok(r.isError, JSON.stringify(extra));
    assert.match(r.content[0].text, message);
  }
  const onConfirm = await call('remember', { profile: 'example', action: 'confirm', kind: 'rule', id: note.id, evidenceCode: [{ root: 'example_app', path: 'src/Order.cs' }] });
  assert.ok(onConfirm.isError);
  assert.match(onConfirm.content[0].text, /only accepted with action=add/);

  const raw = JSON.stringify(auditEntries());
  for (const m of [marker, 'zqpathmarker', 'Order.cs', 'order total']) assert.ok(!raw.includes(m), `${m} is not logged`);
  assert.ok(auditEntries().some(e => e.tool === 'remember' && e.noteId === note.id && e.action === 'confirm'));
});
