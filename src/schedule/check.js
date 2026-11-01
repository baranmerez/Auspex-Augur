// Problems of a schedule that need no database, for the runner, the schedule
// CLI and the viewers' Schedules screen: the report must be approved, and its
// preset must resolve for the approved SQL (built-in presets only with
// dateRange: true). Files only: no database, no network, nothing is written.
import { sqlParamCount, resolvePreset } from '../reports/presets.js';
import { ToolError } from '../errors.js';

// Returns { title, problem, code, target } (problem and code null when
// runnable). target names the kind of problem for a screen: draft (only a
// draft exists), missing (no approved report), metadata (approved report
// without metadata), preset (the preset is missing or does not resolve), or
// ok. Messages name the preset and parameter counts, never parameter values.
export function checkSchedule(library, schedule, now = new Date()) {
  const ref = schedule.report;
  if (!library.exists('approved', ref)) {
    const draft = library.exists('draft', ref);
    return { title: ref.name, problem: draft ? 'The report is a draft; only approved reports can be scheduled.' : 'The report was not found among approved reports.', code: draft ? 'PRECONDITION_FAILED' : 'NOT_FOUND', target: draft ? 'draft' : 'missing' };
  }
  const meta = library.readMeta('approved', ref);
  const title = meta?.title || ref.name;
  if (!meta) return { title, problem: 'The report metadata is missing.', code: 'NOT_FOUND', target: 'metadata' };
  const paramCount = sqlParamCount(library.readSql('approved', ref));
  if (schedule.preset === null) {
    return paramCount > 0
      ? { title, problem: `The report SQL takes ${paramCount} parameter(s); set "preset" to a built-in preset (dateRange reports) or a custom preset.`, code: 'PRECONDITION_FAILED', target: 'preset' }
      : { title, problem: null, code: null, target: 'ok' };
  }
  try {
    resolvePreset(schedule.preset, meta.presets, paramCount, msg => new ToolError('PRECONDITION_FAILED', msg), now, meta.dateRange);
  } catch (err) {
    return { title, problem: err.message, code: 'PRECONDITION_FAILED', target: 'preset' };
  }
  return { title, problem: null, code: null, target: 'ok' };
}
