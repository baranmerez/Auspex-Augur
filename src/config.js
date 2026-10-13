import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Profiles come from two sources:
//   1. A profiles file (default ~/.auspex/profiles.json, override with
//      AUSPEX_PROFILES_FILE):
//        { "shop": { "url": "postgresql://Auspex@10.0.0.5:5432/shopdb",
//                    "description": "Shop prod (VPN)", "maxTimeoutSeconds": 180 } }
//   2. Environment variables AUSPEX_DB_<NAME> holding a connection string.
// A name defined in both is an error. Passwords never go into either: keep them
// in pgpass (%APPDATA%\postgresql\pgpass.conf on Windows, ~/.pgpass
// elsewhere); node-postgres reads it automatically when no password is given.
const profilePrefix = 'AUSPEX_DB_';
const profileNamePattern = /^[a-z][a-z0-9_-]{0,39}$/;
const profileKeys = new Set(['url', 'description', 'maxTimeoutSeconds']);

// Query options node-postgres would read as a password; any spelling or
// repetition is refused, like a password in the user-info part.
const passwordOptions = new Set(['password', 'sslpassword']);

function queryPasswordKeys(url) {
  return [...new Set([...url.searchParams.keys()].filter(k => passwordOptions.has(k.toLowerCase())))];
}

// The only query options a profile URL may carry: where to connect, TLS and
// connection housekeeping. Anything else is refused, notably `options`
// (session settings such as -c search_path or -c default_transaction_read_only),
// `replication`, `client_encoding`, overrides of the user or database, and
// timeouts (Auspex sets its own). Names must match exactly, as node-postgres
// reads them.
export const allowedQueryOptions = new Set([
  'host', 'port',
  'ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat',
  'application_name', 'fallback_application_name', 'connect_timeout', 'keepalives', 'keepalives_idle',
]);

// One policy for profiles from the file and from AUSPEX_DB_<NAME>: a
// postgresql:// URL with no password anywhere in it and only allowlisted
// query options. Errors name the profile, the field and the option, never a value.
function validateProfileUrl(text, where, field) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Invalid ${where}: ${field} must look like postgresql://user@host:port/db.`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error(`Invalid ${where}: ${field} must start with postgresql://.`);
  if (url.password) throw new Error(`Invalid ${where}: remove the password from ${field} and put it in pgpass.`);
  const keys = queryPasswordKeys(url);
  if (keys.length) throw new Error(`Invalid ${where}: remove the "${keys.join('", "')}" option from ${field} and put the password in pgpass.`);
  const other = [...new Set([...url.searchParams.keys()].filter(k => !allowedQueryOptions.has(k)))];
  if (other.length) {
    throw new Error(`Invalid ${where}: option(s) "${other.join('", "')}" are not allowed in ${field}. Allowed: ${[...allowedQueryOptions].join(', ')}.`);
  }
  return url;
}

function intFromEnv(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

// Everything lives under one folder in the user's home (C:\Users\<you>\.auspex
// on Windows), override with AUSPEX_HOME. Not under AppData on purpose: when
// the MCP client is an MSIX-packaged desktop app, Windows redirects AppData
// writes of its child processes into a hidden per-package folder, so files
// would be invisible in Explorer and to tools started outside the app.
export function auspexHome(env = process.env) {
  return env.AUSPEX_HOME || path.join(os.homedir(), '.auspex');
}

function defaultDataDir(env) {
  return auspexHome(env);
}

export function defaultProfilesFile(env = process.env) {
  return path.join(auspexHome(env), 'profiles.json');
}

// Reads and validates the profiles file. A missing file means no file profiles;
// any other problem is an error so a broken file is never silently ignored.
export function readProfilesFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Cannot read profiles file ${file}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`Profiles file ${file} is not valid JSON: ${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Profiles file ${file} must be a JSON object of profiles.`);
  }

  const seen = new Set();
  return Object.entries(data).map(([rawName, profile]) => {
    const name = rawName.toLowerCase();
    const where = `profile "${rawName}" in ${file}`;
    if (!profileNamePattern.test(name)) throw new Error(`Invalid ${where}: names use a-z, 0-9, - and _ and start with a letter.`);
    if (seen.has(name)) throw new Error(`Profile "${name}" is defined twice in ${file} (names are case-insensitive).`);
    seen.add(name);
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error(`Invalid ${where}: expected an object.`);
    const unknown = Object.keys(profile).filter(k => !profileKeys.has(k));
    if (unknown.length) throw new Error(`Invalid ${where}: unknown field(s) ${unknown.join(', ')}.`);
    if (typeof profile.url !== 'string' || !profile.url) throw new Error(`Invalid ${where}: "url" is required.`);
    validateProfileUrl(profile.url, where, '"url"');
    if (profile.description !== undefined && typeof profile.description !== 'string') throw new Error(`Invalid ${where}: "description" must be text.`);
    const max = profile.maxTimeoutSeconds;
    if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 3600)) {
      throw new Error(`Invalid ${where}: "maxTimeoutSeconds" must be an integer between 1 and 3600.`);
    }
    return { name, url: profile.url, description: profile.description || null, maxTimeoutMs: max === undefined ? null : max * 1000 };
  });
}

