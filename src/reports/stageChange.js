import fs from 'node:fs';
import { normalizeRef, refLabel, sqlHashPattern } from './library.js';
import { approveInLibrary, revokeInLibrary } from './service.js';
import { classifyError } from '../errors.js';

// Approve or revoke one report in the local library on behalf of a person:
// shared by the browser viewer (POST routes) and the desktop app (src/stageCli.js).
// Files only: no database, no network.

export const refKeys = ['db', 'schema', 'category', 'name'];
// A category may be 3 levels of up to 80 characters joined by "/".
export const maxRefFieldLength = 260;
// The SQL hash of the version the person reviewed (the confirm dialog).
export const expectedHashKey = 'expectedHash';

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

// A stage-change request: the report location plus expectedHash, the SQL hash
// of the version the person reviewed (required). Returns { ref, expectedHash }.
export function validateStageInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StageError(400, 'Body must be a JSON object');
  const { [expectedHashKey]: expectedHash, ...rest } = body;
  if (expectedHash === undefined || expectedHash === null) {
    throw new StageError(400, `${expectedHashKey} is missing. This report has no SQL hash yet (saved by an older Auspex). Run it with run_report or re-render the library with render_reports, then reload; if its SQL file was edited by hand, save it with save_report first.`);
  }
  if (typeof expectedHash !== 'string' || !sqlHashPattern.test(expectedHash)) {
    throw new StageError(400, `${expectedHashKey} must be the SQL hash of the reviewed version (12 lower-case hex characters)`);
  }
  return { ref: validateRefInput(rest), expectedHash };
}

// Checks the stage and moves the report under the library lock; the memory
// view is rebuilt while the lock is still held (see changeStage in service.js).
// expectedHash: the reviewed SQL hash; another current version is refused
// with STALE_VERSION (409) and nothing moves.
export function applyStageChange(lib, action, ref, { by, memory, expectedHash }) {
  const label = refLabel(ref);
  // Checked before the lock so a missing library folder is not created.
  if (!fs.existsSync(lib.root)) throw new StageError(404, `Report "${label}" not found.`, 'NOT_FOUND');
  const result = lib.locked(() => {
    if (!lib.exists(action.from, ref)) {
      if (lib.exists(action.to, ref)) throw new StageError(409, `Report "${label}" is ${action.to}, not ${action.from}.`, 'PRECONDITION_FAILED');
      throw new StageError(404, `Report "${label}" not found.`, 'NOT_FOUND');
    }
    return action.run(lib, ref, { by, memory, expectedHash });
  });
  return { report: label, stage: action.to, version: action.version(result) ?? null };
}

export const statusOf = err => err instanceof StageError ? err.status
  : ({ NOT_FOUND: 404, PRECONDITION_FAILED: 409, STALE_VERSION: 409, INVALID_INPUT: 400, LOCK_BUSY: 503 })[classifyError(err).code] ?? 500;
