// Local files of the scheduler under <AUSPEX_HOME or ~/.auspex>:
//   schedule-state.json   last result per schedule id (the viewer shows it),
//                         and pendingTrend: a trend point whose write failed,
//                         appended by the next run-due without running SQL
//   trends/<profile>/<schema>/<category...>/<name>.jsonl
//                         one aggregate point per successful scheduled run;
//                         at most one point per schedule id and slot
// Read-modify-write runs under a cross-process file lock and files are
// replaced atomically, so the viewer never reads half a file. Aggregates only:
// a trend point holds counts and column totals, never row values.
import fs from 'node:fs';
import path from 'node:path';
import { auspexHome } from '../config.js';
import { normalizeRef } from '../reports/library.js';
import { withFileLock } from '../fileLock.js';
import { writePrivateAtomic } from '../privateFiles.js';
import { ToolError } from '../errors.js';

export const scheduleStatuses = ['ok', 'skipped-unreachable', 'failed'];
export const maxTrendPoints = 520; // ten years of weekly points, ~1.4 years of daily points
export const maxHistory = 20;
export const trendFormat = 1;

export const stateFile = (env = process.env) => path.join(auspexHome(env), 'schedule-state.json');
export const trendsDir = (env = process.env) => path.join(auspexHome(env), 'trends');

// { schedules: { [id]: { last, lastSuccessSlot, history, pendingTrend? } } }.
// A missing file is a fresh installation and reads as empty. strict: an
// unreadable or malformed file throws (the scheduler refuses to run rather
// than replace it); without strict (viewer, status) it reads as empty.
export function readState(file, { strict = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { schedules: {} };
    if (strict) throw stateError(file, err.code ?? 'unreadable');
    return { schedules: {} };
  }
  let data = null;
  try { data = JSON.parse(text); } catch { /* malformed */ }
  if (data && typeof data === 'object' && data.schedules && typeof data.schedules === 'object' && !Array.isArray(data.schedules)) return data;
  if (strict) throw stateError(file, 'not valid scheduler state JSON');
  return { schedules: {} };
}

function stateError(file, reason) {
  return new ToolError('PRECONDITION_FAILED', `The scheduler state file ${file} cannot be read (${reason}). It is left unchanged and no schedule ran; repair or move it away (a missing file starts fresh), then run again.`);
}

// Read-modify-write of one schedule entry under the state lock; never
// replaces a state file it cannot read.
function updateEntry(file, id, at, fn) {
  return withFileLock(`${file}.lock`, () => {
    const state = readState(file, { strict: true });
    const own = Object.hasOwn(state.schedules, id) ? state.schedules[id] : {};
    const entry = fn({ ...own });
    const schedules = Object.assign(Object.create(null), state.schedules, { [id]: entry });
    writePrivateAtomic(file, `${JSON.stringify({ updatedAt: at, schedules }, null, 2)}\n`);
    return entry;
  });
}

const withHistory = (entry, result) => ({ ...entry, last: result, history: [...(Array.isArray(entry.history) ? entry.history : []), result].slice(-maxHistory) });

// Records one result: { status, slot (null for a manual run), at, errorCode?,
// manual?, persistenceError? }. A successful slot run sets lastSuccessSlot,
// which makes run-due skip that slot. pendingTrend ({ slot, point }): the
// trend point of this run whose write failed; run-due appends it later.
export function recordResult(file, id, result, { pendingTrend = null } = {}) {
  return updateEntry(file, id, result.at, own => {
    const entry = withHistory(own, result);
    if (result.status === 'ok' && result.slot) entry.lastSuccessSlot = result.slot;
    if (pendingTrend) entry.pendingTrend = pendingTrend;
    return entry;
  });
}

// The pending trend point of a slot was appended: drop the marker.
export function clearPendingTrend(file, id, slot, at) {
  return updateEntry(file, id, at, own => {
    if (own.pendingTrend?.slot === slot) delete own.pendingTrend;
    return own;
  });
}

