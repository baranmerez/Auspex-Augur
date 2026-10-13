// First line of defense: reject anything that is not a single read-only query.
// The real guarantees are the database role (SELECT-only grants) and the
// READ ONLY transaction + DECLARE CURSOR wrapper in db.js. This guard only
// fails fast with a clear message before the query reaches the server.

const allowedFirstKeywords = new Set(['select', 'with', 'values', 'table']);

// Other statement types (SET, BEGIN, VACUUM...) are already blocked by the
// first-keyword and single-statement checks; this list catches writes hidden
// inside an allowed statement: data-modifying CTEs and SELECT ... INTO.
const forbiddenKeywords = new Set([
  'insert', 'update', 'delete', 'merge', 'truncate', 'drop', 'alter', 'create',
  'grant', 'revoke', 'copy', 'call', 'into',
]);

// Functions with side effects or file/network access that a read-only role
// may still be allowed to call.
const forbiddenFunctions = [
  /^set_config$/, /^pg_terminate_backend$/, /^pg_cancel_backend$/,
  /^pg_reload_conf$/, /^pg_rotate_logfile$/, /^pg_sleep/, /^pg_advisory/,
  /^pg_try_advisory/, /^lo_/, /^dblink/, /^pg_read_/, /^pg_ls_/, /^pg_stat_file$/,
  /^nextval$/, /^setval$/, /^pg_notify$/, /^pg_logical_/, /^pg_replication_/,
  /^pg_create_/, /^pg_drop_/, /^pg_switch_wal$/, /^pg_promote$/,
];

class SqlGuardError extends Error {}

// Masks string literals, quoted identifiers and comments so the keyword scan
// only sees real SQL tokens. Output length equals input length, so positions
// found in the masked text are valid in the original.
function stripLiteralsAndComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  const mask = (start, fill) => { out += fill(i - start); };
  const blank = len => ' '.repeat(len);
  const quoted = q => len => q + ' '.repeat(Math.max(len - 2, 0)) + (len > 1 ? q : '');
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    const start = i;
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      mask(start, blank);
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) throw new SqlGuardError('Unterminated block comment.');
      mask(start, blank);
    } else if (c === "'") {
      const escaped = /[eE]/.test(sql[i - 1] || '') && !/[A-Za-z0-9_]/.test(sql[i - 2] || '');
      i++;
      let closed = false;
      while (i < n) {
        if (escaped && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new SqlGuardError('Unterminated string literal.');
      mask(start, quoted("'"));
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new SqlGuardError('Unterminated quoted identifier.');
      mask(start, quoted('"'));
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]/.test(sql[i - 1] || '')) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) throw new SqlGuardError('Unterminated dollar-quoted string.');
        i = end + tag.length;
        mask(start, quoted("'"));
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Returns the query without a trailing semicolon, or throws SqlGuardError.
export function assertReadOnlyQuery(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new SqlGuardError('Query is empty.');

  const stripped = stripLiteralsAndComments(sql);
  const body = stripped.replace(/;\s*$/, '');
  if (body.includes(';')) throw new SqlGuardError('Only a single statement is allowed.');

  const words = body.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) || [];
  if (!words.length) throw new SqlGuardError('Query is empty.');
  if (!allowedFirstKeywords.has(words[0])) {
    throw new SqlGuardError(`Only SELECT, WITH, VALUES or TABLE queries are allowed (got "${words[0].toUpperCase()}").`);
  }

  const badKeyword = words.find(w => forbiddenKeywords.has(w));
  if (badKeyword) throw new SqlGuardError(`Keyword "${badKeyword.toUpperCase()}" is not allowed.`);

  const calls = body.toLowerCase().matchAll(/([a-z_][a-z0-9_$]*)\s*\(/g);
  for (const [, fn] of calls) {
    if (forbiddenFunctions.some(re => re.test(fn))) throw new SqlGuardError(`Function "${fn}" is not allowed.`);
  }

  return sql.slice(0, body.length).trim();
}

export { SqlGuardError, stripLiteralsAndComments };
