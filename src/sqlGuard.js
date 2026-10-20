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
  // Built-ins that run SQL passed to them as text, which this guard never
  // sees: query_to_xml('select pg_advisory_lock(1)', ...), ts_stat('...').
  /^query_to_xml/, /^cursor_to_xml/, /^ts_stat$/, /^ts_rewrite$/,
];

class SqlGuardError extends Error {
  errorCode = 'SQL_REJECTED'; // src/errors.js
}

// Decodes the body of a U&"..." identifier: \XXXX and \+XXXXXX code points and
// a doubled escape character, with the escape character from UESCAPE if given.
function decodeUnicodeIdentifier(body, escape) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== escape) { out += body[i]; continue; }
    if (body[i + 1] === escape) { out += escape; i++; continue; }
    const long = body[i + 1] === '+';
    const hex = long ? body.slice(i + 2, i + 8) : body.slice(i + 1, i + 5);
    if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== (long ? 6 : 4)) {
      throw new SqlGuardError('Invalid Unicode escape in quoted identifier.');
    }
    out += String.fromCodePoint(parseInt(hex, 16));
    i += long ? 7 : 4;
  }
  return out;
}

// An E-string keeps its escape mode when another quoted fragment follows
// whitespace containing a newline. PostgreSQL permits line comments in that
// gap, but not block comments. Skip whole comments so their quotes cannot be
// mistaken for a continuation delimiter.
function escapeStringContinuationEnd(sql, start) {
  let cursor = start;
  let hasNewline = false;
  while (cursor < sql.length) {
    const character = sql[cursor];
    if (character === '\n' || character === '\r') {
      hasNewline = true;
      cursor++;
    } else if (character === ' ' || character === '\t' || character === '\f' || character === '\v') {
      // Newer PostgreSQL lexers count \v as whitespace too; treating it as a
      // gap only makes the guard stricter on servers that do not.
      cursor++;
    } else if (character === '-' && sql[cursor + 1] === '-') {
      cursor += 2;
      while (cursor < sql.length && sql[cursor] !== '\n' && sql[cursor] !== '\r') cursor++;
    } else {
      break;
    }
  }
  return hasNewline && sql[cursor] === "'" ? cursor + 1 : null;
}

