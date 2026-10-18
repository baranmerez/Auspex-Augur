import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SchemaMemory, MemoryError, validateScoreInput, scoreHistoryLimit } from '../src/memory/store.js';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1) + (clock++) * 60000).toISOString();
const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const srcUrl = rel => pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', rel)).href;

const col = (column, attnum, type = 'integer') => ({ column, attnum, type, not_null: false, default: null, comment: null });

// Shape of a describe_table result (catalog.describeTable).
function ordersDescribe(profile = 'example') {
  return {
    profile, relation: 'example.orders', schema: 'example', table: 'orders', kind: 'table', oid: 2001, estimated_rows: 1000, comment: null,
    columns: [col('order_id', 1), col('customer_id', 2), col('status_code', 3), col('created_at', 4, 'timestamp'), col('delivered_at', 5, 'timestamp'), col('amount', 6, 'numeric')],
    constraints: [{ name: 'orders_pkey', type: 'primary key', definition: 'PRIMARY KEY (order_id)', columns: ['order_id'], ref_schema: null, ref_table: null, ref_columns: null }],
    indexes: [], referencedBy: [],
  };
}

function describedMemory() {
  const mem = new SchemaMemory(tempDir('auspex-scores-'), { now });
  mem.recordDescribe(ordersDescribe());
  return mem;
}

const entry = (name, score, extra = {}) => ({ name, score, roles: ['display'], reason: `${name} shown in reports`, sources: 2, ...extra });
const input = (columns, extra = {}) => ({ schema: 'example', table: 'orders', columns, ...extra });
const sha = c => c.repeat(64);

test('validation rejects bad input and names the problem', () => {
  const bad = [
    [input([entry('order_id', 0)]), /score must be an integer from 1 to 5/],
    [input([entry('order_id', 6)]), /score must be an integer from 1 to 5/],
    [input([entry('order_id', 2.5)]), /score must be an integer/],
    [input([entry('order_id', 3, { roles: ['primary'] })]), /"primary" is not one of/],
    [input([entry('order_id', 3, { roles: ['join', 'join'] })]), /role twice/],
    [input([entry('order_id', 3, { reason: 'x'.repeat(201) })]), /longer than 200/],
    [input([entry('order_id', 3, { reason: 'line one\nline two' })]), /one line/],
    [input([entry('order_id', 3, { reason: '  ' })]), /reason must be a non-empty/],
    [input([entry('order_id', 3, { sources: -1 })]), /sources must be an integer >= 0/],
    [input([entry('order_id', 3, { weight: 1 })]), /unknown keys: weight/],
    [{ ...input([entry('order_id', 3)]), extra: true }, /Input has unknown keys: extra/],
    [input([]), /at least one entry in columns or triggers/],
    [input([entry('order_id', 3), entry('order_id', 4)]), /listed twice/],
    [input([entry('order_id', 3)], { scannedFiles: [{ root: 'scripts', path: '/abs/x.sql', sha256: sha('a') }] }), /relative/],
    [input([entry('order_id', 3)], { scannedFiles: [{ root: 'scripts', path: 'C:\\x.sql', sha256: sha('a') }] }), /relative/],
    [input([entry('order_id', 3)], { scannedFiles: [{ root: 'scripts', path: 'example/../x.sql', sha256: sha('a') }] }), /"\.\."/],
    [input([entry('order_id', 3)], { scannedFiles: [{ root: 'scripts', path: 'x.sql', sha256: 'abc' }] }), /64 hex/],
    [input([entry('order_id', 3)], { scannedFiles: [{ root: 'scripts', path: 'x.sql', sha256: sha('a'), content: 'select 1' }] }), /unknown keys: content/],
  ];
  for (const [value, message] of bad) assert.throws(() => validateScoreInput(value), err => err instanceof MemoryError && message.test(err.message), message.source);
  assert.throws(() => validateScoreInput(input([entry('order_id', 3)], { scannedFiles: [{ root: 'other', path: 'x.sql', sha256: sha('a') }] }), ['scripts']), /not a configured script root/);
  const ok = validateScoreInput(input([entry('order_id', 5, { roles: ['sort/group', 'key'], reason: '  joined everywhere  ' })], { scannedFiles: [{ root: 'scripts', path: 'example\\reports\\a.sql', sha256: sha('A') }] }), ['scripts']);
  assert.deepEqual(ok.columns[0].roles, ['key', 'sort/group'], 'roles in canonical order');
  assert.equal(ok.columns[0].reason, 'joined everywhere');
  assert.deepEqual(ok.scannedFiles, [{ root: 'scripts', path: 'example/reports/a.sql', sha256: sha('a') }]);
});

