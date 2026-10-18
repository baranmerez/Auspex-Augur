import fs from 'node:fs';
import { StageError } from '../reports/stageChange.js';
import { columnRoles, effectiveScore } from './store.js';

// Set or remove one user column score on behalf of a person: shared by the
// browser viewer (POST /api/memory/column-score) and the desktop app
// (src/stageCli.js score-column). Writes only the user layer, through the same
// store logic as the MCP tool `score_columns` with by "user", under the
// profile's memory lock (atomic writes, view rebuilt). Files only: no
// database, no network. Agent scores, reasons and usage notes stay agent
// actions (a usage note is a `remember` rule given in chat).

export const userScoreKeys = ['profile', 'schema', 'table', 'column', 'score', 'clear', 'roles'];
// PostgreSQL identifiers are at most 63 bytes (NAMEDATALEN - 1).
export const maxNameBytes = 63;
const profilePattern = /^[a-z][a-z0-9_-]{0,39}$/;
// C0 controls, DEL and C1 controls (Rust: char::is_control).
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/;

// Why a schema, table or column name is not acceptable, or null: a string of
// 1 to maxNameBytes UTF-8 bytes without control characters.
export function nameProblem(key, value) {
  if (typeof value !== 'string' || !value) return `${key} must be a non-empty string`;
  if (Buffer.byteLength(value, 'utf8') > maxNameBytes) return `${key} is longer than ${maxNameBytes} bytes`;
  if (controlPattern.test(value)) return `${key} must not contain control characters`;
  return null;
}

// { profile, schema, table, column, score (1-5 integer) | clear: true,
// roles? } and nothing else. roles only with score: a list of distinct
// columnRoles, returned in their canonical order.
export function validateUserScoreInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StageError(400, 'Body must be a JSON object');
  const extra = Object.keys(body).filter(k => !userScoreKeys.includes(k));
  // The unknown key names are not echoed: the audit log keeps no free text.
  if (extra.length) throw new StageError(400, `${extra.length} unknown key(s); allowed are ${userScoreKeys.join(', ')}`);
  for (const k of ['profile', 'schema', 'table', 'column']) if (!Object.hasOwn(body, k)) throw new StageError(400, `${k} is required`);
  const { profile, schema, table, column } = body;
  if (typeof profile !== 'string' || !profilePattern.test(profile)) throw new StageError(400, 'Invalid profile name', 'PROFILE_INVALID');
  for (const [k, v] of [['schema', schema], ['table', table], ['column', column]]) {
    const problem = nameProblem(k, v);
    if (problem) throw new StageError(400, problem);
  }
  const hasScore = Object.hasOwn(body, 'score'), hasClear = Object.hasOwn(body, 'clear');
  if (hasScore === hasClear) throw new StageError(400, 'Give exactly one of score or clear');
  if (hasClear) {
    if (body.clear !== true) throw new StageError(400, 'clear must be true');
    if (Object.hasOwn(body, 'roles')) throw new StageError(400, 'roles go with a score, not with clear');
    return { profile, schema, table, column, clear: true };
  }
  const { score } = body;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) throw new StageError(400, 'score must be an integer from 1 to 5');
  if (!Object.hasOwn(body, 'roles')) return { profile, schema, table, column, score };
  const { roles } = body;
  if (!Array.isArray(roles)) throw new StageError(400, 'roles must be an array');
  if (roles.some(r => typeof r !== 'string' || !columnRoles.includes(r))) throw new StageError(400, `roles must be any of ${columnRoles.join(', ')}`);
  if (new Set(roles).size !== roles.length) throw new StageError(400, 'roles lists a role twice');
  return { profile, schema, table, column, score, roles: columnRoles.filter(r => roles.includes(r)) };
}

// Audit fields of a request: names, the score and role names only (no free
// text exists in this request).
export function userScoreAudit(input) {
  return {
    profile: input.profile, schema: input.schema, table: input.table, column: input.column, columns: 1, layer: 'user', action: input.clear ? 'clear' : 'set',
    ...(input.clear ? {} : { score: input.score, ...(input.roles ? { roles: input.roles } : {}) }),
  };
}

// Checks and writes under the memory lock. No memory for the profile, table
// not in memory or column not in its recorded structure: 404 NOT_FOUND; a
// table only seen in a plan: 409 PRECONDITION_FAILED; clear without a user
// score: 409 (from the store). Returns the column's layers and effective score.
export function setUserScoreFor(memory, input) {
  const { profile, schema, table, column } = input;
  // Checked before the lock so a missing profile folder is not created.
  if (!fs.existsSync(memory.profileDir(profile))) throw new StageError(404, `No schema memory for profile "${profile}".`, 'NOT_FOUND');
  return memory.locked(profile, () => {
    const rec = memory.readTable(profile, schema, table);
    if (!rec) throw new StageError(404, `${schema}.${table} is not in the schema memory.`, 'NOT_FOUND');
    if (!rec.describedAt) throw new StageError(409, `${schema}.${table} is not described yet; describe_table records its structure.`, 'PRECONDITION_FAILED');
    if (!rec.columns.some(c => c.name === column)) throw new StageError(404, `${column} is not a column of ${schema}.${table} in the recorded structure.`, 'NOT_FOUND');
    const entry = input.clear
      ? { name: column, by: 'user', clearUser: true }
      : { name: column, by: 'user', score: input.score, ...(input.roles ? { roles: input.roles } : {}) };
    const result = memory.scoreColumns(profile, { schema, table, columns: [entry] });
    const scores = memory.readTable(profile, schema, table).columnScores ?? {};
    const saved = Object.hasOwn(scores, column) ? scores[column] : null;
    const effective = effectiveScore(saved);
    return {
      relation: result.relation, column, scoredAt: result.scoredAt,
      score: effective?.score ?? null, scoreBy: effective?.by ?? null,
      ...(saved?.user ? { user: saved.user } : {}), ...(saved?.agent ? { agent: saved.agent } : {}),
    };
  });
}
