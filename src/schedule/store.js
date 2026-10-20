// Local files of the scheduler under <AUSPEX_HOME or ~/.auspex>:
//   schedule-state.json   last result per schedule id (the viewer shows it)
//   trends/<profile>/<schema>/<category...>/<name>.jsonl
//                         one aggregate point per successful scheduled run
// Read-modify-write runs under a cross-process file lock and files are
// replaced atomically, so the viewer never reads half a file. Aggregates only:
// a trend point holds counts and column totals, never row values.
import fs from 'node:fs';
import path from 'node:path';
import { auspexHome } from '../config.js';
import { normalizeRef } from '../reports/library.js';
import { withFileLock } from '../fileLock.js';
import { writePrivateAtomic } from '../privateFiles.js';

export const scheduleStatuses = ['ok', 'skipped-unreachable', 'failed'];
export const maxTrendPoints = 520; // ten years of weekly points, ~1.4 years of daily points
export const maxHistory = 20;
export const trendFormat = 1;

export const stateFile = (env = process.env) => path.join(auspexHome(env), 'schedule-state.json');
export const trendsDir = (env = process.env) => path.join(auspexHome(env), 'trends');

// { schedules: { [id]: { last, lastSuccessSlot, history } } }; an unreadable
// or missing file reads as empty (the next run writes a fresh one).
export function readState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data === 'object' && data.schedules && typeof data.schedules === 'object' && !Array.isArray(data.schedules)) return data;
  } catch { /* missing or broken: start empty */ }
  return { schedules: {} };
}

// Records one result: { status, slot (null for a manual run), at, errorCode?, manual? }.
// A successful slot run sets lastSuccessSlot, which makes run-due skip that slot.
export function recordResult(file, id, result) {
  return withFileLock(`${file}.lock`, () => {
    const state = readState(file);
    const own = Object.hasOwn(state.schedules, id) ? state.schedules[id] : {};
    const entry = { ...own, last: result, history: [...(Array.isArray(own.history) ? own.history : []), result].slice(-maxHistory) };
    if (result.status === 'ok' && result.slot) entry.lastSuccessSlot = result.slot;
    const schedules = Object.assign(Object.create(null), state.schedules, { [id]: entry });
    writePrivateAtomic(file, `${JSON.stringify({ updatedAt: result.at, schedules }, null, 2)}\n`);
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

// Appends one point and keeps the newest maxPoints. The point is built by
// trendPoint, so it holds aggregates only.
export function appendTrend(root, ref, point, { maxPoints = maxTrendPoints } = {}) {
  const file = trendFile(root, ref);
  return withFileLock(`${file}.lock`, () => {
    const points = [...readTrend(file), point].slice(-maxPoints);
    writePrivateAtomic(file, points.map(p => JSON.stringify(p)).join('\n') + '\n');
    return { file, points: points.length };
  });
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