test('unknown, undescribed or mismatched tables reject the whole call and save nothing', () => {
  const mem = describedMemory();
  assert.throws(() => mem.scoreColumns('example', { ...input([entry('order_id', 5)]), table: 'customers' }), err => err.errorCode === 'NOT_FOUND' && /Describe it first/.test(err.message));
  mem.recordSeen('example', [{ schema: 'example', table: 'order_items', columns: ['order_id'] }]);
  assert.throws(() => mem.scoreColumns('example', { ...input([entry('order_id', 5)]), table: 'order_items' }), err => err.errorCode === 'PRECONDITION_FAILED');
  assert.throws(() => mem.scoreColumns('example', input([entry('order_id', 5), entry('teslim_durum_kodu', 3)])), /teslim_durum_kodu/);
  assert.equal(mem.readTable('example', 'example', 'orders').columnScores, undefined, 'valid columns of a rejected call are not saved');
  assert.throws(() => mem.scoreColumns('Bad Profile', input([entry('order_id', 5)])), err => err.errorCode === 'PROFILE_INVALID');
});

test('a new score replaces the current one, history keeps the newest 5 first, unlisted columns keep theirs', () => {
  const mem = describedMemory();
  mem.scoreColumns('example', input([entry('order_id', 5, { roles: ['key', 'join'] }), entry('amount', 4, { roles: ['aggregate'] })]));
  for (let i = 1; i <= 6; i++) mem.scoreColumns('example', input([entry('order_id', (i % 5) + 1, { reason: `round ${i}` })]));
  const rec = mem.readTable('example', 'example', 'orders');
  const order = rec.columnScores.order_id;
  assert.equal(order.score, (6 % 5) + 1);
  assert.equal(order.reason, 'round 6');
  assert.equal(order.history.length, scoreHistoryLimit);
  assert.deepEqual(order.history.map(h => h.reason), ['round 5', 'round 4', 'round 3', 'round 2', 'round 1']);
  assert.ok(order.history[0].at > order.history[1].at, 'newest first');
  assert.deepEqual(rec.columnScores.amount, { score: 4, roles: ['aggregate'], reason: 'amount shown in reports', sources: 2, at: rec.columnScores.amount.at, history: [] });
  assert.equal(rec.scoredAt, order.at);

  // Describing the table again keeps the scores.
  mem.recordDescribe(ordersDescribe());
  assert.equal(mem.readTable('example', 'example', 'orders').columnScores.amount.score, 4);
});

test('table_knowledge and graph.json carry the scores', () => {
  const mem = describedMemory();
  const result = mem.scoreColumns('example', input([
    entry('amount', 3, { roles: ['aggregate'] }),
    entry('order_id', 5, { roles: ['key', 'join', 'filter'], sources: 9 }),
    entry('delivered_at', 1, { roles: [], sources: 0, reason: 'not used in any read SQL' }),
  ]));
  assert.deepEqual(result.unscoredColumns, ['customer_id', 'status_code', 'created_at']);
  mem.scoreColumns('example', input([entry('amount', 4, { roles: ['aggregate'] })]));

  const k = mem.knowledge('example', 'example', 'orders');
  assert.deepEqual(k.columnScores.map(c => [c.column, c.score]), [['order_id', 5], ['amount', 4], ['delivered_at', 1]]);
  assert.deepEqual(k.columnScores[0].roles, ['key', 'join', 'filter']);
  assert.equal(k.columnScores[0].sources, 9);
  assert.deepEqual(k.columnScores[1].history.map(h => h.score), [3]);
  assert.deepEqual(k.unscoredColumns, ['customer_id', 'status_code', 'created_at']);
  assert.ok(k.scoredAt);

  const view = JSON.parse(fs.readFileSync(path.join(mem.root, 'example', 'graph.json'), 'utf8'));
  const node = view.nodes.find(n => n.id === 'example.orders');
  assert.equal(node.columnScores.order_id.score, 5);
  assert.equal(node.columnScores.amount.history[0].score, 3);
  assert.equal(node.scoredAt, k.scoredAt);
  assert.equal(fs.readdirSync(path.join(mem.root, 'example')).some(f => f.endsWith('.tmp')), false, 'atomic writes leave no temp files');
});

