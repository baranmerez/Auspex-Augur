// Textual inference of the tables a SQL or PL/pgSQL function reads and
// writes, from its pg_get_functiondef text. Pure: no database, no files.
// This is NOT a catalog fact (PostgreSQL records no dependencies for function
// bodies); dynamic SQL (EXECUTE of a string) is invisible to it.
//
// The body is the dollar-quoted (or quoted) text after AS; it is parsed, not
// stripped. Inside it, comments, string literals and nested dollar-quoted
// strings are skipped. FROM / JOIN targets (and USING in MERGE / DELETE) are
// reads; INSERT INTO, UPDATE, DELETE FROM, MERGE INTO and TRUNCATE targets are
// writes. An unqualified name keeps the function's schema (pg_* names:
// pg_catalog). CTE names, parameters, declared variables, loop variables,
// temporary tables created in the body and NEW / OLD are dropped.

export const maxTouches = 50;
export const touchLanguages = ['sql', 'plpgsql'];

const identStart = /[\p{L}_]/u;
const identPart = /[\p{L}\p{N}_$]/u;

// Tokens: { t: 'id', v: lower-case or quoted name, q: quoted } | { t: 'p', v: punctuation } |
// { t: 'lit', v: text inside the quotes, dollar: bool } | { t: 'num' } | { t: 'param' }.
export function lexSql(text) {
  const s = String(text ?? '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && s[i + 1] === '-') {
      const end = s.indexOf('\n', i);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      // Block comments nest in PostgreSQL.
      let depth = 1;
      i += 2;
      while (i < s.length && depth) {
        if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      continue;
    }
    if (c === '\'' || ((c === 'E' || c === 'e') && s[i + 1] === '\'' && !identPart.test(s[i - 1] ?? ' '))) {
      const escapes = c !== '\'';
      i += escapes ? 2 : 1;
      let value = '';
      while (i < s.length) {
        if (escapes && s[i] === '\\') { value += s[i + 1] ?? ''; i += 2; continue; }
        if (s[i] === '\'') {
          if (s[i + 1] === '\'') { value += '\''; i += 2; continue; }
          i++;
          break;
        }
        value += s[i++];
      }
      out.push({ t: 'lit', v: value, dollar: false });
      continue;
    }
    if (c === '$') {
      const m = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(s.slice(i, i + 200));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        const stop = end < 0 ? s.length : end;
        out.push({ t: 'lit', v: s.slice(i + tag.length, stop), dollar: true });
        i = end < 0 ? s.length : end + tag.length;
        continue;
      }
      const p = /^\$\d+/.exec(s.slice(i, i + 12));
      if (p) { out.push({ t: 'param' }); i += p[0].length; continue; }
      out.push({ t: 'p', v: '$' });
      i++;
      continue;
    }
    if (c === '"') {
      let value = '';
      i++;
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') { value += '"'; i += 2; continue; }
          i++;
          break;
        }
        value += s[i++];
      }
      out.push({ t: 'id', v: value, q: true });
      continue;
    }
    if (identStart.test(c)) {
      let j = i + 1;
      while (j < s.length && identPart.test(s[j])) j++;
      out.push({ t: 'id', v: s.slice(i, j).toLowerCase(), q: false });
      i = j;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[\d.eE]/.test(s[j])) j++;
      out.push({ t: 'num' });
      i = j;
      continue;
    }
    out.push({ t: 'p', v: c });
    i++;
  }
  return out;
}

const isId = (tok, word) => tok?.t === 'id' && !tok.q && (word === undefined || tok.v === word);
const isP = (tok, v) => tok?.t === 'p' && tok.v === v;

// Words that are never a table name or an alias where this module looks.
const keywords = new Set([
  'select', 'from', 'where', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'on', 'using',
  'group', 'order', 'by', 'having', 'limit', 'offset', 'fetch', 'union', 'except', 'intersect', 'window', 'for',
  'returning', 'set', 'values', 'into', 'as', 'lateral', 'only', 'with', 'loop', 'then', 'when', 'else', 'end',
  'and', 'or', 'not', 'in', 'is', 'case', 'begin', 'if', 'return', 'do', 'default', 'table', 'insert', 'update',
  'delete', 'merge', 'truncate', 'tablesample', 'strict', 'perform', 'execute', 'raise', 'exception', 'declare',
]);

// Functions whose argument list uses FROM as a word: EXTRACT(x FROM y), ...
const fromInsideCall = new Set(['extract', 'substring', 'trim', 'overlay', 'normalize']);

// Index after the parenthesized group starting at tokens[i] ('(').
function skipGroup(tokens, i) {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    if (isP(tokens[j], '(')) depth++;
    else if (isP(tokens[j], ')') && --depth === 0) return j + 1;
  }
  return tokens.length;
}

