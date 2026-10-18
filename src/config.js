import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Profiles come from two sources:
//   1. A profiles file (default ~/.auspex/profiles.json, override with
//      AUSPEX_PROFILES_FILE):
//        { "example": { "url": "postgresql://Auspex@db.example.test:5432/exampledb",
//                       "description": "Example PRODUCTION", "maxTimeoutSeconds": 180,
//                       "maxQueriesPerMinute": 30 } }
//   2. Environment variables AUSPEX_DB_<NAME> holding a connection string.
// A name defined in both is an error. Passwords never go into either: keep them
// in pgpass (%APPDATA%\postgresql\pgpass.conf on Windows, ~/.pgpass
// elsewhere); node-postgres reads it automatically when no password is given.
// The same file may hold a top-level "scriptRoots" object (name -> absolute
// directory) for change scripts; AUSPEX_SCRIPT_ROOT_<NAME> adds one from env,
// a top-level "codeRoots" object (name -> absolute directory) naming source
// code folders the agent reads with its own tools (AUSPEX_CODE_ROOT_<NAME>
// adds one from env; Auspex never reads or writes them, the names only scope
// remember evidenceCode references),
// an optional top-level "notesLanguage" (language code such as en or pt-BR), and
// an optional top-level "auspexRoot" (this checkout, for the desktop app's
// approve/revoke through src/stageCli.js).
const profilePrefix = 'AUSPEX_DB_';
const scriptRootPrefix = 'AUSPEX_SCRIPT_ROOT_';
const codeRootPrefix = 'AUSPEX_CODE_ROOT_';
export const scriptRootsKey = 'scriptRoots';
export const codeRootsKey = 'codeRoots';
export const notesLanguageKey = 'notesLanguage';
export const auspexRootKey = 'auspexRoot';
const settingKeys = new Set([scriptRootsKey, codeRootsKey, notesLanguageKey, auspexRootKey]);
const notesLanguagePattern = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i;
const profileNamePattern = /^[a-z][a-z0-9_-]{0,39}$/;
const profileKeys = new Set(['url', 'description', 'maxTimeoutSeconds', 'maxQueriesPerMinute']);
const maxQueriesLimit = 10000;

// Query options node-postgres would read as a password; any spelling or
// repetition is refused, like a password in the user-info part.
const passwordOptions = new Set(['password', 'sslpassword']);

function queryPasswordKeys(url) {
  return [...new Set([...url.searchParams.keys()].filter(k => passwordOptions.has(k.toLowerCase())))];
}

// The only query options a profile URL may carry: TLS and connection
// housekeeping. Anything else is refused, notably `host` and `port` (node-postgres
// would let them override the URL authority, so the endpoint shown to the
// user could differ from the one used), `options`
// (session settings such as -c search_path or -c default_transaction_read_only),
// `replication`, `client_encoding`, overrides of the user or database, and
// timeouts (Auspex sets its own). Names must match exactly, as node-postgres
// reads them.
const endpointOptions = new Set(['host', 'port']);
export const allowedQueryOptions = new Set([
  'ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat',
  'application_name', 'fallback_application_name', 'connect_timeout', 'keepalives', 'keepalives_idle',
]);