test('a dropped column keeps its score, marked as no longer in the structure', () => {
  const mem = describedMemory();
  mem.scoreColumns('example', input([entry('delivered_at', 2)]));
  const desc = ordersDescribe();
  desc.columns = desc.columns.filter(c => c.column !== 'delivered_at');
  mem.recordDescribe(desc);
  const k = mem.knowledge('example', 'example', 'orders');
  assert.deepEqual(k.columnScores.map(c => [c.column, c.inStructure]), [['delivered_at', false]]);
  assert.throws(() => mem.scoreColumns('example', input([entry('delivered_at', 2)])), /Not columns/);
});

test('scanned files keep relative paths, sha256 and lastReadAt only; a changed hash replaces the entry', () => {
  const mem = describedMemory();
  mem.scoreColumns('example', input([entry('order_id', 5)], { scannedFiles: [
    { root: 'scripts', path: 'example/reports/orders_by_day.sql', sha256: sha('a') },
    { root: 'scripts', path: 'example_01.sql', sha256: sha('b') },
  ] }), { scriptRoots: ['scripts'] });
  const second = mem.scoreColumns('example', input([entry('amount', 3)], { scannedFiles: [
    { root: 'scripts', path: 'example\\reports\\orders_by_day.sql', sha256: sha('c') },
  ] }), { scriptRoots: ['scripts'] });
  assert.deepEqual(second.scannedFiles, { recorded: 1, total: 2 });
  const files = mem.readScannedFiles('example');
  assert.deepEqual(files.map(f => [f.root, f.path, f.sha256]), [
    ['scripts', 'example/reports/orders_by_day.sql', sha('c')],
    ['scripts', 'example_01.sql', sha('b')],
  ]);
  for (const f of files) assert.deepEqual(Object.keys(f).sort(), ['lastReadAt', 'path', 'root', 'sha256']);
  assert.ok(files[0].lastReadAt > files[1].lastReadAt);
  assert.deepEqual(mem.readScannedFiles('example', 'other'), []);
  const stored = fs.readFileSync(path.join(mem.root, 'example', 'scanned-files.json'), 'utf8');
  assert.ok(!stored.includes(':\\') && !stored.includes(os.tmpdir()), 'no absolute paths');
});

test('scoring runs under the profile lock: two processes scoring different columns lose nothing', { timeout: 30000 }, async () => {
  const mem = describedMemory();
  const writer = (column, rounds) => `
    import { SchemaMemory } from '${srcUrl('memory/store.js')}';
    const mem = new SchemaMemory(${JSON.stringify(mem.root)});
    for (let i = 1; i <= ${rounds}; i++) mem.scoreColumns('example', { schema: 'example', table: 'orders', columns: [{ name: '${column}', score: (i % 5) + 1, roles: [], reason: 'round ' + i, sources: i }] });`;
  const run = code => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', exit => resolve({ exit, err }));
  });
  const results = await Promise.all([run(writer('order_id', 15)), run(writer('amount', 15))]);
  for (const r of results) assert.equal(r.exit, 0, r.err);
  const scores = new SchemaMemory(mem.root).readTable('example', 'example', 'orders').columnScores;
  assert.equal(scores.order_id.sources, 15);
  assert.equal(scores.amount.sources, 15);
  assert.equal(scores.order_id.history.length, scoreHistoryLimit);
  assert.equal(fs.existsSync(path.join(mem.root, 'example', '.lock')), false, 'lock released');
});

// ---------- MCP tool ----------
const home = tempDir('auspex-scores-mcp-');
const scriptRoot = tempDir('auspex-scores-root-');
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
let client;

