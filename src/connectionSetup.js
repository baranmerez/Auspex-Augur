// The desktop Setup screen's connection step (stageCli.js save-connection):
// adds or updates one profile in the profiles file and writes its password as
// one line of the pgpass file. The request arrives as JSON on stdin; the
// password is never put in argv, the profiles file, an error message, the
// audit log or the output. Nothing here connects to a database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StageError } from './reports/stageChange.js';
import { writePrivateAtomic } from './privateFiles.js';
import { validateProfileUrl } from './config.js';

export const connectionKeys = ['profileName', 'host', 'port', 'database', 'user', 'password'];
export const maxConnectionBytes = 8 * 1024;
const maxPasswordLength = 1024;
const profileNamePattern = /^[a-z][a-z0-9_-]{0,39}$/;
const hostNamePattern = /^[A-Za-z0-9_]([A-Za-z0-9_.-]{0,252})$/;
const ipv6Pattern = /^[0-9A-Fa-f:.]{2,45}$/;

const bad = message => new StageError(400, message);

function checkName(key, value) {
  if (typeof value !== 'string' || !value) throw bad(`${key} is required.`);
  if (Buffer.byteLength(value, 'utf8') > 63) throw bad(`${key} is at most 63 bytes.`);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) throw bad(`${key} must not contain control characters.`);
  if (value.trim() !== value) throw bad(`${key} must not start or end with spaces.`);
}

// The request of save-connection, checked in full. Messages name the field,
// never its value (the password is never echoed).
export function validateConnection(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request must be a JSON object.');
  const unknown = Object.keys(body).filter(k => !connectionKeys.includes(k));
  if (unknown.length) throw bad(`Unknown field(s): ${unknown.map(k => String(k).slice(0, 40)).join(', ')}.`);
  const missing = connectionKeys.filter(k => !Object.hasOwn(body, k));
  if (missing.length) throw bad(`Missing field(s): ${missing.join(', ')}.`);
  const { profileName, host, port, database, user, password } = body;
  if (typeof profileName !== 'string' || !profileNamePattern.test(profileName)) {
    throw bad('profileName: use a-z, 0-9, - and _, start with a letter, at most 40 characters.');
  }
  if (typeof host !== 'string' || !(hostNamePattern.test(host) || (host.includes(':') && ipv6Pattern.test(host)))) {
    throw bad('host must be a host name, an IPv4 address or an IPv6 address (without brackets).');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('port must be a whole number from 1 to 65535.');
  checkName('database', database);
  checkName('user', user);
  if (typeof password !== 'string' || !password) throw bad('password is required.');
  if (password.length > maxPasswordLength) throw bad(`password is at most ${maxPasswordLength} characters.`);
  if (/[\u0000\r\n]/.test(password)) throw bad('password must be one line.');
  return { profileName, host, port, database, user, password };
}

// The profile URL: postgresql://user@host:port/database, parts percent-encoded,
// an IPv6 host in brackets. No password.
export function connectionUrl({ host, port, database, user }) {
  const h = host.includes(':') ? `[${host}]` : host;
  return `postgresql://${encodeURIComponent(user)}@${h}:${port}/${encodeURIComponent(database)}`;
}

// The profiles file with the profile added or its url replaced; every other
// profile and key, and the profile's other fields, stay as they were (and in
// their order). A key that differs only in case is the same profile, as in
// readProfilesFile. text: the file's content, or null when it does not exist.
export function mergeProfiles(text, name, url, file = 'the profiles file') {
  let data = {};
  if (text !== null) {
    try {
      data = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      throw new StageError(409, `${file} is not valid JSON; fix it first, nothing was written.`, 'PRECONDITION_FAILED');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new StageError(409, `${file} must be a JSON object of profiles; fix it first, nothing was written.`, 'PRECONDITION_FAILED');
    }
  }
  try {
    validateProfileUrl(url, `profile "${name}"`, '"url"');
  } catch (err) {
    throw bad(err.message);
  }
  const key = Object.keys(data).find(k => k.toLowerCase() === name);
  const existing = key === undefined ? undefined : data[key];
  if (key !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new StageError(409, `Profile "${key}" in ${file} is not an object; fix it first, nothing was written.`, 'PRECONDITION_FAILED');
  }
  const next = key === undefined ? { ...data, [name]: { url } } : { ...data, [key]: { ...existing, url } };
  return { text: `${JSON.stringify(next, null, 2)}\n`, action: key === undefined ? 'added' : 'updated' };
}

// One pgpass field with \ and : escaped (libpq and node-postgres unescape them).
export const pgpassEscape = value => String(value).replace(/[\\:]/g, m => `\\${m}`);

// The fields of one pgpass line (without its line ending), unescaped.
export function pgpassFields(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) cur += line[++i];
    else if (c === ':') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// The pgpass file with the line for host:port:database:user replaced (the
// first exact match, no wildcards) or added at the end. Every other line is
// kept byte for byte with its own line ending; a leading BOM is dropped
// (libpq would read it as part of the first host). text: the content, or null.
export function mergePgpass(text, { host, port, database, user, password }, eol = process.platform === 'win32' ? '\r\n' : '\n') {
  const body = (text ?? '').replace(/^﻿/, '');
  const line = [host, String(port), database, user, password].map(pgpassEscape).join(':');
  const lines = body.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) || [];
  const want = [host, String(port), database, user];
  const index = lines.findIndex(l => {
    const content = l.replace(/(?:\r\n|\n|\r)$/, '');
    if (content.startsWith('#')) return false;
    const f = pgpassFields(content);
    return f.length >= 5 && want.every((v, i) => f[i] === v);
  });
  if (index >= 0) {
    const ending = lines[index].match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';
    lines[index] = line + ending;
    return { text: lines.join(''), action: 'replaced' };
  }
  const lineEnding = body.match(/\r\n|\n|\r/)?.[0] ?? eol;
  const joined = lines.join('');
  const sep = joined && !/(?:\r\n|\n|\r)$/.test(joined) ? lineEnding : '';
  return { text: `${joined}${sep}${line}${lineEnding}`, action: 'added' };
}

