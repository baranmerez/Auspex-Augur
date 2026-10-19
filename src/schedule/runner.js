// Runs schedules from schedules.json through the same read-only path as the
// MCP tool run_report: ReportService.run -> ReadOnlyDatabase.runReport
// (audited, SQL guard, READ ONLY transaction, role check, query budget,
// statement timeout), the run record and the regenerated report HTML. Every
// audit entry of a scheduled run carries source and actor "scheduler". The
// scheduler adds no database code of its own and never writes to a database;
// it writes only its local state, trend and audit files.
import crypto from 'node:crypto';
import { ReadOnlyDatabase } from '../db.js';
import { ReportService, approvedJoinPairs } from '../reports/service.js';
import { refLabel } from '../reports/library.js';
import { sqlParamCount, resolvePreset } from '../reports/presets.js';
import { columnTotals } from '../reports/totals.js';
import { SchemaMemory } from '../memory/store.js';
import { createAuditLog } from '../auditLog.js';
import { ToolError, classifyError } from '../errors.js';
import { latestDueSlot } from './config.js';
import { recordResult, readState, scheduleState, appendTrend, trendPoint, runRows } from './store.js';
import { notify as defaultNotify, isEmptyResult } from './notify.js';

export const actor = 'scheduler';

// Unreachable: the connection could not be made or dropped for network
// reasons (refused, timed out, DNS, host or network unreachable, e.g. a VPN
// that is down). A server answering with an error (authentication, starting
// up, any SQLSTATE) is a failure, not unreachable.
export function isUnreachable(err) {
  const c = classifyError(err);
  return c.code === 'CONNECTION_FAILED' && c.retryable === true && !c.sqlState;
}

// A database whose every audit entry carries actor "scheduler".
export function schedulerDatabase(config, { audit } = {}) {
  const base = audit ?? createAuditLog(config.logDir);
  return new ReadOnlyDatabase(config, { source: actor, audit: entry => base({ ...entry, actor }) });
}

// Problems that need no database: the report must be approved, and its preset
// must resolve for the approved SQL (built-in presets only with dateRange:
// true). Returns { title, problem } (problem null when runnable).
export function checkSchedule(library, schedule, now = new Date()) {
  const ref = schedule.report;
  if (!library.exists('approved', ref)) {
    const draft = library.exists('draft', ref);
    return { title: ref.name, problem: draft ? 'The report is a draft; only approved reports can be scheduled.' : 'The report was not found among approved reports.', code: draft ? 'PRECONDITION_FAILED' : 'NOT_FOUND' };
  }
  const meta = library.readMeta('approved', ref);
  const title = meta?.title || ref.name;
  if (!meta) return { title, problem: 'The report metadata is missing.', code: 'NOT_FOUND' };
  const paramCount = sqlParamCount(library.readSql('approved', ref));
  if (schedule.preset === null) {
    return paramCount > 0
      ? { title, problem: `The report SQL takes ${paramCount} parameter(s); set "preset" to a built-in preset (dateRange reports) or a custom preset.`, code: 'PRECONDITION_FAILED' }
      : { title, problem: null };
  }
  try {
    resolvePreset(schedule.preset, meta.presets, paramCount, msg => new ToolError('PRECONDITION_FAILED', msg), now, meta.dateRange);
  } catch (err) {
    return { title, problem: err.message, code: 'PRECONDITION_FAILED' };
  }
  return { title, problem: null };
}

export class ScheduleRunner {
  // config: loadConfig() result. home: AUSPEX_HOME folder files (stateFile,
  // trendsDir). db, notifyFn, now: injectable for tests.
  constructor(config, { stateFile, trendsDir, notifyMode = 'all', notifyLanguage = 'en', db, notifyFn = defaultNotify, audit, now = () => new Date() }) {
    this.config = config;
    this.stateFile = stateFile;
    this.trendsDir = trendsDir;
    this.notifyMode = notifyMode;
    this.notifyLanguage = notifyLanguage;
    this.audit = audit ?? createAuditLog(config.logDir);
    this.db = db ?? schedulerDatabase(config, { audit: this.audit });
    this.notifyFn = notifyFn;
    this.now = now;
    this.memory = new SchemaMemory(config.memoryDir, { approvedJoins: profile => approvedJoinPairs(this.reports.library, profile) });
    this.reports = new ReportService(this.db, config.libraryDir, this.memory, { scriptRoots: config.scriptRoots });
  }

