// Report library on disk, grouped by database (profile), schema and category:
//   <library>/_drafts/<db>/<schema>/<category>/<name>.sql|.report.json|.html   work in progress
//   <library>/SELECT/<db>/<schema>/<category>/<name>.sql|.report.json|.html    approved read-only reports
//   <library>/EXECUTE/<db>/<schema>/<category>/<name>.sql                      change scripts for a human
// <db> is the Auspex profile name. The library is user-specific and lives
// outside any repository by default.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertReadOnlyQuery, stripLiteralsAndComments } from '../sqlGuard.js';
import { withFileLock, renameRetrying } from '../fileLock.js';

export const stages = { draft: '_drafts', approved: 'SELECT', execute: 'EXECUTE' };
const maxRuns = 100;
const reservedChars = /[<>:"/\\|?*\u0000-\u001f]/;

// errorCode (src/errors.js): INVALID_INPUT unless the throw site says otherwise.
export class LibraryError extends Error {
  constructor(message, errorCode = 'INVALID_INPUT') {
    super(message);
    this.errorCode = errorCode;
  }
}

const trMap = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u' };

// File name: ASCII kebab-case so it works in every shell and tool.
export function slugify(name) {
  const slug = String(name || '').normalize('NFC').replace(/[çğıöşüÇĞİÖŞÜ]/g, ch => trMap[ch])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!slug) throw new LibraryError('Report name must contain letters or digits.');
  return slug;
}

// One folder level (db, schema or category): readable, Turkish allowed, no path tricks.
export function validateSegment(value, label) {
  const v = String(value || '').normalize('NFC').trim();
  if (!v) throw new LibraryError(`${label} is required.`);
  if (v.length > 80) throw new LibraryError(`${label} is too long (max 80 characters).`);
  if (reservedChars.test(v) || v.startsWith('.') || v.endsWith('.')) {
    throw new LibraryError(`Invalid ${label.toLowerCase()} "${v}": no slashes, reserved characters or leading/trailing dots.`);
  }
  return v;
}

// Normalizes a report location { db, schema, category, name }.
export function normalizeRef(ref) {
  return {
    db: validateSegment(ref.db, 'Database (profile)').toLowerCase(),
    schema: validateSegment(ref.schema, 'Schema'),
    category: validateSegment(ref.category, 'Category'),
    name: slugify(ref.name),
  };
}

export const refLabel = r => `${r.db}/${r.schema}/${r.category}/${r.name}`;
export const sqlHash = sql => crypto.createHash('sha256').update(normalizeSql(sql)).digest('hex').slice(0, 12);
const normalizeSql = sql => String(sql).replace(/\r\n/g, '\n').trim();

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  renameRetrying(tmp, file); // the viewer may be reading the target on Windows
}

export class Library {
  constructor(root) {
    this.root = path.resolve(root);
  }

  // Every read-modify-write of the library runs under one cross-process lock
  // (<library>/.lock), so concurrent Auspex processes cannot lose updates or
  // mix SQL and metadata revisions. Re-entrant within a process.
  locked(fn) {
    return withFileLock(path.join(this.root, '.lock'), fn);
  }

  ensure() {
    for (const dir of Object.values(stages)) fs.mkdirSync(path.join(this.root, dir), { recursive: true });
  }

  // Absolute base path (without extension), guaranteed inside the library.
  base(stage, ref) {
    if (!stages[stage]) throw new LibraryError(`Unknown stage "${stage}".`);
    const r = normalizeRef(ref);
    const file = path.join(this.root, stages[stage], r.db, r.schema, r.category, r.name);
    if (!file.startsWith(this.root + path.sep)) throw new LibraryError('Path escapes the library.');
    return file;
  }

  paths(stage, ref) {
    const b = this.base(stage, ref);
    return { sql: `${b}.sql`, meta: `${b}.report.json`, html: `${b}.html` };
  }