// A slot that completed although its state write failed (its trend point or
// the report's saved run says so): record it as successful without running
// it again. trend: 'ok' | 'lost' (the saved result was replaced meanwhile).
export function reconcileSlot(file, id, slot, at, { trend = 'ok' } = {}) {
  return updateEntry(file, id, at, own => {
    const entry = withHistory(own, { status: 'ok', slot, at, reconciled: true, ...(trend === 'lost' ? { trendLost: true } : {}) });
    entry.lastSuccessSlot = slot;
    return entry;
  });
}

export const scheduleState = (state, id) => (Object.hasOwn(state.schedules, id) ? state.schedules[id] : null);

// The trend file of a report; always inside root.
export function trendFile(root, ref) {
  const r = normalizeRef(ref);
  const base = path.resolve(root);
  const file = path.join(base, r.db, r.schema, ...r.category.split('/'), `${r.name}.jsonl`);
  if (!file.startsWith(base + path.sep)) throw new Error('Trend path escapes the trends folder.');
  return file;
}

// Parsed points of a trend file, oldest first; unreadable lines are skipped.
export function readTrend(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      if (p && typeof p === 'object' && !Array.isArray(p)) out.push(p);
    } catch { /* skip a torn or edited line */ }
  }
  return out;
}

const sameSlot = (p, point) => typeof point.scheduleId === 'string' && typeof point.slot === 'string' && p.scheduleId === point.scheduleId && p.slot === point.slot;

// Appends one point and keeps the newest maxPoints. The point is built by
// trendPoint, so it holds aggregates only. Idempotent per schedule id and
// slot: a point for a slot that already has one is not added again
// (duplicate: true). Points of older files without these keys stay as they are.
export function appendTrend(root, ref, point, { maxPoints = maxTrendPoints } = {}) {
  const file = trendFile(root, ref);
  return withFileLock(`${file}.lock`, () => {
    const existing = readTrend(file);
    if (existing.some(p => sameSlot(p, point))) return { file, points: existing.length, duplicate: true };
    const points = [...existing, point].slice(-maxPoints);
    writePrivateAtomic(file, points.map(p => JSON.stringify(p)).join('\n') + '\n');
    return { file, points: points.length };
  });
}

// True when the trend of a report has a point for this schedule and slot.
export function hasTrendPoint(root, ref, scheduleId, slot) {
  return readTrend(trendFile(root, ref)).some(p => sameSlot(p, { scheduleId, slot }));
}

const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// One trend point from a finished scheduled run. rows is exact (EXPLAIN
// ANALYZE, or a complete preview) or null with estimatedRows from the plan.
// totals are the preview totals of the report page and only kept when the
// preview holds every row; a total over a cut preview would be misleading.
// Ready for later threshold checks: one value per series, keyed by column; a
// total is a number, or decimal text when it has more than 15 significant digits.
// Row count of a run's stored result: exact from EXPLAIN ANALYZE or a
// complete preview, otherwise null with the planner's estimate.
export function runRows(last) {
  const s = last?.summary ?? {};
  const previewRows = Array.isArray(last?.preview) ? last.preview.length : 0;
  const complete = last?.previewExecuted === true && last?.previewTruncated === false;
  const rows = s.analyzed ? finite(s.rows) : complete ? previewRows : null;
  return { rows, estimatedRows: rows === null ? finite(s.rows) : null };
}

export function trendPoint({ scheduleId, slot, ranAt, preset, params, last, sqlHash, version, totals }) {
  const s = last?.summary ?? {};
  const complete = last?.previewExecuted === true && last?.previewTruncated === false;
  const { rows } = runRows(last);
  return {
    v: trendFormat, scheduleId, slot, ranAt, preset: preset ?? null, params: Array.isArray(params) ? params : null,
    sqlHash: sqlHash ?? null, version: Number.isInteger(version) ? version : null,
    rows, ...(rows === null ? { estimatedRows: finite(s.rows) } : {}),
    previewComplete: complete,
    totals: complete ? totals : null,
    durationMs: finite(s.analyzed ? (s.planningMs ?? 0) + (s.executionMs ?? 0) : null),
  };
}