  // Schedules whose latest due slot has no successful run yet.
  due(schedules) {
    const now = this.now();
    const state = readState(this.stateFile);
    return schedules.filter(s => s.enabled).map(s => ({ schedule: s, slot: latestDueSlot(s.cadence, now) }))
      .filter(({ schedule, slot }) => slot && scheduleState(state, schedule.id)?.lastSuccessSlot !== slot.key);
  }

  // Runs one schedule. slot: the due slot ({ key, at }) whose date the preset
  // is resolved against, or null for a manual run (resolved against now).
  // Returns { id, slot, status, report, errorCode?, message?, trendError? };
  // never throws. The message goes to the caller and the audit log only, never
  // into a notification or the state file the viewer reads.
  async run(schedule, slot) {
    const started = Date.now();
    const correlationId = crypto.randomUUID();
    const manual = !slot;
    const label = refLabel(schedule.report);
    const at = () => this.now().toISOString();
    let title = schedule.report.name;
    let status, errorCode = null, trendError = null, message = null, counts = null;
    try {
      const check = checkSchedule(this.reports.library, schedule, slot ? slot.at : this.now());
      title = check.title;
      if (check.problem) throw new ToolError(check.code, check.problem);
      const result = await this.db.withCorrelation(correlationId, () => this.reports.run(schedule.report, {
        stage: 'approved', includeLast: true, presetDate: slot ? slot.at : this.now(), ...(schedule.preset !== null ? { preset: schedule.preset } : {}),
      }));
      status = 'ok';
      counts = runRows(result.last ?? null);
      if (!manual) {
        try {
          // The result this run stored, not meta.last re-read from disk: a
          // concurrent run_report may have replaced that meanwhile.
          const last = result.last ?? null;
          const complete = last?.previewExecuted === true && last?.previewTruncated === false;
          const totals = complete ? columnTotals(last.columns || [], last.preview || [], last.maskedColumns || []) : null;
          appendTrend(this.trendsDir, schedule.report, trendPoint({
            scheduleId: schedule.id, slot: slot.key, ranAt: at(), preset: result.preset ?? null, params: result.params ?? null,
            last, sqlHash: result.sqlHash, version: result.version, totals,
          }));
        } catch (err) {
          trendError = classifyError(err).code;
        }
      }
    } catch (err) {
      errorCode = classifyError(err).code;
      message = String(err?.message ?? err);
      status = isUnreachable(err) ? 'skipped-unreachable' : 'failed';
    }
    const record = { status, slot: slot?.key ?? null, at: at(), ...(errorCode ? { errorCode } : {}), ...(manual ? { manual: true } : {}) };
    try {
      recordResult(this.stateFile, schedule.id, record);
    } catch (err) {
      trendError ??= classifyError(err).code; // reported, the run itself stands
    }
    this.audit({
      source: actor, actor, tool: 'schedule_run', correlationId, scheduleId: schedule.id, slot: record.slot, ...(manual ? { manual: true } : {}),
      profile: schedule.profile, report: label, status, ms: Date.now() - started, ...(errorCode ? { errorCode, error: message } : {}), ...(trendError ? { trendError } : {}),
    });
    // A successful run carries its row count; an empty result is notified in
    // "failures" mode too, as it usually means a wrong period or missing data.
    const note = { reportTitle: title, status, errorCode, ...(counts ? { rows: counts.rows, estimatedRows: counts.estimatedRows } : {}) };
    if (this.notifyMode === 'all' || (this.notifyMode === 'failures' && (status !== 'ok' || isEmptyResult(note)))) {
      try { await this.notifyFn(note, { language: this.notifyLanguage }); } catch { /* never fatal */ }
    }
    return { id: schedule.id, slot: record.slot, status, ...(errorCode ? { errorCode, message } : {}), ...(trendError ? { trendError } : {}), report: label };
  }

  async close() {
    await this.db.close?.();
  }
}