export function loadConfig(env = process.env) {
  const profiles = new Map();
  const profileInfo = new Map();
  const maxTimeoutByProfile = new Map();

  const profilesFile = env.AUSPEX_PROFILES_FILE || defaultProfilesFile(env);
  for (const p of readProfilesFile(profilesFile)) {
    profiles.set(p.name, p.url);
    profileInfo.set(p.name, { source: 'file', description: p.description });
    if (p.maxTimeoutMs !== null) maxTimeoutByProfile.set(p.name, p.maxTimeoutMs);
  }

  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith(profilePrefix) || !value) continue;
    const name = key.slice(profilePrefix.length).toLowerCase();
    const where = `profile "${name}" in ${key}`;
    if (!profileNamePattern.test(name)) throw new Error(`Invalid ${key}: profile names use a-z, 0-9, - and _ and start with a letter.`);
    validateProfileUrl(value, where, 'the value');
    if (profiles.has(name)) {
      throw new Error(`Profile "${name}" is defined both in ${profilesFile} and in ${key}; keep only one.`);
    }
    profiles.set(name, value);
    profileInfo.set(name, { source: 'env', description: null });
  }

  const dataDir = env.AUSPEX_DATA_DIR || defaultDataDir(env);
  const statementTimeoutMs = intFromEnv(env, 'AUSPEX_STATEMENT_TIMEOUT_MS', 30000, 1000, 3600000);
  const maxStatementTimeoutMs = intFromEnv(env, 'AUSPEX_MAX_STATEMENT_TIMEOUT_MS', 300000, 1000, 3600000);
  if (maxStatementTimeoutMs < statementTimeoutMs) {
    throw new Error('AUSPEX_MAX_STATEMENT_TIMEOUT_MS must not be lower than AUSPEX_STATEMENT_TIMEOUT_MS.');
  }

  // Per-profile ceiling from env, e.g. AUSPEX_MAX_STATEMENT_TIMEOUT_MS_SHOP=120000,
  // overrides maxTimeoutSeconds from the file.
  for (const name of profiles.keys()) {
    const key = `AUSPEX_MAX_STATEMENT_TIMEOUT_MS_${name.toUpperCase()}`;
    if (env[key]) maxTimeoutByProfile.set(name, intFromEnv(env, key, maxStatementTimeoutMs, 1000, 3600000));
  }

  return {
    profiles,
    profileInfo,
    profilesFile,
    maxRows: intFromEnv(env, 'AUSPEX_MAX_ROWS', 500, 1, 10000),
    exportMaxRows: intFromEnv(env, 'AUSPEX_EXPORT_MAX_ROWS', 100000, 1, 5000000),
    // Whole-export budget on top of the per-statement timeout.
    exportMaxBytes: intFromEnv(env, 'AUSPEX_EXPORT_MAX_BYTES', 100 * 1024 * 1024, 1024, 10 * 1024 * 1024 * 1024),
    exportMaxMs: intFromEnv(env, 'AUSPEX_EXPORT_MAX_MS', 300000, 1000, 3600000),
    statementTimeoutMs,
    maxStatementTimeoutMs,
    maxTimeoutByProfile,
    maxCellChars: intFromEnv(env, 'AUSPEX_MAX_CELL_CHARS', 2000, 50, 100000),
    exportDir: env.AUSPEX_EXPORT_DIR || path.join(dataDir, 'exports'),
    logDir: env.AUSPEX_LOG_DIR || path.join(dataDir, 'logs'),
    // Report library (SELECT/, EXECUTE/, _drafts/): user-specific, never in a repo.
    libraryDir: env.AUSPEX_LIBRARY_DIR || path.join(auspexHome(env), 'library'),
    memoryDir: env.AUSPEX_MEMORY_DIR || path.join(auspexHome(env), 'memory'),
  };
}

// Connection summary safe to show to the model: never includes the password.
export function describeConnection(connectionString) {
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: url.port || '5432',
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
      passwordInString: url.password !== '' || queryPasswordKeys(url).length > 0,
    };
  } catch {
    return { error: 'Connection string is not a URL (postgresql://user@host:port/db expected).' };
  }
}