// One policy for profiles from the file and from AUSPEX_DB_<NAME>: a
// postgresql:// URL with host, user and database, no password anywhere in it
// and only allowlisted query options. Errors name the profile, the field and
// the option, never a value. Returns the URL to connect with: the text as
// given, or with an explicit :5432 when it has no port, so the endpoint shown
// (describeConnection) is the one node-postgres uses and a PGPORT (or PGUSER,
// PGDATABASE, PGHOST) in the environment can never pick the target.
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
  const endpoint = [...new Set([...url.searchParams.keys()].filter(k => endpointOptions.has(k.toLowerCase())))];
  if (endpoint.length) {
    throw new Error(`Invalid ${where}: remove the "${endpoint.join('", "')}" option from ${field} and put the host and port in the URL authority (postgresql://user@host:port/db).`);
  }
  const other = [...new Set([...url.searchParams.keys()].filter(k => !allowedQueryOptions.has(k)))];
  if (other.length) {
    throw new Error(`Invalid ${where}: option(s) "${other.join('", "')}" are not allowed in ${field}. Allowed: ${[...allowedQueryOptions].join(', ')}.`);
  }
  const missing = [
    !url.hostname && 'host',
    !url.username && 'user',
    !url.pathname.replace(/^\//, '') && 'database',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Invalid ${where}: ${field} needs ${missing.join(', ')} (postgresql://user@host:port/db); Auspex never takes them from the environment.`);
  }
  if (url.port) return text;
  url.port = '5432';
  return url.href;
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

// Parsed profiles file, or null when it does not exist.
function readProfilesData(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
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
  return data;
}

// Reads and validates the profiles file. A missing file means no file profiles;
// any other problem is an error so a broken file is never silently ignored.
// The "scriptRoots", "codeRoots", "notesLanguage" and "auspexRoot" keys are
// not profiles.
export function readProfilesFile(file) {
  const data = readProfilesData(file);
  if (!data) return [];
  const seen = new Set();
  return Object.entries(data).filter(([rawName]) => !settingKeys.has(rawName)).map(([rawName, profile]) => {
    const name = rawName.toLowerCase();
    const where = `profile "${rawName}" in ${file}`;
    if (!profileNamePattern.test(name)) throw new Error(`Invalid ${where}: names use a-z, 0-9, - and _ and start with a letter.`);
    if (seen.has(name)) throw new Error(`Profile "${name}" is defined twice in ${file} (names are case-insensitive).`);
    seen.add(name);
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error(`Invalid ${where}: expected an object.`);
    const unknown = Object.keys(profile).filter(k => !profileKeys.has(k));
    if (unknown.length) throw new Error(`Invalid ${where}: unknown field(s) ${unknown.join(', ')}.`);
    if (typeof profile.url !== 'string' || !profile.url) throw new Error(`Invalid ${where}: "url" is required.`);
    const url = validateProfileUrl(profile.url, where, '"url"');
    if (profile.description !== undefined && typeof profile.description !== 'string') throw new Error(`Invalid ${where}: "description" must be text.`);
    const max = profile.maxTimeoutSeconds;
    if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 3600)) {
      throw new Error(`Invalid ${where}: "maxTimeoutSeconds" must be an integer between 1 and 3600.`);
    }
    const queries = profile.maxQueriesPerMinute;
    if (queries !== undefined && (!Number.isInteger(queries) || queries < 1 || queries > maxQueriesLimit)) {
      throw new Error(`Invalid ${where}: "maxQueriesPerMinute" must be an integer between 1 and ${maxQueriesLimit}.`);
    }
    return {
      name, url, description: profile.description || null,
      maxTimeoutMs: max === undefined ? null : max * 1000,
      maxQueriesPerMinute: queries ?? null,
    };
  });
}

// A script root is a folder the user keeps change scripts in, for example a
// folder of saved SQL scripts. Only its name and path are stored: an absolute path
// without control characters and nothing that looks like a connection string
// or a password. Whether it exists is checked when a script is saved.
const passwordLike = /:\/\/|\b(password|passwd|pwd|secret|token)\s*[=:]/i;

