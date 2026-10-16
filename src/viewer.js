#!/usr/bin/env node
// Local viewer for the Auspex audit log, profiles, report library and schema
// memory. Read-only except for two POST routes that approve a draft report or
// revoke an approval in the local library (stage moves, audited).
// Listens on 127.0.0.1 only, never connects to a database, never shows
// passwords. Run with: npm run viewer (port: AUSPEX_VIEWER_PORT, default 4719).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, describeConnection, auspexHome } from './config.js';
import { Library, LibraryError, normalizeRef, refLabel } from './reports/library.js';
import { approveInLibrary, revokeInLibrary, approvedJoinPairs } from './reports/service.js';
import { SchemaMemory } from './memory/store.js';
import { createAuditLog } from './auditLog.js';
import { classifyError } from './errors.js';

const port = Number.parseInt(process.env.AUSPEX_VIEWER_PORT || '4719', 10);
const host = '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.join(here, 'viewer.html');
// Vendored scripts the page loads (see src/vendor/README.md). Only these exact
// paths are served; nothing is fetched from the network.
const vendorFiles = new Map(['3d-force-graph-1.80.1.min.js'].map(f => [`/vendor/${f}`, path.join(here, 'vendor', f)]));
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const profilePattern = /^[a-z][a-z0-9_-]{0,39}$/;
const memoryFilePattern = /^tables\/[a-z0-9_~-]+\/[a-z0-9_~-]+\.json$/;
// Per-process secret for the stage-change routes. Only the served page carries
// it; a page of another origin cannot read it (no CORS headers, Host check).
const csrfToken = crypto.randomBytes(32).toString('hex');
const tokenPlaceholder = '__AUSPEX_VIEWER_TOKEN__';
const maxBodyBytes = 4096;
const refKeys = ['db', 'schema', 'category', 'name'];
// Stage changes the page may request: the report must be in `from`.
const stageActions = new Map([
  ['/api/reports/approve', { tool: 'approve_report', from: 'draft', to: 'approved',
    run: (lib, ref) => approveInLibrary(lib, ref, { by: 'viewer', memory: schemaMemory(lib) }), version: r => r.meta.approvedVersion }],
  ['/api/reports/revoke', { tool: 'revoke_report', from: 'approved', to: 'draft',
    run: (lib, ref) => revokeInLibrary(lib, ref, { by: 'viewer', memory: schemaMemory(lib) }), version: r => r.version }],
]);

// Re-read on every request so edits to profiles.json show up without restart.
function readConfig() {
  try {
    return { config: loadConfig() };
  } catch (err) {
    return { error: err.message };
  }
}

function logDir() {
  const { config } = readConfig();
  return config?.logDir ?? path.join(auspexHome(), 'logs');
}

function listDays() {
  const dir = logDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .map(f => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      return { day: f.slice(0, 10), count: text.split('\n').filter(Boolean).length };
    })
    .sort((a, b) => b.day.localeCompare(a.day));
}