// Masks string literals, quoted identifiers and comments so the keyword scan
// only sees real SQL tokens. Output length equals input length, so positions
// found in the masked text are valid in the original. When `identifiers` is
// an array, every quoted identifier is pushed to it as { end, name }, where
// end is the index after the closing quote and name is the real (decoded,
// case-preserved) identifier.
function stripLiteralsAndComments(sql, identifiers = null) {
  let out = '';
  let i = 0;
  const n = sql.length;
  const unicodeIds = [];
  const mask = (start, fill) => { out += fill(i - start); };
  const blank = len => ' '.repeat(len);
  const quoted = q => len => q + ' '.repeat(Math.max(len - 2, 0)) + (len > 1 ? q : '');
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    const start = i;
    if (c === '-' && next === '-') {
      // PostgreSQL and psql end a line comment at LF or CR.
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
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
          const continuationEnd = escaped ? escapeStringContinuationEnd(sql, i) : null;
          if (continuationEnd !== null) { i = continuationEnd; continue; }
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
      if (identifiers) {
        const name = sql.slice(start + 1, i - 1).replace(/""/g, '"');
        const unicode = /^[uU]&$/.test(sql.slice(start - 2, start)) && !/[A-Za-z0-9_$]/.test(sql[start - 3] || '');
        // U&"..." is decoded once the whole text is masked (see below), since
        // a UESCAPE clause may follow after comments.
        if (unicode) unicodeIds.push({ end: i, body: name });
        else identifiers.push({ end: i, name });
      }
      mask(start, quoted('"'));
    } else if (c === '$') {
      // PostgreSQL tags allow non-ASCII identifier characters, but not an embedded $.
      const m = /^\$([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[i - 1] || '')) {
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
  // Decode U&"..." identifiers on the masked text, where comments are blanks,
  // so "U&"x" -- c<newline> UESCAPE '!'" is read the way PostgreSQL reads it.
  for (const u of unicodeIds) {
    const m = /^\s*uescape\s*'/i.exec(out.slice(u.end));
    if (!m) {
      // PostgreSQL also accepts escape strings here. Do not silently treat an
      // unparsed UESCAPE clause as though it were absent.
      if (/^\s*uescape\b/i.test(out.slice(u.end))) {
        throw new SqlGuardError('UESCAPE requires a plain single-character string literal.');
      }
      identifiers.push({ end: u.end, name: decodeUnicodeIdentifier(u.body, '\\') });
      continue;
    }
    const quote = u.end + m[0].length - 1; // opening quote of the escape literal
    if (sql[quote] !== "'" || sql[quote + 2] !== "'" || sql[quote + 1] === "'") throw new SqlGuardError('Invalid UESCAPE clause.');
    // A continued escape literal moves the end of the identifier token. Until
    // that spelling is decoded, reject it rather than losing the function name.
    if (/^\s*'/.test(out.slice(quote + 3))) throw new SqlGuardError('Continued UESCAPE literals are not supported.');
    const name = decodeUnicodeIdentifier(u.body, sql[quote + 1]);
    // With UESCAPE the token before "(" is the escape literal.
    identifiers.push({ end: u.end, name }, { end: quote + 3, name });
  }
  return out;
}

// Names of everything called like a function: the identifier right before each
// "(" (comments are already blanked). Unquoted names fold to lower case like
// PostgreSQL does; quoted names keep their exact spelling, so "pg_sleep"(0),
// pg_catalog."pg_sleep"(0) and U&"pg\005fsleep"(0) all yield pg_sleep.
function functionNames(masked, identifiers) {
  const byEnd = new Map(identifiers.map(q => [q.end, q.name]));
  const names = [];
  for (let p = masked.indexOf('('); p >= 0; p = masked.indexOf('(', p + 1)) {
    let j = p - 1;
    while (j >= 0 && /\s/.test(masked[j])) j--;
    if (byEnd.has(j + 1)) {
      names.push(byEnd.get(j + 1));
      continue;
    }
    // Walk back over the identifier characters only, so the work per "(" is
    // its own name, not the whole text before it. The name starts at the
    // first letter or underscore of that run, as an unquoted identifier does.
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(masked[k])) k--;
    const run = masked.slice(k + 1, j + 1);
    const start = run.search(/[A-Za-z_]/);
    if (start >= 0) names.push(run.slice(start).toLowerCase());
  }
  return names;
}

// SQL from a caller that is longer than this is refused before it is scanned
// or sent anywhere. SQL that Auspex generates itself (profile_tables batches)
// passes maxLength: Infinity; the scan is linear either way.
export const maxSqlLength = 256 * 1024;

// Returns the query without a trailing semicolon, or throws SqlGuardError.
export function assertReadOnlyQuery(sql, { maxLength = maxSqlLength } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) throw new SqlGuardError('Query is empty.');
  if (sql.length > maxLength) {
    throw new SqlGuardError(`Query is too long (${sql.length} characters; at most ${maxLength}).`);
  }

  const identifiers = [];
  const stripped = stripLiteralsAndComments(sql, identifiers);
  const body = stripped.replace(/;\s*$/, '');
  if (body.includes(';')) throw new SqlGuardError('Only a single statement is allowed.');

  const words = body.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) || [];
  if (!words.length) throw new SqlGuardError('Query is empty.');
  if (!allowedFirstKeywords.has(words[0])) {
    throw new SqlGuardError(`Only SELECT, WITH, VALUES or TABLE queries are allowed (got "${words[0].toUpperCase()}").`);
  }

  const badKeyword = words.find(w => forbiddenKeywords.has(w));
  if (badKeyword) throw new SqlGuardError(`Keyword "${badKeyword.toUpperCase()}" is not allowed.`);

  for (const fn of functionNames(body, identifiers)) {
    if (forbiddenFunctions.some(re => re.test(fn))) throw new SqlGuardError(`Function "${fn}" is not allowed.`);
  }

  return sql.slice(0, body.length).trim();
}

export { SqlGuardError, stripLiteralsAndComments };
