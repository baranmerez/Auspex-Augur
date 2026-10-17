import fs from 'node:fs';
import { StageError } from '../reports/stageChange.js';

// Archive one schema-memory note on behalf of a person: shared by the browser
// viewer (POST /api/memory/archive) and the desktop app (src/stageCli.js
// archive-note). Uses the same store logic as the MCP tool `remember
// action=archive`, under the profile's memory lock. Files only: no database,
// no network. Adding or confirming notes stays an agent action.

export const archiveKeys = ['profile', 'id', 'reason'];
export const maxReasonLength = 200;
const profilePattern = /^[a-z][a-z0-9_-]{0,39}$/;
// C0 controls, DEL and C1 controls (Rust: char::is_control).
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/;

// Why a reason is not acceptable, or null. Trimmed, 1 to maxReasonLength
// UTF-16 units, one line without control characters.
export function reasonProblem(reason) {
  if (typeof reason !== 'string') return 'reason must be a string';
  if (!reason.trim()) return 'reason is required';
  if (reason.trim() !== reason) return 'reason must not start or end with spaces';
  if (reason.length > maxReasonLength) return `reason is longer than ${maxReasonLength} characters`;
  if (controlPattern.test(reason)) return 'reason must not contain control characters';
  return null;
}

// { profile, id, reason } and nothing else: profile in the profile-name
// format, id a positive integer note id, reason as reasonProblem allows.
export function validateArchiveInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StageError(400, 'Body must be a JSON object');
  if (Object.keys(body).some(k => !archiveKeys.includes(k)) || archiveKeys.some(k => !Object.hasOwn(body, k))) {
    throw new StageError(400, `Exactly ${archiveKeys.join(', ')} are required`);
  }
  const { profile, id, reason } = body;
  if (typeof profile !== 'string' || !profilePattern.test(profile)) throw new StageError(400, 'Invalid profile name', 'PROFILE_INVALID');
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new StageError(400, 'id must be a positive integer note id');
  const problem = reasonProblem(reason);
  if (problem) throw new StageError(400, problem);
  return { profile, id, reason };
}

// Checks and archives under the memory lock; archiveNoteUnlocked rebuilds the
// view (graph.json) while the lock is still held. Unknown note: 404
// NOT_FOUND; a note that is already archived: 409 PRECONDITION_FAILED (the
// MCP tool re-archives silently; a person gets told instead).
export function archiveNoteFor(memory, { profile, id, reason }) {
  // Checked before the lock so a missing profile folder is not created.
  if (!fs.existsSync(memory.profileDir(profile))) throw new StageError(404, `No schema memory for profile "${profile}".`, 'NOT_FOUND');
  return memory.locked(profile, () => {
    const note = memory.readNotes(profile).notes.find(n => n.id === id);
    if (!note) throw new StageError(404, `Note #${id} not found.`, 'NOT_FOUND');
    if (note.status !== 'active') throw new StageError(409, `Note #${id} is already archived.`, 'PRECONDITION_FAILED');
    return memory.archiveNoteUnlocked(profile, id, reason);
  });
}