  exists(stage, ref) {
    return fs.existsSync(this.paths(stage, ref).sql);
  }

  // Draft first (work in progress), otherwise the approved report.
  locate(ref) {
    if (this.exists('draft', ref)) return 'draft';
    if (this.exists('approved', ref)) return 'approved';
    throw new LibraryError(`Report "${refLabel(normalizeRef(ref))}" not found in drafts or SELECT.`, 'NOT_FOUND');
  }

  readMeta(stage, ref) {
    const p = this.paths(stage, ref);
    return fs.existsSync(p.meta) ? JSON.parse(fs.readFileSync(p.meta, 'utf8')) : null;
  }

  readSql(stage, ref) {
    return fs.readFileSync(this.paths(stage, ref).sql, 'utf8');
  }

  writeMeta(stage, ref, meta) {
    writeAtomic(this.paths(stage, ref).meta, JSON.stringify(meta, null, 2) + '\n');
  }

  writeHtml(stage, ref, html) {
    writeAtomic(this.paths(stage, ref).html, html);
  }

  // Saves or updates a draft. The SQL must pass the read-only guard.
  saveDraft(input) {
    return this.locked(() => this.saveDraftUnlocked(input));
  }

  saveDraftUnlocked({ ref, title, description, sql, note, mask, unmask }) {
    assertReadOnlyQuery(sql);
    this.ensure();
    const r = normalizeRef(ref);
    const now = new Date().toISOString();
    const existing = this.readMeta('draft', r) || this.readMeta('approved', r);
    const meta = existing || {
      schema: 1, kind: 'select', ...r, title: title || ref.name, description: description || '',
      createdAt: now, sqlVersions: [], runs: [], last: null,
    };
    meta.status = 'draft';
    meta.updatedAt = now;
    if (title) meta.title = title;
    if (description !== undefined) meta.description = description;
    if (mask) meta.mask = mask;
    if (unmask) meta.unmask = unmask;
    const text = normalizeSql(sql);
    const hash = sqlHash(text);
    if (!meta.sqlVersions.some(v => v.hash === hash)) {
      meta.sqlVersions.push({ version: meta.sqlVersions.length + 1, hash, savedAt: now, note: note || null, sql: text });
    }
    // The active revision is the SQL just saved, which after a revert is an
    // older entry, not the last one in sqlVersions.
    const version = meta.sqlVersions.find(v => v.hash === hash).version;
    meta.activeHash = hash;
    meta.activeVersion = version;
    const p = this.paths('draft', r);
    writeAtomic(p.sql, text + '\n');
    this.writeMeta('draft', r, meta);
    return { ref: r, stage: 'draft', version, paths: p };
  }

  appendRun(stage, ref, run, last) {
    return this.locked(() => this.appendRunUnlocked(stage, ref, run, last));
  }

  appendRunUnlocked(stage, ref, run, last) {
    const meta = this.readMeta(stage, ref);
    if (!meta) throw new LibraryError('Report metadata missing; save the report first.', 'NOT_FOUND');
    meta.runs.push(run);
    if (meta.runs.length > maxRuns) meta.runs = meta.runs.slice(-maxRuns);
    meta.last = last;
    meta.updatedAt = run.at;
    this.writeMeta(stage, ref, meta);
    return meta;
  }

  // Moves a draft into SELECT/..., replacing an older approved version.
  approve(ref) {
    return this.locked(() => this.approveUnlocked(ref));
  }