// A possibly qualified name at tokens[i]: { parts, next } or null.
function nameAt(tokens, i) {
  const first = tokens[i];
  if (first?.t !== 'id' || (!first.q && keywords.has(first.v))) return null;
  const parts = [first.v];
  let j = i + 1;
  while (isP(tokens[j], '.') && tokens[j + 1]?.t === 'id') {
    parts.push(tokens[j + 1].v);
    j += 2;
  }
  return { parts, quoted: first.q, next: j };
}

// Names of the arguments in a parenthesized list starting at tokens[i]:
// the first identifier of each comma-separated argument after the mode,
// when the argument has more than one token (a bare type has no name).
function argumentNames(tokens, i) {
  const names = [];
  const end = skipGroup(tokens, i) - 1;
  let arg = [];
  let depth = 0;
  const flush = () => {
    const rest = arg[0] && isId(arg[0]) && ['in', 'out', 'inout', 'variadic'].includes(arg[0].v) ? arg.slice(1) : arg;
    if (rest.length > 1 && rest[0].t === 'id') names.push(rest[0].v);
    arg = [];
  };
  for (let j = i + 1; j < end; j++) {
    const tok = tokens[j];
    if (isP(tok, '(')) depth++;
    if (isP(tok, ')')) depth--;
    if (depth === 0 && isP(tok, ',')) flush();
    else arg.push(tok);
  }
  flush();
  return names;
}

// Parameter names from the CREATE FUNCTION header (incl. OUT parameters) and
// the columns of RETURNS TABLE(...).
function headerNames(tokens) {
  const names = [];
  const fn = tokens.findIndex(t => isId(t, 'function') || isId(t, 'procedure'));
  if (fn >= 0) {
    const name = nameAt(tokens, fn + 1);
    if (name && isP(tokens[name.next], '(')) names.push(...argumentNames(tokens, name.next));
  }
  for (let j = 0; j + 2 < tokens.length; j++) {
    if (isId(tokens[j], 'returns') && isId(tokens[j + 1], 'table') && isP(tokens[j + 2], '(')) names.push(...argumentNames(tokens, j + 2));
  }
  return names;
}

// The function body: the first quoted literal after AS in the definition;
// a single-quoted body is unescaped by the lexer already. Without one (SQL
// standard bodies, BEGIN ATOMIC / RETURN), the whole definition.
function bodyTokens(defTokens) {
  for (let j = 0; j + 1 < defTokens.length; j++) {
    if (isId(defTokens[j], 'as') && defTokens[j + 1].t === 'lit') return lexSql(defTokens[j + 1].v);
  }
  return defTokens;
}

// Names a body defines for itself: CTEs, declared variables, loop variables,
// temporary tables.
function localNames(tokens) {
  const names = new Set(['new', 'old']);
  for (let j = 0; j < tokens.length; j++) {
    const tok = tokens[j];
    // name AS [NOT] [MATERIALIZED] (   or   name (cols) AS (
    if (tok.t === 'id') {
      let k = j + 1;
      if (isP(tokens[k], '(')) k = skipGroup(tokens, k);
      if (isId(tokens[k], 'as')) {
        let m = k + 1;
        if (isId(tokens[m], 'not')) m++;
        if (isId(tokens[m], 'materialized')) m++;
        if (isP(tokens[m], '(') && (k === j + 1 || isP(tokens[j + 1], '('))) {
          const prev = tokens[j - 1];
          // CAST(x AS (...)) does not exist; "with name as (" and ", name as (" are CTEs.
          if (isId(prev, 'with') || isId(prev, 'recursive') || isP(prev, ',') || isId(prev, 'table')) names.add(tok.v);
        }
      }
    }
    // FOR name IN / FOREACH name IN: loop variables (records or scalars).
    if ((isId(tok, 'for') || isId(tok, 'foreach')) && tokens[j + 1]?.t === 'id' && isId(tokens[j + 2], 'in')) names.add(tokens[j + 1].v);
    // DECLARE name type ...; name type ...; up to BEGIN.
    if (isId(tok, 'declare')) {
      let start = true;
      for (let k = j + 1; k < tokens.length && !isId(tokens[k], 'begin'); k++) {
        if (start && tokens[k].t === 'id') names.add(tokens[k].v);
        start = isP(tokens[k], ';');
      }
    }
    // CREATE [GLOBAL | LOCAL] TEMP[ORARY] [UNLOGGED] TABLE [IF NOT EXISTS] name
    if (isId(tok, 'create')) {
      let k = j + 1;
      while (isId(tokens[k], 'global') || isId(tokens[k], 'local')) k++;
      if (isId(tokens[k], 'temp') || isId(tokens[k], 'temporary')) {
        k++;
        if (isId(tokens[k], 'unlogged')) k++;
        if (isId(tokens[k], 'table')) {
          k++;
          if (isId(tokens[k], 'if') && isId(tokens[k + 1], 'not') && isId(tokens[k + 2], 'exists')) k += 3;
          const name = nameAt(tokens, k);
          if (name?.parts.length === 1) names.add(name.parts[0]);
        }
      }
    }
  }
  return names;
}