function readDay(day) {
  const file = path.join(logDir(), `${day}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      return { ts: null, tool: '?', error: `Unreadable log line ${i + 1}` };
    }
  });
}

function profiles() {
  const { config, error } = readConfig();
  if (error) return { error, home: auspexHome() };
  return {
    home: auspexHome(),
    profilesFile: config.profilesFile,
    logDir: config.logDir,
    exportDir: config.exportDir,
    defaultTimeoutSeconds: config.statementTimeoutMs / 1000,
    profiles: [...config.profiles].map(([name, cs]) => ({
      name,
      description: config.profileInfo.get(name)?.description ?? null,
      source: config.profileInfo.get(name)?.source,
      ...describeConnection(cs),
      maxTimeoutSeconds: (config.maxTimeoutByProfile.get(name) ?? config.maxStatementTimeoutMs) / 1000,
      defaultTimeoutSeconds: Math.min(config.statementTimeoutMs, config.maxTimeoutByProfile.get(name) ?? config.maxStatementTimeoutMs) / 1000,
      maxQueriesPerMinute: config.maxQueriesByProfile.get(name) ?? config.maxQueriesPerMinute,
    })),
  };
}

function library() {
  const { config } = readConfig();
  return new Library(config?.libraryDir ?? path.join(auspexHome(), 'library'));
}

// Schema memory: graph.json is the derived view the memory module writes
// after every change; table files hold the full structure for the ER view.
function memoryDir() {
  const { config } = readConfig();
  return config?.memoryDir ?? path.join(auspexHome(), 'memory');
}

// The schema memory as the MCP server sees it, so a stage change rebuilds its
// view ("used" relations come from approved reports' joins). Files only.
function schemaMemory(lib) {
  return new SchemaMemory(memoryDir(), { approvedJoins: profile => approvedJoinPairs(lib, profile) });
}

function memoryProfile(params) {
  const name = params.get('profile') || '';
  if (!profilePattern.test(name)) throw new LibraryError('Invalid profile name');
  return path.join(memoryDir(), name);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function memorySummary() {
  const dir = memoryDir();
  const names = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && profilePattern.test(d.name)).map(d => d.name).sort() : [];
  const profiles = [];
  for (const name of names) {
    const file = path.join(dir, name, 'graph.json');
    if (!fs.existsSync(file)) continue;
    const view = readJsonFile(file);
    profiles.push({ name, generatedAt: view.generatedAt, ...view.summary });
  }
  return { memoryDir: dir, profiles };
}

function memoryTable(params) {
  const file = params.get('file') || '';
  if (!memoryFilePattern.test(file)) throw new LibraryError('Invalid memory file');
  return readJsonFile(path.join(memoryProfile(params), ...file.split('/')));
}

// One report file: the generated HTML for SELECT/draft reports, the SQL text for
// EXECUTE scripts. Library.paths validates every segment, so this cannot leave
// the library folder.
function reportContent(params) {
  const stage = params.get('stage');
  const ref = { db: params.get('db'), schema: params.get('schema'), category: params.get('category'), name: params.get('name') };
  const lib = library();
  if (stage === 'execute') {
    const file = `${lib.base('execute', ref)}.sql`;
    return { kind: 'sql', content: fs.readFileSync(file, 'utf8') };
  }
  if (stage !== 'draft' && stage !== 'approved') throw new Error('stage must be draft, approved or execute');
  const p = lib.paths(stage, ref);
  if (!fs.existsSync(p.html)) return { kind: 'sql', content: fs.readFileSync(p.sql, 'utf8') };
  return { kind: 'html', content: fs.readFileSync(p.html, 'utf8') };
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// The page with this process's token; never framed by another page.
function sendPage(res) {
  const page = fs.readFileSync(pagePath, 'utf8').replace(tokenPlaceholder, csrfToken);
  send(res, 200, page, 'text/html; charset=utf-8', { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
}

class HttpError extends Error {
  constructor(status, message, errorCode = 'INVALID_INPUT') {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

// Same-origin page with the token: the Origin header must be exactly this
// viewer (the Host was already allowlisted) and the token must match.
function checkWriteRequest(req) {
  if (req.headers.origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Forbidden origin', 'ORIGIN_INVALID');
  const given = Buffer.from(String(req.headers['x-auspex-token'] || ''));
  const expected = Buffer.from(csrfToken);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HttpError(403, 'Missing or invalid token', 'TOKEN_INVALID');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > maxBodyBytes) return reject(new HttpError(413, 'Body too large'));
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBodyBytes) reject(new HttpError(413, 'Body too large')); // the rest is drained, not kept
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// { db, schema, category, name } exactly as the library lists it: any other
// field, a non-string, or a value that normalizes differently is refused, so
// a request can only name a library location.
function parseRef(text) {
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Body must be JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
  if (Object.keys(body).some(k => !refKeys.includes(k))) throw new HttpError(400, `Only ${refKeys.join(', ')} are allowed`);
  if (refKeys.some(k => typeof body[k] !== 'string' || !body[k] || body[k].length > 200)) throw new HttpError(400, `${refKeys.join(', ')} must be non-empty strings`);
  let ref;
  try { ref = normalizeRef(body); } catch (err) { throw new HttpError(400, err.message); }
  if (refKeys.some(k => ref[k] !== body[k])) throw new HttpError(400, 'Report reference is not a library location');
  return ref;
}

const statusOf = err => err instanceof HttpError ? err.status
  : ({ NOT_FOUND: 404, PRECONDITION_FAILED: 409, INVALID_INPUT: 400, LOCK_BUSY: 503 })[classifyError(err).code] ?? 500;

// Approve or revoke one report. Every request that passed the origin and
// token checks is audited (actor, report, from/to stage, version or error).
async function changeStage(req, res, action) {
  checkWriteRequest(req);
  const started = Date.now();
  const entry = { source: 'viewer', tool: action.tool, actor: 'viewer', correlationId: crypto.randomUUID(), fromStage: action.from, toStage: action.to };
  const audit = createAuditLog(logDir());
  try {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type must be application/json');
    const ref = parseRef(await readBody(req));
    const label = refLabel(ref);
    Object.assign(entry, { profile: ref.db, report: label });
    const lib = library();
    // Checked before the lock so a missing library folder is not created.
    if (!fs.existsSync(lib.root)) throw new HttpError(404, `Report "${label}" not found.`, 'NOT_FOUND');
    const result = lib.locked(() => {
      if (!lib.exists(action.from, ref)) {
        if (lib.exists(action.to, ref)) throw new HttpError(409, `Report "${label}" is ${action.to}, not ${action.from}.`, 'PRECONDITION_FAILED');
        throw new HttpError(404, `Report "${label}" not found.`, 'NOT_FOUND');
      }
      return action.run(lib, ref);
    });
    const version = action.version(result) ?? null;
    audit({ ...entry, ms: Date.now() - started, version });
    return send(res, 200, { report: label, stage: action.to, version, correlationId: entry.correlationId });
  } catch (err) {
    const { code } = classifyError(err);
    audit({ ...entry, ms: Date.now() - started, error: err.message, errorCode: code });
    return send(res, statusOf(err), { error: err.message, code, correlationId: entry.correlationId });
  }
}

const server = http.createServer((req, res) => {
  // Only same-machine browsers addressing us by loopback name (blocks DNS rebinding).
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = stageActions.get(url.pathname);
  if (action) {
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, undefined, { Allow: 'POST' });
    return changeStage(req, res, action).catch(err => {
      if (!res.headersSent) send(res, statusOf(err), { error: err.message, ...(err.errorCode ? { code: err.errorCode } : {}) });
    });
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'Read-only route' }, undefined, { Allow: 'GET' });
  try {
    if (url.pathname === '/') return sendPage(res);
    if (vendorFiles.has(url.pathname)) return send(res, 200, fs.readFileSync(vendorFiles.get(url.pathname), 'utf8'), 'text/javascript; charset=utf-8');
    if (url.pathname === '/api/days') return send(res, 200, listDays());
    if (url.pathname === '/api/profiles') return send(res, 200, profiles());
    if (url.pathname === '/api/logs') {
      // ?day=YYYY-MM-DD or ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, at most 400 days)
      const day = url.searchParams.get('day');
      const from = day ?? url.searchParams.get('from') ?? '';
      const to = day ?? url.searchParams.get('to') ?? '';
      if (!dayPattern.test(from) || !dayPattern.test(to)) return send(res, 400, { error: 'day, or from and to, must be YYYY-MM-DD' });
      if (from > to) return send(res, 400, { error: 'from must not be after to' });
      const days = listDays().map(d => d.day).filter(d => d >= from && d <= to).sort();
      if (days.length > 400) return send(res, 400, { error: 'range too large' });
      return send(res, 200, days.flatMap(d => readDay(d)));
    }
    if (url.pathname === '/api/reports') {
      const lib = library();
      // Drafts also carry the SQL version an approval would approve (confirm dialog).
      const reports = lib.list().map(r => (r.stage === 'draft' ? { ...r, activeVersion: lib.readMeta('draft', r)?.activeVersion ?? null } : r));
      return send(res, 200, { libraryDir: lib.root, reports });
    }
    if (url.pathname === '/api/report') return send(res, 200, reportContent(url.searchParams));
    if (url.pathname === '/api/memory') return send(res, 200, memorySummary());
    if (url.pathname === '/api/memory/graph') return send(res, 200, readJsonFile(path.join(memoryProfile(url.searchParams), 'graph.json')));
    if (url.pathname === '/api/memory/table') return send(res, 200, memoryTable(url.searchParams));
    if (url.pathname === '/api/health') {
      const days = listDays();
      return send(res, 200, { ok: true, latestDay: days[0]?.day ?? null, latestCount: days[0]?.count ?? 0, totalDays: days.length });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, err instanceof LibraryError || err.code === 'ENOENT' ? 400 : 500, { error: err.code === 'ENOENT' ? 'File not found' : err.message });
  }
});

server.on('error', err => {
  process.stderr.write(`auspex viewer: ${err.message}\n`);
  process.exit(1);
});

server.listen(port, host, () => {
  process.stdout.write(`Auspex viewer: http://127.0.0.1:${port}  (logs: ${logDir()})\n`);
});