  approveUnlocked(ref) {
    const r = normalizeRef(ref);
    if (!this.exists('draft', r)) throw new LibraryError(`No draft "${refLabel(r)}" to approve.`, 'NOT_FOUND');
    const from = this.paths('draft', r);
    const to = this.paths('approved', r);
    const meta = this.readMeta('draft', r);
    // Approve exactly the SQL in the draft file, found by its hash.
    const hash = sqlHash(fs.readFileSync(from.sql, 'utf8'));
    const version = meta.sqlVersions.find(v => v.hash === hash)?.version;
    if (version === undefined) throw new LibraryError(`The draft SQL of "${refLabel(r)}" matches no saved version; save it with save_report first.`, 'PRECONDITION_FAILED');
    // Only SQL that has run successfully (every entry in meta.runs is a success) can be approved.
    if (!(meta.runs || []).some(x => x.sqlHash === hash)) throw new LibraryError(`Version ${version} of "${refLabel(r)}" has no successful run; run it with run_report before approving.`, 'PRECONDITION_FAILED');
    meta.status = 'approved';
    meta.approvedAt = new Date().toISOString();
    meta.activeHash = hash;
    meta.activeVersion = version;
    meta.approvedVersion = version;
    writeAtomic(to.meta, JSON.stringify(meta, null, 2) + '\n');
    fs.copyFileSync(from.sql, to.sql);
    if (fs.existsSync(from.html)) fs.copyFileSync(from.html, to.html);
    for (const f of Object.values(from)) fs.rmSync(f, { force: true });
    this.pruneEmpty(path.dirname(from.sql), path.join(this.root, stages.draft));
    return { ref: r, stage: 'approved', paths: to, meta };
  }

  // Hash of the SQL the report currently stands for: the recorded active
  // revision, or for reports saved before that field existed, the SQL file.
  activeHash(stage, ref, meta) {
    return meta?.activeHash ?? sqlHash(this.readSql(stage, ref));
  }

  pruneEmpty(dir, stopAt) {
    let d = dir;
    while (d.startsWith(stopAt + path.sep)) {
      try {
        if (fs.readdirSync(d).length) return;
        fs.rmdirSync(d);
      } catch { return; }
      d = path.dirname(d);
    }
  }

  // Every report and script: stage, db, schema, category, name, last run.
  list() {
    const out = [];
    for (const [stage, dir] of Object.entries(stages)) {
      const base = path.join(this.root, dir);
      const sub = p => (fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : []);
      for (const db of sub(base)) for (const schema of sub(path.join(base, db))) for (const category of sub(path.join(base, db, schema))) {
        for (const f of fs.readdirSync(path.join(base, db, schema, category)).filter(x => x.endsWith('.sql'))) {
          const ref = { db, schema, category, name: f.slice(0, -4) };
          const meta = stage === 'execute' ? null : this.readMeta(stage, ref);
          const externalFile = stage === 'execute' ? this.executeInfo(ref)?.externalFile : null;
          const lastRun = meta?.runs?.at(-1);
          const file = path.join(base, db, schema, category, f);
          out.push({
            stage, ...ref, ...(externalFile ? { externalFile } : {}), title: meta?.title ?? ref.name, description: meta?.description || null,
            versions: meta?.sqlVersions?.length ?? null, approvedVersion: meta?.approvedVersion ?? null,
            updatedAt: meta?.updatedAt ?? fs.statSync(file).mtime.toISOString(),
            runs: meta?.runs?.length ?? 0,
            lastRun: lastRun ? { at: lastRun.at, durationMs: lastRun.durationMs, rows: lastRun.rows, analyzed: lastRun.analyzed, warnings: lastRun.warnings?.length ?? 0 } : null,
          });
        }
      }
    }
    return out;
  }

  // Writes a change script for a human to run. Never executed by Auspex.
  saveExecuteScript(input) {
    return this.locked(() => this.saveExecuteScriptUnlocked(input));
  }