const keyPart = name => (/[."]/.test(name) ? `"${name.replace(/"/g, '""')}"` : name);

// Statement verbs that decide what USING means.
const verbs = new Set(['select', 'insert', 'update', 'delete', 'merge', 'truncate', 'perform', 'execute', 'return']);

/**
 * touches({ definition, schema, language, arguments? }) ->
 *   { inferred: true, reads: ["schema.table", ...], writes: [...] } or null
 * null when the language is not sql or plpgsql, or there is no definition.
 */
export function functionTouches({ definition, schema, language, arguments: args = '' } = {}) {
  if (!definition || !touchLanguages.includes(String(language ?? '').toLowerCase())) return null;
  const defTokens = lexSql(definition);
  const tokens = bodyTokens(defTokens);
  const drop = localNames(tokens);
  for (const name of headerNames(defTokens)) drop.add(name);
  for (const name of argumentNames(lexSql(`(${args})`), 0)) drop.add(name);
  const reads = new Set();
  const writes = new Set();
  const add = (set, name) => {
    if (!name) return;
    let parts = name.parts.slice(-2);
    if (parts.length === 1) {
      if (drop.has(parts[0])) return;
      parts = [!name.quoted && parts[0].startsWith('pg_') ? 'pg_catalog' : schema, parts[0]];
    }
    set.add(`${keyPart(parts[0])}.${keyPart(parts[1])}`);
  };
  // One relation at tokens[i] (after ONLY / LATERAL); returns the index after
  // it and its alias, and whether it was a relation name.
  // INSERT INTO name (columns): the group after a write target is a column list.
  const item = (i, set, target = false) => {
    while (isId(tokens[i], 'only') || isId(tokens[i], 'lateral')) i++;
    let next;
    if (isP(tokens[i], '(')) next = skipGroup(tokens, i);
    else {
      const name = nameAt(tokens, i);
      if (!name) return i;
      if (isP(tokens[name.next], '(') && !target) next = skipGroup(tokens, name.next); // a function call
      else {
        add(set, name);
        next = name.next;
        if (isP(tokens[next], '*')) next++; // ONLY-style "table *"
      }
    }
    if (isId(tokens[next], 'as')) next++;
    if (tokens[next]?.t === 'id' && (tokens[next].q || !keywords.has(tokens[next].v))) {
      next++;
      if (isP(tokens[next], '(')) next = skipGroup(tokens, next); // alias column list
    }
    return next;
  };
  const opener = [];
  let verb = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = tokens[i - 1];
    if (isP(tok, '(')) { opener.push(prev?.t === 'id' ? prev.v : null); continue; }
    if (isP(tok, ')')) { opener.pop(); continue; }
    if (isP(tok, ';')) { verb = null; continue; }
    if (tok.t !== 'id' || tok.q) continue;
    if (verbs.has(tok.v)) verb = tok.v;
    switch (tok.v) {
      case 'from': {
        if (isId(prev, 'delete')) { item(i + 1, writes); break; }
        if (isId(prev, 'distinct') || fromInsideCall.has(opener.at(-1))) break;
        // FROM a, b, c
        let j = item(i + 1, reads);
        while (isP(tokens[j], ',')) j = item(j + 1, reads);
        break;
      }
      case 'join':
        item(i + 1, reads);
        break;
      case 'into':
        if (isId(prev, 'insert') || isId(prev, 'merge')) item(i + 1, writes, true);
        break;
      case 'update':
        // FOR [NO KEY] UPDATE, ON CONFLICT DO UPDATE, BEFORE UPDATE are not targets.
        if (!['for', 'key', 'do', 'before', 'after', 'or', 'of'].some(w => isId(prev, w)) && !isId(tokens[i + 1], 'set')) item(i + 1, writes);
        break;
      case 'truncate': {
        let j = i + 1;
        if (isId(tokens[j], 'table')) j++;
        j = item(j, writes);
        while (isP(tokens[j], ',')) j = item(j + 1, writes);
        break;
      }
      case 'using':
        if ((verb === 'merge' || verb === 'delete') && !isP(tokens[i + 1], '(')) item(i + 1, reads);
        break;
      default:
    }
  }
  const sorted = set => [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, maxTouches);
  return { inferred: true, reads: sorted(reads), writes: sorted(writes) };
}

/**
 * Functions a definition's body calls, as written: [{ schema: string | null, name }].
 * Used to find which stored functions call which (graph calledBy). Comments
 * and string literals do not count.
 */
export function functionCalls(definition) {
  if (!definition) return [];
  const tokens = bodyTokens(lexSql(definition));
  const out = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].t !== 'id' || isP(tokens[i - 1], '.') || isId(tokens[i - 1], 'into')) continue;
    const name = nameAt(tokens, i);
    if (!name || !isP(tokens[name.next], '(')) continue;
    const parts = name.parts.slice(-2);
    const ref = parts.length === 2 ? { schema: parts[0], name: parts[1] } : { schema: null, name: parts[0] };
    out.set(`${ref.schema ?? ''}\n${ref.name}`, ref);
    i = name.next - 1;
  }
  return [...out.values()];
}