function validateScriptRoot(value, where, label = 'script root') {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${where}: expected an absolute directory path.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${where}: the path contains control characters.`);
  if (passwordLike.test(value)) throw new Error(`Invalid ${where}: a ${label} is a directory path; it must not look like a URL or hold a password.`);
  if (!path.isAbsolute(value)) throw new Error(`Invalid ${where}: the path must be absolute.`);
  return path.resolve(value);
}

// Language for schema-memory notes from the profiles file, or null when unset.
export function readNotesLanguage(file) {
  const value = readProfilesData(file)?.[notesLanguageKey];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !notesLanguagePattern.test(value)) {
    throw new Error(`Invalid "${notesLanguageKey}" in ${file}: expected a language code such as tr, en or pt-BR.`);
  }
  return value;
}

// The Auspex checkout the desktop app runs src/stageCli.js from, or null when
// unset: an absolute, existing directory that holds src/stageCli.js.
export function readAuspexRoot(file) {
  const value = readProfilesData(file)?.[auspexRootKey];
  if (value === undefined) return null;
  const where = `"${auspexRootKey}" in ${file}`;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${where}: expected an absolute directory path.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${where}: the path contains control characters.`);
  if (!path.isAbsolute(value)) throw new Error(`Invalid ${where}: the path must be absolute.`);
  const dir = path.resolve(value);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Invalid ${where}: the directory does not exist.`);
  if (!fs.statSync(path.join(dir, 'src', 'stageCli.js'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Invalid ${where}: the directory has no src/stageCli.js (expected the Auspex checkout).`);
  }
  return dir;
}

// Named folders from the profiles file and from <envPrefix><NAME>:
// name -> { dir, source }. Names follow the profile-name rules; the same name
// in both places is an error. Used for script roots and code roots.
function readNamedRoots(file, env, key, envPrefix, label) {
  const roots = new Map();
  const fromFile = readProfilesData(file)?.[key];
  if (fromFile !== undefined) {
    if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
      throw new Error(`Invalid "${key}" in ${file}: expected an object of name -> absolute directory.`);
    }
    for (const [rawName, dir] of Object.entries(fromFile)) {
      const name = rawName.toLowerCase();
      const where = `${label} "${rawName}" in ${file}`;
      if (!profileNamePattern.test(name)) throw new Error(`Invalid ${where}: names use a-z, 0-9, - and _ and start with a letter.`);
      if (roots.has(name)) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} "${name}" is defined twice in ${file} (names are case-insensitive).`);
      roots.set(name, { dir: validateScriptRoot(dir, where, label), source: 'file' });
    }
  }
  for (const [envKey, value] of Object.entries(env)) {
    if (!envKey.toUpperCase().startsWith(envPrefix) || !value) continue;
    const name = envKey.slice(envPrefix.length).toLowerCase();
    if (!profileNamePattern.test(name)) throw new Error(`Invalid ${envKey}: ${label} names use a-z, 0-9, - and _ and start with a letter.`);
    if (roots.has(name)) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} "${name}" is defined both in ${file} and in ${envKey}; keep only one.`);
    roots.set(name, { dir: validateScriptRoot(value, `${label} "${name}" in ${envKey}`, label), source: 'env' });
  }
  return roots;
}

// Script roots: folders save_execute_script writes change scripts into.
export function readScriptRoots(file, env = process.env) {
  return readNamedRoots(file, env, scriptRootsKey, scriptRootPrefix, 'script root');
}

// Code roots: source code folders the agent reads with its own file tools.
// Auspex never reads or writes them; their names scope remember evidenceCode.
export function readCodeRoots(file, env = process.env) {
  return readNamedRoots(file, env, codeRootsKey, codeRootPrefix, 'code root');
}