  // With target ({ root, dir, folder, fileName }) the script is also written to
  // <dir>/<folder>/<fileName>, a new file that never replaces an existing one;
  // the EXECUTE copy stays the library record and its .execute.json sidecar
  // records the external path. Nothing is written before every check passed.
  saveExecuteScriptUnlocked({ ref, title, purpose, relatedReport, expectedRows, sql, replace = false, target = null }) {
    const lint = lintExecuteScript(sql);
    if (lint.errors.length) throw new LibraryError(`EXECUTE script rejected:\n- ${lint.errors.join('\n- ')}`);
    this.ensure();
    const r = normalizeRef(ref);
    const base = this.base('execute', r);
    const file = `${base}.sql`;
    const sidecar = `${base}.execute.json`;
    if (fs.existsSync(file) && !replace) throw new LibraryError(`EXECUTE script already exists: ${file}. Pass replace=true to overwrite.`);
    const external = target ? prepareScriptTarget(target) : null;
    const header = [
      '-- =====================================================================',
      commentLines('', title || r.name),
      `-- Database       : ${r.db}   Schema: ${r.schema}   Category: ${r.category}`,
      commentLines('Purpose        : ', purpose || '-'),
      commentLines('Related report : ', relatedReport || '-'),
      commentLines('Expected rows  : ', expectedRows ?? '-'),
      ...(external ? [commentLines('Script file    : ', external.file)] : []),
      `-- Written        : ${new Date().toISOString()} by an AI agent via Auspex`,
      '-- NOT executed by Auspex. Run it yourself with a role that has the',
      '-- required privileges, review the MATCH results, then replace the final',
      '-- ROLLBACK with COMMIT only if every check is correct.',
      ...(lint.functionBodies ? [functionBodyNote] : []),
      '-- =====================================================================',
      '',
    ].join('\n');
    const text = header + normalizeSql(sql) + '\n';
    // The written file, header included, must pass the same checks as the body.
    const finalLint = lintExecuteScript(text);
    if (finalLint.errors.length) throw new LibraryError(`EXECUTE script rejected after adding the header:\n- ${finalLint.errors.join('\n- ')}`);
    const externalFile = external ? writeScriptTarget(external, text) : null;
    writeAtomic(file, text);
    if (external) {
      const info = { externalFile, root: external.root, folder: external.folder, fileName: external.fileName, savedAt: new Date().toISOString(), sqlHash: sqlHash(text) };
      writeAtomic(sidecar, JSON.stringify(info, null, 2) + '\n');
    } else {
      fs.rmSync(sidecar, { force: true }); // a replaced script no longer points at the old file
    }
    return { ref: r, file: externalFile ?? file, libraryFile: file, externalFile, warnings: lint.warnings };
  }

  // External file of an EXECUTE script saved into a script root, or null.
  executeInfo(ref) {
    try {
      return JSON.parse(fs.readFileSync(`${this.base('execute', ref)}.execute.json`, 'utf8'));
    } catch {
      return null;
    }
  }
}

// ---------- script roots ----------
// One folder or file name inside a script root: letters (Turkish included),
// digits, _ - and . only, so it cannot hold a separator, a drive, a space
// or a parent reference.
const scriptNamePattern = /^[\p{L}\p{N}_.-]+$/u;
const windowsReservedName = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const maxScriptName = 80;

export function validateScriptName(value, label, { sqlFile = false } = {}) {
  const v = String(value ?? '').normalize('NFC');
  if (!v) throw new LibraryError(`${label} is required.`);
  if (v.length > maxScriptName) throw new LibraryError(`${label} is too long (max ${maxScriptName} characters).`);
  if (!scriptNamePattern.test(v)) throw new LibraryError(`Invalid ${label.toLowerCase()} "${v}": use letters, digits, _, - and . only (one name, no spaces or path separators).`);
  // Windows drops trailing dots, so "x." would land on "x".
  if (v.includes('..') || v.startsWith('.') || v.endsWith('.')) throw new LibraryError(`Invalid ${label.toLowerCase()} "${v}": no "..", and no leading or trailing dot.`);
  if (windowsReservedName.test(v)) throw new LibraryError(`Invalid ${label.toLowerCase()} "${v}": reserved device name on Windows.`);
  if (sqlFile && !/\.sql$/i.test(v)) throw new LibraryError(`Invalid ${label.toLowerCase()} "${v}": it must end with .sql.`);
  return v;
}

