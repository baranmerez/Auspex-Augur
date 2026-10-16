import fs from 'node:fs';
import { normalizeRef, refLabel } from './library.js';
import { approveInLibrary, revokeInLibrary } from './service.js';
import { classifyError } from '../errors.js';

// Approve or revoke one report in the local library on behalf of a person:
// shared by the browser viewer (POST routes) and the desktop app (src/stageCli.js).
// Files only: no database, no network.

export const refKeys = ['db', 'schema', 'category', 'name'];
export const maxRefFieldLength = 200;

// An error with an HTTP-like status (the viewer answers with it; the CLI only
// prints the code).
export class StageError extends Error {
  constructor(status, message, errorCode = 'INVALID_INPUT') {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

// The report must be in `from`; version: the SQL version the result names.
export const stageActions = {
  approve: { tool: 'approve_report', from: 'draft', to: 'approved', run: approveInLibrary, version: r => r.meta.approvedVersion },
  revoke: { tool: 'revoke_report', from: 'approved', to: 'draft', run: revokeInLibrary, version: r => r.version },
};

// { db, schema, category, name } exactly as the library lists it: any other
// field, a non-string, or a value that normalizes differently is refused, so
// a request can only name a library location.
export function validateRefInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StageError(400, 'Body must be a JSON object');
  if (Object.keys(body).some(k => !refKeys.includes(k))) throw new StageError(400, `Only ${refKeys.join(', ')} are allowed`);
  if (refKeys.some(k => typeof body[k] !== 'string' || !body[k] || body[k].length > maxRefFieldLength)) {
    throw new StageError(400, `${refKeys.join(', ')} must be non-empty strings`);
  }
  let ref;
  try { ref = normalizeRef(body); } catch (err) { throw new StageError(400, err.message); }
  if (refKeys.some(k => ref[k] !== body[k])) throw new StageError(400, 'Report reference is not a library location');
  return ref;
}

// Checks the stage and moves the report under the library lock; the memory
// view is rebuilt while the lock is still held (see changeStage in service.js).
export function applyStageChange(lib, action, ref, { by, memory }) {
  const label = refLabel(ref);
  // Checked before the lock so a missing library folder is not created.
  if (!fs.existsSync(lib.root)) throw new StageError(404, `Report "${label}" not found.`, 'NOT_FOUND');
  const result = lib.locked(() => {
    if (!lib.exists(action.from, ref)) {
      if (lib.exists(action.to, ref)) throw new StageError(409, `Report "${label}" is ${action.to}, not ${action.from}.`, 'PRECONDITION_FAILED');
      throw new StageError(404, `Report "${label}" not found.`, 'NOT_FOUND');
    }
    return action.run(lib, ref, { by, memory });
  });
  return { report: label, stage: action.to, version: action.version(result) ?? null };
}

export const statusOf = err => err instanceof StageError ? err.status
  : ({ NOT_FOUND: 404, PRECONDITION_FAILED: 409, INVALID_INPUT: 400, LOCK_BUSY: 503 })[classifyError(err).code] ?? 500;