before(async () => {
  new SchemaMemory(path.join(home, 'memory'), { now }).recordDescribe(ordersDescribe());
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_DB_EXAMPLE: 'postgresql://auspex@127.0.0.1:1/example', AUSPEX_SCRIPT_ROOT_SCRIPTS: scriptRoot };
  for (const k of Object.keys(env)) {
    if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE|SCRIPT_ROOT)_/i.test(k) && !['AUSPEX_DB_EXAMPLE', 'AUSPEX_SCRIPT_ROOT_SCRIPTS'].includes(k)) delete env[k];
    if (/^AUSPEX_(MEMORY|LIBRARY)_DIR$/i.test(k)) delete env[k];
  }
  client = new Client({ name: 'scores-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
});
after(async () => { await client?.close(); });

const call = (name, args) => client.callTool({ name, arguments: args });
const auditEntries = () => {
  const dir = path.join(home, 'logs');
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
};

test('score_columns over MCP: saved, returned by table_knowledge and scanned_files, audited without reasons or paths', async () => {
  const reason = 'REASONMARKER joined in every report';
  const saved = await call('score_columns', {
    profile: 'example', schema: 'example', table: 'orders',
    columns: [{ name: 'order_id', score: 5, roles: ['key', 'join'], reason, sources: 4 }],
    scannedFiles: [{ root: 'scripts', path: 'example/pathmarker.sql', sha256: sha('d') }],
  });
  assert.ok(!saved.isError, saved.content[0].text);
  assert.equal(JSON.parse(saved.content[0].text).scored, 1);

  const k = JSON.parse((await call('table_knowledge', { profile: 'example', schema: 'example', table: 'orders' })).content[0].text);
  assert.equal(k.columnScores[0].column, 'order_id');
  assert.equal(k.columnScores[0].reason, reason);
  const listed = JSON.parse((await call('scanned_files', { profile: 'example' })).content[0].text);
  assert.deepEqual(listed.files.map(f => f.path), ['example/pathmarker.sql']);

  const rejected = await call('score_columns', { profile: 'example', schema: 'example', table: 'orders', columns: [{ name: 'order_id', score: 5, roles: [], reason: 'x', sources: 1 }, { name: 'missing_column', score: 1, roles: [], reason: 'x', sources: 0 }] });
  assert.ok(rejected.isError);
  assert.equal(rejected.structuredContent.error.code, 'INVALID_INPUT');
  const noProfile = await call('score_columns', { schema: 'example', table: 'orders', columns: [{ name: 'order_id', score: 5, roles: [], reason: 'x', sources: 1 }] });
  assert.ok(noProfile.isError);
  const unknownKey = await call('score_columns', { profile: 'example', schema: 'example', table: 'orders', columns: [{ name: 'order_id', score: 5, roles: [], reason: 'x', sources: 1, weight: 2 }] });
  assert.ok(unknownKey.isError, 'unknown keys are rejected');
  const unknownTop = await call('score_columns', { profile: 'example', schema: 'example', table: 'orders', override: true, columns: [{ name: 'order_id', score: 5, roles: [], reason: 'x', sources: 1 }] });
  assert.ok(unknownTop.isError, 'unknown top-level keys are rejected');
  const badRoot = await call('score_columns', { profile: 'example', schema: 'example', table: 'orders', columns: [{ name: 'order_id', score: 5, roles: [], reason: 'x', sources: 1 }], scannedFiles: [{ root: 'nope', path: 'a.sql', sha256: sha('e') }] });
  assert.ok(badRoot.isError);

  const logged = auditEntries().filter(e => e.tool === 'score_columns');
  assert.equal(logged.length, 3, 'success, missing column and unknown root (SDK-rejected calls are not audited)');
  assert.deepEqual([logged[0].profile, logged[0].schema, logged[0].table, logged[0].columns, logged[0].scannedFiles, logged[0].scored], ['example', 'example', 'orders', 1, 1, 1]);
  assert.match(logged[1].error, /missing_column/);
  const raw = JSON.stringify(logged);
  for (const marker of ['REASONMARKER', 'pathmarker']) assert.ok(!raw.includes(marker), `${marker} is not logged`);
});