// Where the password goes: PGPASSFILE (must be absolute), else
// %APPDATA%\postgresql\pgpass.conf on Windows and ~/.pgpass elsewhere.
export function pgpassFile(env = process.env, platform = process.platform) {
  if (env.PGPASSFILE) {
    if (!path.isAbsolute(env.PGPASSFILE)) throw new StageError(409, 'PGPASSFILE must be an absolute path; nothing was written.', 'PRECONDITION_FAILED');
    return env.PGPASSFILE;
  }
  if (platform === 'win32') {
    if (!env.APPDATA) throw new StageError(409, 'APPDATA is not set, so the pgpass location is unknown; set PGPASSFILE. Nothing was written.', 'PRECONDITION_FAILED');
    return path.join(env.APPDATA, 'postgresql', 'pgpass.conf');
  }
  return path.join(env.HOME || os.homedir(), '.pgpass');
}

const readOrNull = file => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new StageError(500, `Could not read ${file} (${err.code || 'error'}); nothing was written.`, 'DISK_ERROR');
  }
};

// Validates, then writes the profiles file and the pgpass file, each
// atomically (temp file and rename, UTF-8 without BOM). Returns what was
// done, without the password.
export function saveConnection(body, { profilesFile, env = process.env }) {
  const input = validateConnection(body);
  const name = input.profileName;
  if (env[`AUSPEX_DB_${name.toUpperCase()}`]) {
    throw new StageError(409, `The profile "${name}" is already set by the AUSPEX_DB_${name.toUpperCase()} environment variable; remove it or pick another name. Nothing was written.`, 'PRECONDITION_FAILED');
  }
  const url = connectionUrl(input);
  const passFile = pgpassFile(env);
  const profiles = mergeProfiles(readOrNull(profilesFile), name, url, profilesFile);
  const pass = mergePgpass(readOrNull(passFile), input);
  writePrivateAtomic(profilesFile, profiles.text);
  try {
    writePrivateAtomic(passFile, pass.text);
  } catch (err) {
    throw new StageError(500, `The profile was saved in ${profilesFile}, but ${passFile} could not be written (${err.code || 'error'}); the password was not stored.`, 'DISK_ERROR');
  }
  return { profile: name, url, profilesFile, profileAction: profiles.action, pgpassFile: passFile, pgpassAction: pass.action };
}
