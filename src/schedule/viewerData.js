// Schedule and trend data for the report list, shared by the browser viewer
// (src/viewer.js) and the desktop app (through src/stageCli.js), so both show
// the same schedules, last results, next slots and trend points. Files only:
// no database, no network, nothing is written.
import { loadSchedules, schedulesFile, nextSlot, cadenceText } from './config.js';
import { stateFile, trendsDir, readState, scheduleState, trendFile, readTrend, pendingTrends } from './store.js';

// Schedules of approved reports (schedules.json) with their last result and
// next slot, keyed like the report list: db|schema|category|name. A broken
// schedules file is reported, not fatal.
export const scheduleKey = r => [r.db, r.schema, r.category, r.name].join('|');

// Only codes, counts and slot keys leave the state file: an error code is an
// upper-case word, a slot key a date (and time); anything else is dropped.
const codeOf = v => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(v) ? v : null);
const slotKeys = list => (Array.isArray(list) ? list : []).filter(s => typeof s === 'string' && /^\d{4}-\d{2}(-\d{2})?(T\d{2}:\d{2})?$/.test(s));

// Each item carries, besides the last result, how the local saving went:
// last.persistenceError (the run finished but its trend point or the state
// could not be saved), last.trendLost (the point of that slot is gone),
// pendingTrends/pendingSlots (points waiting for the next run-due to save
// them), trendLostSlots (points dropped for good) and stateUnreadable (the
// state file exists but cannot be read strictly; the lenient read then shows
// no last result). The strict read only reads; nothing is written.
export function scheduleIndex({ now = new Date(), env = process.env } = {}) {
  let loaded;
  try {
    loaded = loadSchedules(schedulesFile(env));
  } catch (err) {
    return { error: err.message, byReport: new Map() };
  }
  let state, stateUnreadable = false;
  try {
    state = readState(stateFile(env), { strict: true });
  } catch {
    stateUnreadable = true;
    state = readState(stateFile(env));
  }
  const byReport = new Map();
  for (const s of loaded.schedules) {
    const own = scheduleState(state, s.id);
    const last = own?.last && typeof own.last === 'object' ? own.last : null;
    const pending = slotKeys(pendingTrends(own).map(p => p.slot));
    const lost = slotKeys(own?.trendLostSlots);
    const item = {
      id: s.id, enabled: s.enabled, cadence: cadenceText(s.cadence), preset: s.preset,
      next: s.enabled ? nextSlot(s.cadence, now)?.key ?? null : null,
      last: last ? {
        status: last.status, slot: last.slot ?? null, at: last.at ?? null, ...(last.errorCode ? { errorCode: last.errorCode } : {}), ...(last.manual ? { manual: true } : {}),
        ...(codeOf(last.persistenceError) ? { persistenceError: codeOf(last.persistenceError) } : {}),
        ...(last.trendLost === true ? { trendLost: true } : {}),
      } : null,
      ...(pending.length ? { pendingTrends: pending.length, pendingSlots: pending } : {}),
      ...(lost.length ? { trendLostSlots: lost } : {}),
      ...(stateUnreadable ? { stateUnreadable: true } : {}),
    };
    const key = scheduleKey(s.report);
    byReport.set(key, [...(byReport.get(key) || []), item]);
  }
  return { error: null, byReport };
}

// Trend points of one report (aggregates only: slot, run time, preset, row
// count and column totals; parameter values are left out). The db segment is
// the profile; trendFile validates every segment and throws on a bad one.
export const trendFields = ['slot', 'ranAt', 'preset', 'rows', 'estimatedRows', 'previewComplete', 'totals', 'version'];

export function reportTrend(ref, { env = process.env } = {}) {
  const points = readTrend(trendFile(trendsDir(env), ref)).map(p => Object.fromEntries(trendFields.filter(k => Object.hasOwn(p, k)).map(k => [k, p[k]])));
  return { points };
}
