// Cross-process lock for the report library and the schema memory, so two
// Auspex processes (two MCP clients, a script, the viewer's neighbour) never
// lose each other's read-modify-write updates. Synchronous on purpose: every
// guarded section is short file work. The one exception is the scheduler's
// run lock (acquireFileLock), held across a whole run with its own maxHoldMs.
//
// The lock is a file created with 'wx' (atomic create-if-absent) holding the
// owner's pid, host and a random token. An owner on this host whose pid is
// alive keeps the lock until it is maxHoldMs old (default 10 minutes); a dead
// owner's lock is taken over at once. Past maxHoldMs a lock (or a takeover
// marker) is reclaimable even when its pid looks alive: the OS may have
// reused the pid of an owner that died holding it, and no guarded section
// runs anywhere near that long. Below maxHoldMs, age (staleMs) decides only
// when liveness cannot be checked (unreadable body, another host). Locks are
// same-host only: network filesystems shared between hosts are not
// supported. Waiting is bounded; after waitMs the caller gets a
// LockBusyError and may retry.
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

// 'alive' or 'gone' for an owner on this host with a pid; 'unknown' otherwise.
function ownerState(owner) {
  if (!owner || owner.host !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return 'unknown';
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (err) {
    if (err.code === 'ESRCH') return 'gone';
    return err.code === 'EPERM' ? 'alive' : 'unknown'; // EPERM: exists, owned by another user
  }
}

// What a lock file is right now: its owner and a key that names this
// generation of the lock (the token, or the inode when the body is unreadable).
function snapshot(file) {
  let stat;
  try { stat = fs.statSync(file, { bigint: true }); } catch { return null; }
  const owner = readOwner(file);
  const key = /^[0-9a-f]{16}$/.test(owner?.token ?? '') ? owner.token : `ino${stat.ino}`;
  return { owner, key, mtimeMs: Number(stat.mtimeMs), ino: stat.ino };
}

// Inode (NTFS file id on Windows) of a file, or null when it is missing or
// the filesystem reports none (0). A rename keeps it, so it says whether a
// detached file is the very generation that was checked before the rename.
function inodeOf(file) {
  try {
    const { ino } = fs.statSync(file, { bigint: true });
    return ino === 0n ? null : ino;
  } catch {
    return null;
  }
}

const tokenPattern = /^[0-9a-f]{16}$/;

// Same detached generation as the one checked (checkedToken: its token, or
// null when its body held none). The token in the detached file decides:
// inodes are not stable across a rename everywhere (FAT/exFAT on Windows
// give a renamed file a new file id). Only when the file cannot be read (a
// transient Windows error) does the inode decide, and when that is unknown
// too the answer is "same", the outcome Auspex had before this check: the
// generation is removed as the caller intended.
function sameGeneration(aside, checkedIno, checkedToken) {
  let text;
  try {
    text = fs.readFileSync(aside, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    const ino = inodeOf(aside);
    return ino === null || checkedIno === null || ino === checkedIno;
  }
  let token = null;
  try { token = JSON.parse(text)?.token ?? null; } catch { /* caught between create and write */ }
  if (!tokenPattern.test(token ?? '')) token = null;
  if (token !== null || checkedToken !== null) return token === checkedToken;
  // Neither has a token: a newer lock caught between its create and write
  // also reads empty, so the inode tells them apart (as the ino key did).
  const ino = inodeOf(aside);
  return ino === null || checkedIno === null || ino === checkedIno;
}

function isStale(snap, staleMs, maxHoldMs) {
  if (!snap) return false;
  if (Date.now() - snap.mtimeMs > maxHoldMs) return true; // a reused pid must not keep it forever
  const state = ownerState(snap.owner);
  if (state !== 'unknown') return state === 'gone';
  return Date.now() - snap.mtimeMs > staleMs;
}

// Removing a lock is never "check, then unlink the path": between the two a
// newer generation can take the path, and the unlink would delete it. Instead
// the path is first renamed to a unique aside name, which atomically detaches
// whatever generation is there, and the aside file is checked. A generation
// that is not the one meant is put back with link(), which creates the path
// only while it is still free (EEXIST otherwise, never a replace) and keeps
// the inode and mtime, so its owner and its age are unchanged.
// While a generation is aside by mistake its owner may finish and release:
// release then finds the path empty or not its own, and also removes any
// aside file still holding its token (removeOwnAsides), so put-back finds
// nothing and a lock nobody holds is never restored. If put-back linked it
// first, the owner sees its token on the path again and releases it there.
// Limitation: while a wrongly detached generation is aside (microseconds,
// and only after a check/replace race), a third process may create a fresh
// lock; link() then leaves that one in place and the detached owner loses
// the lock. Filesystems give no atomic compare-and-delete to close this.
// Should a lock nobody holds survive anyway (an owner that crashed in that
// window), it is reclaimed like any other: at once when its pid is gone,
// after maxHoldMs otherwise.
function moveAside(lockPath, tag) {
  const aside = `${lockPath}.${tag}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(lockPath, aside);
    return aside;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function removeAside(aside) {
  // A reader holding the aside file open (Windows) must not turn a finished
  // removal of the lock path into a failure.
  try { fs.rmSync(aside, { force: true, maxRetries: 5, retryDelay: 20 }); } catch (err) { if (err.code !== 'ENOENT' && !transient.has(err.code)) throw err; }
}

// Removes aside files (released or stale) that still carry this owner's
// token: its generation ended, so nobody may put it back.
function removeOwnAsides(lockPath, token) {
  const dir = path.dirname(lockPath);
  const prefixes = [`${path.basename(lockPath)}.released.`, `${path.basename(lockPath)}.stale.`];
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!prefixes.some(p => name.startsWith(p))) continue;
    const file = path.join(dir, name);
    if (readOwner(file)?.token === token) removeAside(file);
  }
}

function putBack(aside, lockPath) {
  try {
    fs.linkSync(aside, lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return; // its owner released it meanwhile: nothing to restore
    if (err.code !== 'EEXIST') {
      // No hard links on this filesystem: exclusive create of a copy, with
      // the original age. EEXIST still means a newer lock is there.
      try {
        const { mtime } = fs.statSync(aside);
        fs.writeFileSync(lockPath, fs.readFileSync(aside), { flag: 'wx' });
        fs.utimesSync(lockPath, mtime, mtime);
      } catch (copyErr) {
        if (copyErr.code === 'ENOENT') return;
        if (copyErr.code !== 'EEXIST') throw copyErr;
      }
    }
  }
  removeAside(aside);
}

// Retires one stale generation of the lock. Only the process that creates the
// generation's takeover marker may move it aside, and it checks the detached
// file is still that generation, so a fresh lock taken meanwhile by someone
// else is put back, never removed. Returns true when it removed the stale
// generation.
function takeOver(lockPath, seen, staleMs, maxHoldMs) {
  const marker = `${lockPath}.takeover.${seen.key}`;
  try {
    fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, host: os.hostname() }), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST' && !transient.has(err.code)) throw err;
    // A marker left by a taker that died is itself stale.
    if (isStale(snapshot(marker), staleMs, maxHoldMs)) fs.rmSync(marker, { force: true });
    return false;
  }
  try {
    const now = snapshot(lockPath);
    if (now?.key !== seen.key || !isStale(now, staleMs, maxHoldMs)) return false;
    const aside = moveAside(lockPath, 'stale');
    if (!aside) return false;
    if (!sameGeneration(aside, now.ino === 0n ? null : now.ino, tokenPattern.test(seen.key) ? seen.key : null)) {
      putBack(aside, lockPath); // replaced after the check above: not ours to retire
      return false;
    }
    removeAside(aside);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT' && !transient.has(err.code)) throw err;
    return false;
  } finally {
    fs.rmSync(marker, { force: true });
  }
}

function acquire(lockPath, { waitMs, staleMs, maxHoldMs }) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 }); // often the first write into a private folder
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
    if (isStale(seen, staleMs, maxHoldMs)) {
      // A takeover that succeeded owes the caller one more create attempt even
      // when the takeover itself ran past the deadline; if another process wins
      // that race, the deadline check below ends the wait.
      if (takeOver(lockPath, seen, staleMs, maxHoldMs)) continue;
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
  // Only remove the lock if it is still ours (it may have been taken over):
  // detach it first, then check the detached file (see moveAside). A failure
  // here never masks the guarded function's result or error; the dead-owner
  // takeover recovers a lock left behind.
  try {
    for (let round = 0; round < 3; round++) {
      // The token read belongs to this inode only if the inode did not change
      // around the read.
      const checkedIno = inodeOf(lockPath);
      const mine = readOwner(lockPath)?.token === token && inodeOf(lockPath) === checkedIno;
      if (!mine) {
        // Not on the path: someone may hold our generation aside and put it
        // back (see moveAside). Remove such copies, then look once more.
        removeOwnAsides(lockPath, token);
        if (readOwner(lockPath)?.token !== token) return;
        continue; // put back meanwhile: release it from the path
      }
      let aside;
      for (let i = 0; ; i++) {
        try { aside = moveAside(lockPath, 'released'); break; } catch (err) {
          if (!transient.has(err.code) || i >= 5) throw err;
          sleep(20);
        }
      }
      if (!aside) continue; // detached by someone else meanwhile
      if (sameGeneration(aside, checkedIno, token)) return removeAside(aside);
      putBack(aside, lockPath); // another generation; ours may now be aside elsewhere
    }
    removeOwnAsides(lockPath, token);
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

// Takes the lock for a long asynchronous job (the scheduler) and returns a
// release function; the same token, takeover-marker and liveness rules as
// withFileLock. Pick maxHoldMs above the longest time the job can hold it:
// past it the lock is reclaimable even when its pid looks alive (reused pid).
// Throws LockBusyError when the lock is still held after waitMs.
export function acquireFileLock(lockPath, { waitMs = 2000, staleMs = 30000, maxHoldMs = 600000 } = {}) {
  const token = acquire(lockPath, { waitMs, staleMs, maxHoldMs });
  return () => release(lockPath, token);
}

// Runs fn while holding the lock at lockPath. Nested calls for the same path
// in the same process just run fn. waitMs bounds the wait, staleMs expires a
// lock whose owner cannot be checked, maxHoldMs is the hard ceiling after
// which any lock is reclaimable (keep it far above the longest guarded fn).
export function withFileLock(lockPath, fn, { waitMs = 5000, staleMs = 30000, maxHoldMs = 600000 } = {}) {
  const key = path.resolve(lockPath);
  const mine = held.get(key);
  if (mine) {
    mine.depth++;
    try { return fn(); } finally { mine.depth--; }
  }
  const token = acquire(lockPath, { waitMs, staleMs, maxHoldMs });
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