// Real path of root/<folder> when it exists, null when it does not. Refused
// when it is not a folder directly inside the real root, for example a link
// or junction that points elsewhere.
function realFolderInside(realRoot, folderPath, t) {
  let real;
  try {
    real = fs.realpathSync.native(folderPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (path.dirname(real) !== realRoot) throw new LibraryError(`Folder "${t.folder}" of script root "${t.root}" resolves outside the root (link or junction); refused.`);
  if (!fs.statSync(real).isDirectory()) throw new LibraryError(`"${t.folder}" in script root "${t.root}" is not a folder.`);
  return real;
}

// Next free script number in a folder: one more than the highest NN_ prefix.
function nextScriptNumber(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* folder not created yet */ }
  const numbers = names.map(f => /^(\d+)_/.exec(f)?.[1]).filter(Boolean);
  const width = Math.max(2, ...numbers.map(n => n.length));
  return String(numbers.length ? Math.max(...numbers.map(Number)) + 1 : 0).padStart(width, '0');
}

function existsMessage(file, dir) {
  return `Script file already exists: ${file}. Auspex never overwrites it; choose a new file name, for example starting with ${nextScriptNumber(dir)}_.`;
}

// Checks a script-root target without writing anything.
function prepareScriptTarget({ root, dir, folder, fileName }) {
  const t = { root, dir, folder: validateScriptName(folder, 'Folder'), fileName: validateScriptName(fileName, 'File name', { sqlFile: true }) };
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(dir);
  } catch (err) {
    if (err.code === 'ENOENT') throw new LibraryError(`Script root "${root}" (${dir}) does not exist; create the folder or fix the configuration.`, 'NOT_FOUND');
    throw err;
  }
  if (!fs.statSync(realRoot).isDirectory()) throw new LibraryError(`Script root "${root}" (${dir}) is not a folder.`);
  t.realRoot = realRoot;
  t.folderPath = path.join(realRoot, t.folder);
  t.realFolder = realFolderInside(realRoot, t.folderPath, t);
  t.file = path.join(t.realFolder ?? t.folderPath, t.fileName);
  // lstat also sees a dangling link at the target name.
  if (t.realFolder && fs.lstatSync(t.file, { throwIfNoEntry: false })) throw new LibraryError(existsMessage(t.file, t.realFolder));
  return t;
}