export function loadConfig(env = process.env) {
  const profiles = new Map();
  const profileInfo = new Map();
  const maxTimeoutByProfile = new Map();
  const maxQueriesByProfile = new Map();

  const profilesFile = env.AUSPEX_PROFILES_FILE || defaultProfilesFile(env);
  for (const p of readProfilesFile(profilesFile)) {
    profiles.set(p.name, p.url);
    profileInfo.set(p.name, { source: 'file', description: p.description });
    if (p.maxTimeoutMs !== null) maxTimeoutByProfile.set(p.name, p.maxTimeoutMs);
    if (p.maxQueriesPerMinute !== null) maxQueriesByProfile.set(p.name, p.maxQueriesPerMinute);
  }

  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith(profilePrefix) || !value) continue;
    const name = key.slice(profilePrefix.length).toLowerCase();
    const where = `profile "${name}" in ${key}`;
    if (!profileNamePattern.test(name)) throw new Error(`Invalid ${key}: profile names use a-z, 0-9, - and _ and start with a letter.`);
    const url = validateProfileUrl(value, where, 'the value');
    if (profiles.has(name)) {
      throw new Error(`Profile "${name}" is defined both in ${profilesFile} and in ${key}; keep only one.`);
    }
    profiles.set(name, url);
    profileInfo.set(name, { source: 'env', description: null });
  }

  const dataDir = env.AUSPEX_DATA_DIR || defaultDataDir(env);
  const statementTimeoutMs = intFromEnv(env, 'AUSPEX_STATEMENT_TIMEOUT_MS', 30000, 1000, 3600000);
  const maxStatementTimeoutMs = intFromEnv(env, 'AUSPEX_MAX_STATEMENT_TIMEOUT_MS', 300000, 1000, 3600000);
  if (maxStatementTimeoutMs < statementTimeoutMs) {
    throw new Error('AUSPEX_MAX_STATEMENT_TIMEOUT_MS must not be lower than AUSPEX_STATEMENT_TIMEOUT_MS.');
  }

  // Per-profile ceiling from env, e.g. AUSPEX_MAX_STATEMENT_TIMEOUT_MS_EXAMPLE=120000,
  // overrides maxTimeoutSeconds from the file.
  for (const name of profiles.keys()) {
    const key = `AUSPEX_MAX_STATEMENT_TIMEOUT_MS_${name.toUpperCase()}`;
    if (env[key]) maxTimeoutByProfile.set(name, intFromEnv(env, key, maxStatementTimeoutMs, 1000, 3600000));
  }

  // Query budget: database operations per profile per minute in one process.
  // AUSPEX_MAX_QUERIES_PER_MINUTE_<NAME> overrides maxQueriesPerMinute from the file.
  const maxQueriesPerMinute = intFromEnv(env, 'AUSPEX_MAX_QUERIES_PER_MINUTE', 60, 1, maxQueriesLimit);
  for (const name of profiles.keys()) {
    const key = `AUSPEX_MAX_QUERIES_PER_MINUTE_${name.toUpperCase()}`;
    if (env[key]) maxQueriesByProfile.set(name, intFromEnv(env, key, maxQueriesPerMinute, 1, maxQueriesLimit));
  }

  return {
    profiles,
    profileInfo,
    profilesFile,
    scriptRoots: readScriptRoots(profilesFile, env),
    codeRoots: readCodeRoots(profilesFile, env),
    notesLanguage: readNotesLanguage(profilesFile),
    auspexRoot: readAuspexRoot(profilesFile),
    maxRows: intFromEnv(env, 'AUSPEX_MAX_ROWS', 500, 1, 10000),
    exportMaxRows: intFromEnv(env, 'AUSPEX_EXPORT_MAX_ROWS', 100000, 1, 5000000),
    // Whole-export budget on top of the per-statement timeout.
    exportMaxBytes: intFromEnv(env, 'AUSPEX_EXPORT_MAX_BYTES', 100 * 1024 * 1024, 1024, 10 * 1024 * 1024 * 1024),
    exportMaxMs: intFromEnv(env, 'AUSPEX_EXPORT_MAX_MS', 300000, 1000, 3600000),
    statementTimeoutMs,
    maxStatementTimeoutMs,
    maxTimeoutByProfile,
    maxQueriesPerMinute,
    maxQueriesByProfile,
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
    // As node-postgres reads it: IPv6 without brackets, percent-decoded
    // (a Unix socket directory is written %2Fvar%2Frun%2Fpostgresql).
    return {
      host: decodeURIComponent(url.hostname.replace(/^\[(.*)\]$/, '$1')),
      port: url.port || '5432',
      // The database with decodeURI, like node-postgres (an encoded / stays %2F).
      database: decodeURI(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
      passwordInString: url.password !== '' || queryPasswordKeys(url).length > 0,
    };
  } catch {
    return { error: 'Connection string is not a URL (postgresql://user@host:port/db expected).' };
  }
}
