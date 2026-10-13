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

export const stages = { draft: '_drafts', approved: 'SELECT', execute: 'EXECUTE' };
const maxRuns = 100;
const reservedChars = /[<>:"/\\|?*\u0000-\u001f]/;

export class LibraryError extends Error {}

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
  fs.renameSync(tmp, file);
}

export class Library {
  constructor(root) {
    this.root = path.resolve(root);
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
    throw new LibraryError(`Report "${refLabel(normalizeRef(ref))}" not found in drafts or SELECT.`);
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
  saveDraft({ ref, title, description, sql, note, mask, unmask }) {
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
    const p = this.paths('draft', r);
    writeAtomic(p.sql, text + '\n');
    this.writeMeta('draft', r, meta);
    return { ref: r, stage: 'draft', version: meta.sqlVersions.find(v => v.hash === hash).version, paths: p };
  }

  appendRun(stage, ref, run, last) {
    const meta = this.readMeta(stage, ref);
    if (!meta) throw new LibraryError('Report metadata missing; save the report first.');
    meta.runs.push(run);
    if (meta.runs.length > maxRuns) meta.runs = meta.runs.slice(-maxRuns);
    meta.last = last;
    meta.updatedAt = run.at;
    this.writeMeta(stage, ref, meta);
    return meta;
  }

  // Moves a draft into SELECT/..., replacing an older approved version.
  approve(ref) {
    const r = normalizeRef(ref);
    if (!this.exists('draft', r)) throw new LibraryError(`No draft "${refLabel(r)}" to approve.`);
    const from = this.paths('draft', r);
    const to = this.paths('approved', r);
    const meta = this.readMeta('draft', r);
    meta.status = 'approved';
    meta.approvedAt = new Date().toISOString();
    meta.approvedVersion = meta.sqlVersions.at(-1)?.version ?? null;
    writeAtomic(to.meta, JSON.stringify(meta, null, 2) + '\n');
    fs.copyFileSync(from.sql, to.sql);
    if (fs.existsSync(from.html)) fs.copyFileSync(from.html, to.html);
    for (const f of Object.values(from)) fs.rmSync(f, { force: true });
    this.pruneEmpty(path.dirname(from.sql), path.join(this.root, stages.draft));
    return { ref: r, stage: 'approved', paths: to, meta };
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
          const lastRun = meta?.runs?.at(-1);
          const file = path.join(base, db, schema, category, f);
          out.push({
            stage, ...ref, title: meta?.title ?? ref.name, description: meta?.description || null,
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
  saveExecuteScript({ ref, title, purpose, relatedReport, expectedRows, sql, replace = false }) {
    const lint = lintExecuteScript(sql);
    if (lint.errors.length) throw new LibraryError(`EXECUTE script rejected:\n- ${lint.errors.join('\n- ')}`);
    this.ensure();
    const r = normalizeRef(ref);
    const file = `${this.base('execute', r)}.sql`;
    if (fs.existsSync(file) && !replace) throw new LibraryError(`EXECUTE script already exists: ${file}. Pass replace=true to overwrite.`);
    const header = [
      '-- =====================================================================',
      commentLines('', title || r.name),
      `-- Database       : ${r.db}   Schema: ${r.schema}   Category: ${r.category}`,
      commentLines('Purpose        : ', purpose || '-'),
      commentLines('Related report : ', relatedReport || '-'),
      commentLines('Expected rows  : ', expectedRows ?? '-'),
      `-- Written        : ${new Date().toISOString()} by an AI agent via Auspex`,
      '-- NOT executed by Auspex. Run it yourself with a role that has the',
      '-- required privileges, review the MATCH results, then replace the final',
      '-- ROLLBACK with COMMIT only if every check is correct.',
      '-- =====================================================================',
      '',
    ].join('\n');
    const text = header + normalizeSql(sql) + '\n';
    // The written file, header included, must pass the same checks as the body.
    const finalLint = lintExecuteScript(text);
    if (finalLint.errors.length) throw new LibraryError(`EXECUTE script rejected after adding the header:\n- ${finalLint.errors.join('\n- ')}`);
    writeAtomic(file, text);
    return { ref: r, file, warnings: lint.warnings };
  }
}

// Turns metadata into SQL comment lines: every line of the value (LF, CRLF or
// lone CR) gets its own "-- " prefix, so no metadata can end up as SQL.
function commentLines(label, value) {
  const pad = ' '.repeat(label.length);
  return String(value).split(/\r\n|\r|\n/)
    .map((line, i) => `-- ${i ? pad : label}${line}`.trimEnd())
    .join('\n');
}
// Structural checks for change scripts: BEGIN first, ROLLBACK last, no COMMIT,
// WHERE on every UPDATE/DELETE. Comments, string literals and dollar-quoted
// bodies (DO blocks, functions) are ignored.
export function lintExecuteScript(sql) {
  const errors = [];
  const warnings = [];
  let masked;
  try {
    masked = stripLiteralsAndComments(String(sql || ''));
  } catch (err) {
    return { errors: [err.message], warnings };
  }
  const statements = masked.split(';').map(s => s.trim()).filter(Boolean);
  if (!statements.length) return { errors: ['Script is empty.'], warnings };
  const words = s => s.toLowerCase().match(/[a-z_]+/g) || [];

  const first = words(statements[0]);
  if (!(first[0] === 'begin' || (first[0] === 'start' && first[1] === 'transaction'))) {
    errors.push('The first statement must be BEGIN (or START TRANSACTION).');
  }
  const last = words(statements.at(-1));
  if (!(last[0] === 'rollback' && last.length <= 2)) {
    errors.push('The last statement must be ROLLBACK; whoever runs the script swaps it for COMMIT after review.');
  }
  statements.forEach((s, i) => {
    const w = words(s);
    if (w[0] === 'commit' || w[0] === 'end') errors.push(`Statement ${i + 1} is ${w[0].toUpperCase()}; COMMIT is never written into the script.`);
    const hasUpdate = w.some((x, j) => x === 'update' && w[j - 1] !== 'for' && w[j - 1] !== 'on');
    const hasDelete = w.some((x, j) => x === 'delete' && w[j + 1] === 'from');
    if ((hasUpdate || hasDelete) && !w.includes('where')) errors.push(`Statement ${i + 1} is ${hasDelete ? 'a DELETE' : 'an UPDATE'} without WHERE.`);
    if (w[0] === 'truncate' || w[0] === 'drop') warnings.push(`Statement ${i + 1} is ${w[0].toUpperCase()}; double-check it is intended.`);
  });
  return { errors, warnings };
}