// Creates the folder when missing, checks it again, and writes the file
// exclusively (wx): an existing file or link is never replaced.
function writeScriptTarget(t, text) {
  let realFolder = t.realFolder;
  if (!realFolder) {
    try {
      fs.mkdirSync(t.folderPath);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    realFolder = realFolderInside(t.realRoot, t.folderPath, t);
    if (!realFolder) throw new LibraryError(`Folder "${t.folder}" could not be created in script root "${t.root}".`);
  }
  const file = path.join(realFolder, t.fileName);
  try {
    fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw new LibraryError(existsMessage(file, realFolder));
    throw err;
  }
  return file;
}

// Turns metadata into SQL comment lines: every line of the value (LF, CRLF or
// lone CR) gets its own "-- " prefix, so no metadata can end up as SQL.
function commentLines(label, value) {
  const pad = ' '.repeat(label.length);
  return String(value).split(/\r\n|\r|\n/)
    .map((line, i) => `-- ${i ? pad : label}${line}`.trimEnd())
    .join('\n');
}

// Structural checks for change scripts, failing closed:
// - exactly one transaction envelope: BEGIN / START TRANSACTION first and a
//   plain ROLLBACK last; no other statement may start, end or prepare a
//   transaction (COMMIT, END, ABORT, a second BEGIN, an early ROLLBACK...).
//   SAVEPOINT, RELEASE and ROLLBACK TO stay inside it and are allowed.
// - no code the checks cannot see into: DO blocks, CALL, CREATE PROCEDURE,
//   and psql backslash commands are rejected.
// - CREATE [OR REPLACE] FUNCTION is allowed only with LANGUAGE plpgsql or sql
//   and one dollar-quoted body (AS $tag$ ... $tag$). The body is masked like
//   any literal: creating the function does not run it, so it is not linted
//   (functionBodies counts them; the saved file says so in its header).
//   CREATE [OR REPLACE] [CONSTRAINT] TRIGGER is allowed; its event list
//   (BEFORE UPDATE ...) is not a write.
// - every UPDATE and DELETE, also inside a CTE or subquery, needs its own
//   WHERE at its own parenthesis level; a WHERE inside a subquery does not count.
// Comments and string literals are ignored.
const transactionVerbs = new Set(['begin', 'start', 'commit', 'end', 'abort', 'rollback', 'prepare']);
const functionLanguages = new Set(['plpgsql', 'sql']);
export const functionBodyNote = '-- NOTE: function bodies are not linted by Auspex; review them before COMMIT';

// 'function', 'procedure' or 'trigger' when the statement creates one.
function createdRoutine(w) {
  if (w[0] !== 'create') return null;
  const k = w[1] === 'or' && w[2] === 'replace' ? 3 : 1;
  if (w[k] === 'constraint' && w[k + 1] === 'trigger') return 'trigger';
  return ['function', 'procedure', 'trigger'].includes(w[k]) ? w[k] : null;
}

// Why a CREATE FUNCTION statement is refused, or null. statement is masked
// text starting at offset start of the script; source is the original script,
// where a masked dollar-quoted body still starts with "$".
function functionProblem(statement, start, source, w) {
  const languages = w.flatMap((x, i) => (x === 'language' ? [w[i + 1]] : []));
  if (!languages.length || !languages.every(l => functionLanguages.has(l))) {
    return 'creates a function without LANGUAGE plpgsql or LANGUAGE sql (unquoted); other languages cannot be reviewed here.';
  }
  const bodies = [...statement.matchAll(/\bas\s+'/gi)].map(m => source[start + m.index + m[0].length - 1]);
  if (bodies.length !== 1 || bodies[0] !== '$') {
    return 'creates a function without exactly one dollar-quoted body (AS $tag$ ... $tag$).';
  }
  return null;
}

export function lintExecuteScript(sql) {
  const errors = [];
  const warnings = [];
  const source = String(sql || '');
  let masked;
  try {
    masked = stripLiteralsAndComments(source);
  } catch (err) {
    return { errors: [err.message], warnings, functionBodies: 0 };
  }
  // Statements with their offset in the script (masking keeps every offset).
  const parts = [];
  let offset = 0;
  for (const part of masked.split(';')) {
    const text = part.trim();
    if (text) parts.push({ text, start: offset + part.length - part.trimStart().length });
    offset += part.length + 1;
  }
  const statements = parts.map(p => p.text);
  if (!statements.length) return { errors: ['Script is empty.'], warnings, functionBodies: 0 };
  const words = s => s.toLowerCase().match(/[a-z_]+/g) || [];
  let functionBodies = 0;
  const createdFunctions = new Set();

  const first = words(statements[0]);
  if (!(first[0] === 'begin' || (first[0] === 'start' && first[1] === 'transaction'))) {
    errors.push('The first statement must be BEGIN (or START TRANSACTION).');
  }
  const last = words(statements.at(-1));
  if (!(last[0] === 'rollback' && last.length <= 2 && (last.length === 1 || ['work', 'transaction'].includes(last[1])))) {
    errors.push('The last statement must be ROLLBACK; whoever runs the script swaps it for COMMIT after review.');
  }
  statements.forEach((s, i) => {
    const n = i + 1;
    const w = words(s);
    const inside = i > 0 && i < statements.length - 1;
    if (w[0] === 'commit' || w[0] === 'end') {
      errors.push(`Statement ${n} is ${w[0].toUpperCase()}; COMMIT is never written into the script.`);
    } else if (inside && transactionVerbs.has(w[0]) && !(w[0] === 'rollback' && w[1] === 'to')) {
      errors.push(`Statement ${n} is ${w.slice(0, 2).join(' ').toUpperCase()}; only one BEGIN ... ROLLBACK envelope is allowed.`);
    }
    if (w[0] === 'do') errors.push(`Statement ${n} is a DO block; its body cannot be checked, write the statements directly.`);
    if (w[0] === 'call') errors.push(`Statement ${n} is CALL; procedures cannot be checked.`);
    // MERGE ... THEN DELETE / UPDATE acts on every matched row without a WHERE
    // of its own; write separate UPDATE/DELETE/INSERT statements instead.
    if (w.includes('merge') && w.includes('when')) errors.push(`Statement ${n} is a MERGE; its WHEN branches cannot be checked, write UPDATE/DELETE/INSERT with WHERE instead.`);
    const routine = createdRoutine(w);
    if (routine === 'function') {
      const problem = functionProblem(s, parts[i].start, source, w);
      if (problem) errors.push(`Statement ${n} ${problem}`);
      else functionBodies++;
      const name = /\bfunction\s+(?:[a-z_][a-z0-9_$]*\s*\.\s*)?([a-z_][a-z0-9_$]*)\s*\(/i.exec(s)?.[1];
      if (name) createdFunctions.add(name.toLowerCase());
      if (w.includes('security') && w.includes('definer')) warnings.push(`Statement ${n} creates a SECURITY DEFINER function; check its owner and that it sets search_path.`);
    } else if (routine === 'procedure' || (w[0] === 'create' && w.slice(1, 4).some(x => x === 'function' || x === 'procedure'))) {
      errors.push(`Statement ${n} creates a procedure or an unsupported function form; its body cannot be checked.`);
    }
    // psql commands can follow SQL on the same line; quoted/comment text is masked.
    if (s.includes('\\')) errors.push(`Statement ${n} contains a psql backslash command.`);
    if (routine !== 'trigger') for (const write of writesWithoutWhere(s)) errors.push(`Statement ${n} has ${write} without WHERE.`);
    // A body created above runs when the script calls it (triggers also fire on DML).
    if (!routine) {
      const called = [...s.matchAll(/([a-z_][a-z0-9_$]*)\s*\(/gi)].map(m => m[1].toLowerCase()).filter(x => createdFunctions.has(x));
      for (const fn of new Set(called)) warnings.push(`Statement ${n} calls ${fn}(), created in this script; its body was not linted and runs here.`);
    }
    if (w[0] === 'truncate' || w[0] === 'drop') warnings.push(`Statement ${n} is ${w[0].toUpperCase()}; double-check it is intended.`);
  });
  return { errors, warnings, functionBodies };
}

// UPDATE / DELETE nodes in one masked statement that have no WHERE at their own
// parenthesis depth before their enclosing group closes.
function writesWithoutWhere(statement) {
  const tokens = [];
  let depth = 0;
  const re = /[A-Za-z_][A-Za-z0-9_$]*|[()]/g;
  for (let m = re.exec(statement); m; m = re.exec(statement)) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') tokens.push({ close: true, depth: depth-- });
    else tokens.push({ word: m[0].toLowerCase(), depth });
  }
  const missing = [];
  tokens.forEach((t, k) => {
    const prev = tokens[k - 1]?.word;
    const isUpdate = t.word === 'update' && !['for', 'on', 'do', 'key'].includes(prev);
    const isDelete = t.word === 'delete' && tokens[k + 1]?.word === 'from';
    if (!isUpdate && !isDelete) return;
    let found = false;
    for (let j = k + 1; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.close && u.depth === t.depth) break;
      if (u.word === 'where' && u.depth === t.depth) { found = true; break; }
    }
    if (!found) missing.push(isDelete ? 'a DELETE' : 'an UPDATE');
  });
  return missing;
}
