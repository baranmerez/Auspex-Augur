#!/usr/bin/env node
// Approves a draft report or revokes an approval in the local report library,
// for the desktop app (Tauri), which runs it as a child process:
//   node src/stageCli.js approve|revoke --db <db> --schema <s> --category <c> --name <n> --expected-hash <hash>
// Same checks, lock, stage history, HTML and schema-memory view rebuild as the
// viewer routes (src/reports/stageChange.js), audited with source and actor
// "desktop". Also archives one schema-memory note like the viewer's
// POST /api/memory/archive (src/memory/noteArchive.js):
//   node src/stageCli.js archive-note --profile <p> --id <n> --reason <text>
// and sets or removes one user column score like the viewer's
// POST /api/memory/column-score (src/memory/userScore.js):
//   node src/stageCli.js score-column --profile <p> --schema <s> --table <t> --column <c> (--score <1-5> [--roles <r,r>] | --clear true)
// and makes one table-page memory edit like the viewer's POST
// /api/memory/edit (src/memory/memoryEdit.js), the request as one JSON
// object on stdin (it may hold a profile text):
//   node src/stageCli.js memory-edit < request.json
// Read-only, for the report list (same data as the browser viewer, see
// src/schedule/viewerData.js; not audited, like the viewer's GET routes):
//   node src/stageCli.js schedules
//   node src/stageCli.js schedule-overview
//   node src/stageCli.js trend --db <db> --schema <s> --category <c> --name <n>
//   node src/stageCli.js table-profile --profile <p> --schema <s> --table <t>
// Files only: no database, no network. Prints one JSON line,
// { ok: true, ... } or { ok: false, code, message }, and exits with 1 on any
// error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, auspexHome } from './config.js';
import { Library, refLabel } from './reports/library.js';
import { approvedJoinPairs, reportSources } from './reports/service.js';
import { SchemaMemory } from './memory/store.js';
import { createAuditLog } from './auditLog.js';
import { classifyError } from './errors.js';
import { StageError, stageActions, validateStageInput, applyStageChange, refKeys, expectedHashKey } from './reports/stageChange.js';
import { archiveKeys, validateArchiveInput, archiveNoteFor } from './memory/noteArchive.js';
import { userScoreKeys, validateUserScoreInput, userScoreAudit, setUserScoreFor } from './memory/userScore.js';
import { validateEditInput, editAudit, applyMemoryEdit, readTableProfileFor, maxEditBytes } from './memory/memoryEdit.js';
import { scheduleIndex, reportTrend, scheduleOverview } from './schedule/viewerData.js';

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
    const note = archiveNoteFor(memoryOf(dirs), input);
    audit({ ...entry, ms: Date.now() - started, noteKind: note.kind, noteStatus: note.status });
    return { status: 0, out: { ok: true, note: { id: note.id, kind: note.kind, status: note.status, archivedAt: note.archivedAt }, correlationId: entry.correlationId } };
  } catch (err) {
    const { code } = classifyError(err);
    audit({ ...entry, ms: Date.now() - started, error: err.message, errorCode: code });
    return { status: 1, out: { ok: false, code, message: err.message, correlationId: entry.correlationId } };
  }
}

// --profile, --schema, --table, --column, then --score (decimal 1-5) with an
// optional --roles (comma-separated, empty for none) or --clear true; each at
// most once. Strings that are not in this form stay strings and are refused by
// validateUserScoreInput.
const scoreArgKeys = new Map(userScoreKeys.map(k => [k, k]));
function parseScoreArgs(args) {
  let body;
  try {
    body = parseArgs(args, scoreArgKeys);
  } catch {
    // Not echoed: the audit log keeps no free text from a request.
    throw new StageError(400, `Unknown, repeated or empty argument; use ${[...scoreArgKeys.keys()].map(k => `--${k}`).join(' ')}`);
  }
  if (typeof body.score === 'string' && /^[1-5]$/.test(body.score)) body.score = Number(body.score);
  if (body.clear === 'true') body.clear = true;
  if (typeof body.roles === 'string') body.roles = body.roles === '' ? [] : body.roles.split(',');
  return validateUserScoreInput(body);
}

function scoreMain(args, dirs) {
  const started = Date.now();
  const entry = { source: 'desktop', tool: 'score_columns', actor: 'desktop', layer: 'user', correlationId: crypto.randomUUID() };
  const audit = createAuditLog(dirs.logDir);
  try {
    const input = parseScoreArgs(args);
    Object.assign(entry, userScoreAudit(input));
    const result = setUserScoreFor(memoryOf(dirs), input);
    audit({ ...entry, ms: Date.now() - started, scored: 1 });
    return { status: 0, out: { ok: true, ...result, correlationId: entry.correlationId } };
  } catch (err) {
    const { code } = classifyError(err);
    audit({ ...entry, ms: Date.now() - started, error: err.message, errorCode: code });
    return { status: 1, out: { ok: false, code, message: err.message, correlationId: entry.correlationId } };
  }
}

// The schema memory as the viewer sees it: "used" relations from approved
// reports' joins, report SQL for the table profile's fingerprint.
const memoryOf = (dirs, lib = new Library(dirs.libraryDir)) => new SchemaMemory(dirs.memoryDir, { approvedJoins: profile => approvedJoinPairs(lib, profile), reportSources: profile => reportSources(lib, profile) });

