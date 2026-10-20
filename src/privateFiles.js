// Private files for what Auspex writes that may hold SQL, parameters, row
// values or notes: audit logs, CSV exports, the report library, schedule
// state and trends, and the schema memory.
//
// New files are created 0600 and new folders 0700. Existing folders and files
// are tightened only inside the default Auspex tree (~/.auspex, compared by
// real path, never through a link that leads out of it), only when this
// account owns them and they have group or other bits. Tightening is best
// effort: it never throws and never fails the write it protects. Folders the
// user configured elsewhere (AUSPEX_HOME, AUSPEX_*_DIR) keep the permissions
// the user gave them. Windows ignores mode bits; nothing is changed there.
//
// Temp files are created exclusively under an unpredictable name, so an
// entry planted at that name (a link, a hard link, an old file) is never
// written through.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameRetrying } from './fileLock.js';

const posix = process.platform !== 'win32';
const noted = new Set(); // one stderr note per path and process

function note(target, err) {
  if (noted.has(target)) return;
  noted.add(target);
  process.stderr.write(`auspex: could not restrict permissions of ${target} (${err.code || err.message})\n`);
}

// Real path of ~/.auspex; null when it is missing or itself a link.
function defaultTree() {
  try {
    const tree = path.join(fs.realpathSync(os.homedir()), '.auspex');
    return fs.lstatSync(tree).isDirectory() ? tree : null;
  } catch {
    return null;
  }
}

// Real paths from the tree root down to target; [] when target is outside.
function levelsInTree(target) {
  const tree = defaultTree();
  if (!tree) return [];
  const rel = path.relative(tree, fs.realpathSync(target));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return [];
  const levels = [tree];
  for (const part of rel.split(path.sep).filter(Boolean)) levels.push(path.join(levels.at(-1), part));
  return levels;
}

// Removes group and other bits from an open file or folder this account owns.
function tightenFd(fd) {
  const st = fs.fstatSync(fd);
  if (st.uid !== process.getuid() || (st.mode & 0o077) === 0) return;
  fs.fchmodSync(fd, st.mode & 0o700);
}

function tightenDirs(dir) {
  if (!posix) return;
  let levels;
  try {
    levels = levelsInTree(dir);
  } catch (err) {
    note(dir, err);
    return;
  }
  for (const level of levels) {
    let fd;
    try {
      // O_NOFOLLOW: a level swapped for a link meanwhile is left alone.
      fd = fs.openSync(level, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      tightenFd(fd);
    } catch (err) {
      note(level, err);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* nothing to protect */ }
    }
  }
}

// Creates dir (0700 for every new level) and tightens it inside ~/.auspex.
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  tightenDirs(dir);
}

// Appends text; a new file is 0600, an existing one inside ~/.auspex is tightened.
export function appendPrivate(file, text) {
  ensurePrivateDir(path.dirname(file));
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    if (posix) {
      try {
        if (levelsInTree(file).length) tightenFd(fd);
      } catch (err) {
        note(file, err);
      }
    }
    fs.writeFileSync(fd, text, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const maxTempAttempts = 8;

// Creates a new 0600 temp file next to file under a random name and writes
// data into it. 'wx' never opens an existing entry (a link, a dangling link,
// a hard link or a stale file): such a name is skipped and left untouched.
// Only the temp file this call created is removed when writing fails.
function writeTemp(file, data) {
  for (let attempt = 1; ; attempt++) {
    const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST' && attempt < maxTempAttempts) continue;
      throw err;
    }
    try {
      fs.writeFileSync(fd, data, typeof data === 'string' ? 'utf8' : undefined);
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* removed below */ }
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    fs.closeSync(fd);
    return tmp;
  }
}

// Writes a 0600 temp file and renames it over file, so the result is 0600.
export function writePrivateAtomic(file, data) {
  ensurePrivateDir(path.dirname(file));
  const tmp = writeTemp(file, data);
  renameRetrying(tmp, file); // the viewer may be reading the target on Windows
}

// A copy that is 0600 whatever the source mode (copyFile keeps the source mode).
export function copyPrivate(from, to) {
  writePrivateAtomic(to, fs.readFileSync(from));
}

