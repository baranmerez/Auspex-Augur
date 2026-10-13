// Cross-process lock for the report library and the schema memory, so two
// Auspex processes (two MCP clients, a script, the viewer's neighbour) never
// lose each other's read-modify-write updates. Synchronous on purpose: every
// guarded section is short file work.
//
// The lock is a file created with 'wx' (atomic create-if-absent) holding the
// owner's pid, host and a random token. It is taken over when the owner
// process is gone (same host) or the file is older than staleMs. Waiting is
// bounded; after waitMs the caller gets a LockBusyError and may retry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export class LockBusyError extends Error {
  constructor(lockPath) {
    super(`Another Auspex process is writing (${lockPath}); try again in a moment.`);
    this.code = 'LOCK_BUSY';
    this.retryable = true;
  }
}

// Windows reports a file that another process has open (a reader, antivirus,
// the search indexer) or that is being deleted with these codes; they pass.
const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
const held = new Map(); // resolved lockPath -> { token, depth }: re-entrant within one process
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const sleep = ms => Atomics.wait(sleepBuffer, 0, 0, ms);

function readOwner(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // missing, or caught between create and write
  }
}

function ownerIsGone(owner) {
  if (!owner || owner.host !== os.hostname() || !Number.isInteger(owner.pid)) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

// What a lock file is right now: its owner and a key that names this
// generation of the lock (the token, or the inode when the body is unreadable).
function snapshot(file) {
  let stat;
  try { stat = fs.statSync(file, { bigint: true }); } catch { return null; }
  const owner = readOwner(file);
  const key = /^[0-9a-f]{16}$/.test(owner?.token ?? '') ? owner.token : `ino${stat.ino}`;
  return { owner, key, mtimeMs: Number(stat.mtimeMs) };
}

const isStale = (snap, staleMs) => !!snap && (ownerIsGone(snap.owner) || Date.now() - snap.mtimeMs > staleMs);

// Retires one stale generation of the lock. Only the process that creates the
// generation's takeover marker may move it aside, and it re-checks that the
// lock is still that generation, so a fresh lock taken meanwhile by someone
// else is never removed.
function takeOver(lockPath, seen, staleMs) {
  const marker = `${lockPath}.takeover.${seen.key}`;
  try {
    fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, host: os.hostname() }), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST' && !transient.has(err.code)) throw err;
    // A marker left by a taker that died is itself stale.
    if (isStale(snapshot(marker), staleMs)) fs.rmSync(marker, { force: true });
    return;
  }
  try {
    const now = snapshot(lockPath);
    if (now?.key !== seen.key || !isStale(now, staleMs)) return;
    const aside = `${lockPath}.stale.${process.pid}.${seen.key}`;
    fs.renameSync(lockPath, aside);
    fs.rmSync(aside, { force: true });
  } catch (err) {
    if (err.code !== 'ENOENT' && !transient.has(err.code)) throw err;
  } finally {
    fs.rmSync(marker, { force: true });
  }
}

function acquire(lockPath, { waitMs, staleMs }) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: new Date().toISOString() });
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(lockPath, body, { flag: 'wx' });
      return token;
    } catch (err) {
      if (err.code !== 'EEXIST' && !transient.has(err.code)) throw err;
    }
    const seen = snapshot(lockPath);
    if (isStale(seen, staleMs)) {
      takeOver(lockPath, seen, staleMs);
      // A takeover that keeps failing (file held open, fresh marker of another
      // taker) must not spin past the deadline.
      if (Date.now() >= deadline) throw new LockBusyError(lockPath);
      if (attempt > 0) sleep(Math.min(10 + attempt * 5, 50));
      continue;
    }
    if (Date.now() >= deadline) throw new LockBusyError(lockPath);
    sleep(Math.min(10 + attempt * 5, 50));
  }
}

function release(lockPath, token) {
  // Only remove the lock if it is still ours (it may have been taken over).
  // A failure here never masks the guarded function's result or error; the
  // pid/age takeover recovers a lock left behind.
  try {
    if (readOwner(lockPath)?.token === token) fs.rmSync(lockPath, { force: true, maxRetries: 5, retryDelay: 20 });
  } catch { /* see above */ }
}

// renameSync that waits out transient Windows errors (target open by a reader)
// and removes the source if it finally fails, so no temp file is left behind.
export function renameRetrying(from, to, { waitMs = 2000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (let i = 0; ; i++) {
    // Sleeps on Windows end on the ~15.6 ms clock tick, the same tick a polling
    // reader wakes on; retry back to back for ~3 ms so we land after its read.
    const spinUntil = performance.now() + 3;
    let err;
    do {
      try { return fs.renameSync(from, to); } catch (e) { err = e; }
    } while (transient.has(err.code) && performance.now() < spinUntil);
    if (!transient.has(err.code) || Date.now() >= deadline) {
      fs.rmSync(from, { force: true });
      throw err;
    }
    sleep(Math.min(5 + i * 5, 50));
  }
}

// Runs fn while holding the lock at lockPath. Nested calls for the same path
// in the same process just run fn.
export function withFileLock(lockPath, fn, { waitMs = 5000, staleMs = 30000 } = {}) {
  const key = path.resolve(lockPath);
  const mine = held.get(key);
  if (mine) {
    mine.depth++;
    try { return fn(); } finally { mine.depth--; }
  }
  const token = acquire(lockPath, { waitMs, staleMs });
  held.set(key, { token, depth: 1 });
  try {
    const result = fn();
    if (typeof result?.then === 'function') throw new Error('withFileLock needs a synchronous function; the lock would be released before it finishes.');
    return result;
  } finally {
    held.delete(key);
    release(lockPath, token);
  }
}