// The request of memory-edit: one JSON object on stdin, at most maxEditBytes,
// read in chunks so a larger one stops the read once it passes the limit.
// readChunk(buf) -> bytes read, 0 at the end (an EOF error ends it too).
function readStdinJson(readChunk = buf => fs.readSync(0, buf, 0, buf.length, null)) {
  const buf = Buffer.alloc(16 * 1024);
  const chunks = [];
  let total = 0;
  for (;;) {
    let n;
    try {
      n = readChunk(buf);
    } catch (err) {
      if (err?.code === 'EOF') break;
      throw new StageError(400, 'memory-edit reads its request as JSON on stdin');
    }
    if (!n) break;
    total += n;
    if (total > maxEditBytes) throw new StageError(413, 'Request too large');
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new StageError(400, 'The request on stdin must be JSON'); }
}

function editMain(args, dirs) {
  const started = Date.now();
  const entry = { source: 'desktop', tool: 'memory_edit', actor: 'desktop', correlationId: crypto.randomUUID() };
  const audit = createAuditLog(dirs.logDir);
  try {
    if (args.length) throw new StageError(400, 'memory-edit takes no arguments; the request comes as JSON on stdin');
    const input = validateEditInput(readStdinJson());
    Object.assign(entry, editAudit(input));
    const result = applyMemoryEdit(memoryOf(dirs), input);
    audit({ ...entry, ms: Date.now() - started, ...(result.version !== undefined ? { version: result.version } : {}), ...(result.note?.id ? { noteId: result.note.id } : {}), ...(result.stored ? { stored: result.stored } : {}) });
    return { status: 0, out: { ok: true, ...result, correlationId: entry.correlationId } };
  } catch (err) {
    const { code } = classifyError(err);
    audit({ ...entry, ms: Date.now() - started, error: err.message, errorCode: code });
    return { status: 1, out: { ok: false, code, message: err.message, correlationId: entry.correlationId } };
  }
}

// The table profile, like GET /api/memory/table-profile (not audited).
const profileArgKeys = new Map(['profile', 'schema', 'table'].map(k => [k, k]));
function tableProfileMain(args, dirs) {
  try {
    return { status: 0, out: { ok: true, ...readTableProfileFor(memoryOf(dirs), parseArgs(args, profileArgKeys)) } };
  } catch (err) {
    const { code } = classifyError(err);
    return { status: 1, out: { ok: false, code, message: err.message } };
  }
}

// Schedules by report key as [key, schedules] pairs (no object keyed by a
// report location, so no name is special), and a broken schedules file as
// error, like GET /api/reports.
function schedulesMain(args, env) {
  if (args.length) return { status: 1, out: { ok: false, code: 'INVALID_INPUT', message: 'schedules takes no arguments' } };
  const { error, byReport } = scheduleIndex({ env });
  return { status: 0, out: { ok: true, error, byReport: [...byReport] } };
}

// Every configured schedule with its target check, like GET /api/schedules.
function scheduleOverviewMain(args, env) {
  if (args.length) return { status: 1, out: { ok: false, code: 'INVALID_INPUT', message: 'schedule-overview takes no arguments' } };
  return { status: 0, out: { ok: true, ...scheduleOverview({ env, library: new Library(folders(env).libraryDir) }) } };
}

// Trend points of one report, like GET /api/reports/trend.
const trendArgKeys = new Map(refKeys.map(k => [k, k]));
function trendMain(args, env) {
  try {
    return { status: 0, out: { ok: true, ...reportTrend(parseArgs(args, trendArgKeys), { env }) } };
  } catch (err) {
    const { code } = classifyError(err);
    return { status: 1, out: { ok: false, code, message: err.message } };
  }
}

function main(argv, env) {
  if (argv[0] === 'schedules') return schedulesMain(argv.slice(1), env);
  if (argv[0] === 'schedule-overview') return scheduleOverviewMain(argv.slice(1), env);
  if (argv[0] === 'trend') return trendMain(argv.slice(1), env);
  if (argv[0] === 'archive-note') return archiveMain(argv.slice(1), folders(env));
  if (argv[0] === 'score-column') return scoreMain(argv.slice(1), folders(env));
  if (argv[0] === 'memory-edit') return editMain(argv.slice(1), folders(env));
  if (argv[0] === 'table-profile') return tableProfileMain(argv.slice(1), folders(env));
  const action = Object.hasOwn(stageActions, argv[0] ?? '') ? stageActions[argv[0]] : null;
  if (!action) return { status: 1, out: { ok: false, code: 'INVALID_INPUT', message: 'Usage: stageCli.js approve|revoke --db <db> --schema <schema> --category <category> --name <name> --expected-hash <hash>, stageCli.js archive-note --profile <profile> --id <id> --reason <reason>, stageCli.js score-column --profile <profile> --schema <schema> --table <table> --column <column> (--score <1-5> [--roles <roles>] | --clear true), stageCli.js memory-edit (JSON request on stdin) or stageCli.js table-profile --profile <profile> --schema <schema> --table <table>' } };
  const dirs = folders(env);
  const started = Date.now();
  const entry = { source: 'desktop', tool: action.tool, actor: 'desktop', correlationId: crypto.randomUUID(), fromStage: action.from, toStage: action.to };
  const audit = createAuditLog(dirs.logDir);
  try {
    const { ref, expectedHash } = parseStageArgs(argv.slice(1));
    Object.assign(entry, { profile: ref.db, report: refLabel(ref) });
    const lib = new Library(dirs.libraryDir);
    const memory = memoryOf(dirs, lib);
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
