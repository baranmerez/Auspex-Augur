#!/usr/bin/env node
// Approves a draft report or revokes an approval in the local report library,
// for the desktop app (Tauri), which runs it as a child process:
//   node src/stageCli.js approve|revoke --db <db> --schema <s> --category <c> --name <n> --expected-hash <hash>
// Same checks, lock, stage history, HTML and schema-memory view rebuild as the
// viewer routes (src/reports/stageChange.js), audited with source and actor
// "desktop". Also archives one schema-memory note like the viewer's
// POST /api/memory/archive (src/memory/noteArchive.js):
//   node src/stageCli.js archive-note --profile <p> --id <n> --reason <text>
// Files only: no database, no network. Prints one JSON line,
// { ok: true, ... } or { ok: false, code, message }, and exits with 1 on any
// error.
import crypto from 'node:crypto';
import path from 'node:path';
import { loadConfig, auspexHome } from './config.js';
import { Library, refLabel } from './reports/library.js';
import { approvedJoinPairs } from './reports/service.js';
import { SchemaMemory } from './memory/store.js';
import { createAuditLog } from './auditLog.js';
import { classifyError } from './errors.js';
import { StageError, stageActions, validateStageInput, applyStageChange, refKeys, expectedHashKey } from './reports/stageChange.js';
import { archiveKeys, validateArchiveInput, archiveNoteFor } from './memory/noteArchive.js';

// The folders as the server and viewer see them; a broken profiles file does
// not hide the library (the viewer falls back the same way).
function folders(env = process.env) {
  try {
    const c = loadConfig(env);
    return { libraryDir: c.libraryDir, memoryDir: c.memoryDir, logDir: c.logDir };
  } catch {
    const home = auspexHome(env);
    return {
      libraryDir: env.AUSPEX_LIBRARY_DIR || path.join(home, 'library'),
      memoryDir: env.AUSPEX_MEMORY_DIR || path.join(home, 'memory'),
      logDir: env.AUSPEX_LOG_DIR || path.join(env.AUSPEX_DATA_DIR || home, 'logs'),
    };
  }
}

// Argument name -> request field: the report location and the SQL hash of the
// version the person reviewed.
const argKeys = new Map([...refKeys.map(k => [k, k]), ['expected-hash', expectedHashKey]]);

// --key value or --key=value, each key of argKeys exactly once.
function parseArgs(args, keys) {
  const body = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z][a-z-]*)(?:=([\s\S]*))?$/.exec(args[i]);
    if (!m || !keys.has(m[1])) throw new StageError(400, `Unknown argument "${String(args[i]).slice(0, 40)}"; use ${[...keys.keys()].map(k => `--${k}`).join(' ')}`);
    const key = keys.get(m[1]);
    if (Object.hasOwn(body, key)) throw new StageError(400, `--${m[1]} given twice`);
    let value = m[2];
    if (value === undefined) {
      if (i + 1 >= args.length) throw new StageError(400, `--${m[1]} needs a value`);
      value = args[++i];
    }
    body[key] = value;
  }
  return body;
}

// Each of db, schema, category, name and expected-hash exactly once.
const parseStageArgs = args => validateStageInput(parseArgs(args, argKeys));

// --profile, --id and --reason exactly once; id as a decimal note id.
const archiveArgKeys = new Map(archiveKeys.map(k => [k, k]));
function parseArchiveArgs(args) {
  const body = parseArgs(args, archiveArgKeys);
  if (typeof body.id === 'string' && /^[1-9][0-9]{0,15}$/.test(body.id)) body.id = Number(body.id);
  return validateArchiveInput(body);
}

function archiveMain(args, dirs) {
  const started = Date.now();
  const entry = { source: 'desktop', tool: 'remember', action: 'archive', actor: 'desktop', correlationId: crypto.randomUUID() };
  const audit = createAuditLog(dirs.logDir);
  try {
    const input = parseArchiveArgs(args);
    Object.assign(entry, { profile: input.profile, noteId: input.id });
    const lib = new Library(dirs.libraryDir);
    const memory = new SchemaMemory(dirs.memoryDir, { approvedJoins: profile => approvedJoinPairs(lib, profile) });
    const note = archiveNoteFor(memory, input);
    audit({ ...entry, ms: Date.now() - started, noteKind: note.kind, noteStatus: note.status });
    return { status: 0, out: { ok: true, note: { id: note.id, kind: note.kind, status: note.status, archivedAt: note.archivedAt }, correlationId: entry.correlationId } };
  } catch (err) {
    const { code } = classifyError(err);
    audit({ ...entry, ms: Date.now() - started, error: err.message, errorCode: code });
    return { status: 1, out: { ok: false, code, message: err.message, correlationId: entry.correlationId } };
  }
}

function main(argv, env) {
  if (argv[0] === 'archive-note') return archiveMain(argv.slice(1), folders(env));
  const action = Object.hasOwn(stageActions, argv[0] ?? '') ? stageActions[argv[0]] : null;
  if (!action) return { status: 1, out: { ok: false, code: 'INVALID_INPUT', message: 'Usage: stageCli.js approve|revoke --db <db> --schema <schema> --category <category> --name <name> --expected-hash <hash>, or stageCli.js archive-note --profile <profile> --id <id> --reason <reason>' } };
  const dirs = folders(env);
  const started = Date.now();
  const entry = { source: 'desktop', tool: action.tool, actor: 'desktop', correlationId: crypto.randomUUID(), fromStage: action.from, toStage: action.to };
  const audit = createAuditLog(dirs.logDir);
  try {
    const { ref, expectedHash } = parseStageArgs(argv.slice(1));
    Object.assign(entry, { profile: ref.db, report: refLabel(ref) });
    const lib = new Library(dirs.libraryDir);
    const memory = new SchemaMemory(dirs.memoryDir, { approvedJoins: profile => approvedJoinPairs(lib, profile) });
    const { report, stage, version } = applyStageChange(lib, action, ref, { by: 'desktop', memory, expectedHash });
    audit({ ...entry, ms: Date.now() - started, version });
    return { status: 0, out: { ok: true, report, stage, version, correlationId: entry.correlationId } };
  } catch (err) {
    const { code } = classifyError(err);
    audit({ ...entry, ms: Date.now() - started, error: err.message, errorCode: code });
    return { status: 1, out: { ok: false, code, message: err.message, correlationId: entry.correlationId } };
  }
}

const { status, out } = main(process.argv.slice(2), process.env);
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exitCode = status;
