#!/usr/bin/env node
// Local, read-only viewer for the Auspex audit log, profiles, report library
// and schema memory.
// Listens on 127.0.0.1 only, never connects to a database, never shows
// passwords. Run with: npm run viewer (port: AUSPEX_VIEWER_PORT, default 4719).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, describeConnection, auspexHome } from './config.js';
import { Library, LibraryError } from './reports/library.js';

const port = Number.parseInt(process.env.AUSPEX_VIEWER_PORT || '4719', 10);
const host = '127.0.0.1';
const pagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewer.html');
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const profilePattern = /^[a-z][a-z0-9_-]{0,39}$/;
const memoryFilePattern = /^tables\/[a-z0-9_~-]+\/[a-z0-9_~-]+\.json$/;

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

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  // Only same-machine browsers addressing us by loopback name (blocks DNS rebinding).
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });
  if (req.method !== 'GET') return send(res, 405, { error: 'Read-only viewer' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/') return send(res, 200, fs.readFileSync(pagePath, 'utf8'), 'text/html; charset=utf-8');
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
      return send(res, 200, { libraryDir: lib.root, reports: lib.list() });
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
