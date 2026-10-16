import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the sql-highlight block in isolation. The block is shared byte for
// byte by the viewer (change scripts, SQL-only reports) and the report
// template (SQL panel of HTML reports).
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const re = /\/\/ sql-highlight:start[\s\S]*?\/\/ sql-highlight:end/;
const viewerBlock = read('../src/viewer.html').match(re)?.[0];
const templateBlock = read('../src/reports/template.html').match(re)?.[0];

function load() {
  assert.ok(viewerBlock, 'sql-highlight block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${viewerBlock}\nthis.sqlTokens = sqlTokens; this.sqlLines = sqlLines; this.sqlIndent = sqlIndent; this.sqlStepLine = sqlStepLine;`, context);
  return context;
}
const sig = tokens => Array.from(tokens).filter(t => t.type !== 'ws').map(t => `${t.type}:${t.v}`);
const join = tokens => Array.from(tokens).map(t => t.v).join('');

test('the viewer and the report template carry the same highlighter', () => {
  assert.ok(templateBlock, 'sql-highlight block found in template.html');
  assert.equal(templateBlock, viewerBlock);
});

test('keywords, functions, identifiers, numbers, operators and parameters', () => {
  const { sqlTokens } = load();
  const sql = 'SELECT o.id, count(*) AS n, coalesce(c.name, \'-\') FROM app.orders o LEFT JOIN app.customer_accounts c ON c.id = o.customer_id '
    + 'WHERE o.total >= 1.5e3 AND o.created_at > now() - interval \'7 days\' AND o.status = $1 AND o.region = :region::text GROUP BY 1 ORDER BY n DESC';
  const t = sig(sqlTokens(sql));
  for (const x of ['kw:SELECT', 'kw:FROM', 'kw:LEFT', 'kw:JOIN', 'kw:ON', 'kw:WHERE', 'kw:AND', 'kw:GROUP', 'kw:BY', 'kw:ORDER', 'kw:DESC', 'kw:interval', 'kw:AS'])
    assert.ok(t.includes(x), x);
  for (const x of ['fn:count', 'fn:coalesce', 'fn:now']) assert.ok(t.includes(x), x);
  for (const x of ['id:o.id', 'id:app.orders', 'id:app.customer_accounts', 'id:c.name', 'id:o.customer_id']) assert.ok(t.includes(x), x);
  for (const x of ['num:1.5e3', 'num:1', 'param:$1', 'param::region', 'op:::', 'op:>=', 'op:=', 'op:(']) assert.ok(t.includes(x), x);
  assert.ok(t.includes("str:'7 days'") && t.includes("str:'-'"));
  assert.equal(join(sqlTokens(sql)), sql);
});

test('strings and comments hide keywords and comment markers; quotes escape', () => {
  const { sqlTokens } = load();
  const sql = "SELECT 'it''s -- not a comment /* nor this */ SELECT' AS a, E'line\\'s \\\\ end' AS b, \"Odd \"\"Name\"\"\" -- tail SELECT 'x'\n"
    + '/* block /* nested */ still comment FROM */ FROM app.orders';
  const t = sig(sqlTokens(sql));
  assert.deepEqual(t, [
    'kw:SELECT', "str:'it''s -- not a comment /* nor this */ SELECT'", 'kw:AS', 'id:a', 'op:,',
    "str:E'line\\'s \\\\ end'", 'kw:AS', 'id:b', 'op:,', 'id:"Odd ""Name"""', "cm:-- tail SELECT 'x'",
    'cm:/* block /* nested */ still comment FROM */', 'kw:FROM', 'id:app.orders',
  ]);
  assert.equal(join(sqlTokens(sql)), sql);
  // An unterminated string or comment runs to the end without losing text.
  for (const bad of ["SELECT 'open", 'SELECT /* open', "SELECT E'x\\", 'SELECT "open', 'SELECT $$ open']) assert.equal(join(sqlTokens(bad)), bad);
});

test('dollar quotes: a function body after AS or DO is SQL, any other body a string', () => {
  const { sqlTokens } = load();
  const fn = "CREATE OR REPLACE FUNCTION app.touch() RETURNS trigger AS $body$\nBEGIN\n  NEW.updated_at := now(); -- keep 'it'\n  RETURN NEW;\nEND\n$body$ LANGUAGE plpgsql;";
  const t = sig(sqlTokens(fn));
  assert.deepEqual(t.filter(x => x.startsWith('dq:')), ['dq:$body$', 'dq:$body$']);
  for (const x of ['kw:BEGIN', 'fn:now', 'kw:RETURN', 'kw:END', "cm:-- keep 'it'", 'id:NEW.updated_at', 'fn:app.touch', 'kw:REPLACE']) assert.ok(t.includes(x), x);
  assert.equal(join(sqlTokens(fn)), fn);
  const doBlock = "DO $$ BEGIN RAISE NOTICE 'x'; END $$;";
  assert.ok(sig(sqlTokens(doBlock)).includes('kw:RAISE'));
  // Not a body: the text stays one string, keywords inside are not split out.
  const lit = "SELECT $tag$ it's SELECT -- no comment $tag$, $$x$$";
  assert.deepEqual(sig(sqlTokens(lit)), ['kw:SELECT', 'dq:$tag$', "str: it's SELECT -- no comment ", 'dq:$tag$', 'op:,', 'dq:$$', 'str:x', 'dq:$$']);
  // A $ inside an identifier is not a quote, $1 is a parameter.
  assert.deepEqual(sig(sqlTokens('SELECT a$b$c, $1')), ['kw:SELECT', 'id:a$b$c', 'op:,', 'param:$1']);
});

test('table names before a column list are identifiers, not calls', () => {
  const { sqlTokens } = load();
  const t = sig(sqlTokens('INSERT INTO app.orders (id, total) VALUES (1, round(2.5)); CREATE INDEX ix ON app.orders (total); WITH x AS (SELECT 1) SELECT * FROM x'));
  assert.ok(t.includes('id:app.orders') && !t.includes('fn:app.orders'));
  assert.ok(t.includes('fn:round') && t.includes('kw:VALUES') && t.includes('kw:WITH'));
});

test('step markers in comments and lone transaction statements are section headers', () => {
  const { sqlTokens, sqlLines, sqlStepLine } = load();
  const script = ['-- ===== 1. BEGIN =====', 'BEGIN;', '-- 2. DEFINE: scope', '-- Step 3 - PROCESS', '-- 4) MATCH', '-- 5. CORRECT or FAIL',
    '-- ROLLBACK (swap for COMMIT after review)', 'ROLLBACK;', 'BEGIN TRANSACTION READ ONLY;', '-- begin by checking counts', '-- Defines the scope',
    '-- ROLLBACK with COMMIT only if every check is correct.', '-- MATCHES the old run',
    'SELECT 1; -- MATCH', '  UPDATE app.orders SET total = 0 WHERE id = 1;'].join('\r\n');
  const lines = sqlLines(sqlTokens(script));
  assert.equal(lines.length, 15);
  assert.deepEqual(Array.from(lines, l => sqlStepLine(l)), [true, true, true, true, true, true, true, true, true, false, false, false, false, false, false]);
  assert.ok(lines.every(l => l.every(tk => !tk.v.includes('\n') && !tk.v.endsWith('\r'))));
  assert.equal(lines.map(l => l.map(tk => tk.v).join('')).join('\r\n'), script);
});

test('lines keep their indentation width for the hanging soft wrap', () => {
  const { sqlTokens, sqlLines, sqlIndent } = load();
  const lines = sqlLines(sqlTokens('SELECT\n    a,\n\tb\n  -- Script file : C:\\very\\long\\path\\to\\a\\script.sql\n\n'));
  assert.deepEqual(Array.from(lines, l => sqlIndent(l)), [0, 4, 4, 2, 0, 0]);
  assert.equal(lines[4].length, 0, 'an empty line has no tokens');
});

test('a very long script tokenizes in linear time', () => {
  const { sqlTokens } = load();
  const chunk = "-- 3. PROCESS\nUPDATE app.orders SET note = 'a''b -- c', total = total * 1.1 WHERE id = $1 AND region = :region; /* x */\n";
  const big = chunk.repeat(20000);
  const t0 = performance.now();
  const tokens = sqlTokens(big);
  const ms = performance.now() - t0;
  assert.equal(join(tokens), big);
  assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
  // An unterminated dollar quote at the start of a long text stays linear too.
  const open = 'SELECT $$' + 'x'.repeat(2_000_000);
  const t1 = performance.now();
  assert.equal(join(sqlTokens(open)), open);
  assert.ok(performance.now() - t1 < 3000);
});
