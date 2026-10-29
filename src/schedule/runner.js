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
import { recordResult, readState, scheduleState, appendTrend, trendPoint, runRows, clearPendingTrend, reconcileSlot, hasTrendPoint } from './store.js';
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

// Code and a short message of a local write failure (errno or class only).
function persistenceError(err) {
  const { code } = classifyError(err);
  return { code, message: err?.code ? `${err.code}${err.syscall ? ` (${err.syscall})` : ''}` : String(err?.message ?? err).slice(0, 300) };
}

// A run or repair result that left a local write failed.
export const persistenceFailed = r => r?.persistence?.trend === 'failed' || r?.persistence?.state === 'failed';

export class ScheduleRunner {
  // config: loadConfig() result. home: AUSPEX_HOME folder files (stateFile,
  // trendsDir). db, notifyFn, now: injectable for tests.
  // persist: replacements for the local state and trend writes (tests inject
  // faults at each boundary); the defaults are those of ./store.js.
  constructor(config, { stateFile, trendsDir, notifyMode = 'all', notifyLanguage = 'en', db, notifyFn = defaultNotify, audit, now = () => new Date(), persist = {} }) {
    this.persist = { appendTrend, recordResult, clearPendingTrend, reconcileSlot, hasTrendPoint, readState, ...persist };
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

  // Schedules whose latest due slot has no successful run yet. Before that,
  // finished work whose local writes failed is repaired without running SQL
  // (reconcile); the repairs are in this.repairs. A state file that cannot be
  // read throws (it is never replaced).
  due(schedules) {
    const now = this.now();
    const enabled = schedules.filter(s => s.enabled).map(s => ({ schedule: s, slot: latestDueSlot(s.cadence, now) }));
    this.repairs = this.reconcile(enabled);
    const state = this.persist.readState(this.stateFile, { strict: true });
    return enabled.filter(({ schedule, slot }) => slot && scheduleState(state, schedule.id)?.lastSuccessSlot !== slot.key);
  }

  // Repairs, per schedule, without running the report again:
  // - pendingTrend: the trend point of a finished run whose write failed is
  //   appended (once; appendTrend ignores a slot that already has a point).
  // - a due slot without a recorded success whose trend point exists, or
  //   whose run the approved report saved (run.schedule = { id, slot }): the
  //   state write of a finished run failed. The slot is recorded as
  //   successful; a missing trend point is rebuilt from the saved result
  //   when it is still the report's last result (trend 'lost' otherwise).
  // Returns one result per repair, shaped like run() results.
  reconcile(enabled) {
    const state = this.persist.readState(this.stateFile, { strict: true });
    const out = [];
    for (const { schedule, slot } of enabled) {
      const own = scheduleState(state, schedule.id);
      const label = refLabel(schedule.report);
      const pending = own?.pendingTrend;
      if (pending?.slot && pending.point) {
        out.push(this.repairStep(schedule, label, pending.slot, 'trend', () => {
          this.persist.appendTrend(this.trendsDir, schedule.report, pending.point);
          this.persist.clearPendingTrend(this.stateFile, schedule.id, pending.slot, this.now().toISOString());
          return { trend: 'ok', state: 'ok' };
        }));
      }
      if (!slot || own?.lastSuccessSlot === slot.key || pending?.slot === slot.key) continue;
      const repaired = this.reconcileSlotFromSaved(schedule, label, slot);
      if (repaired) out.push(repaired);
    }
    return out;
  }

  reconcileSlotFromSaved(schedule, label, slot) {
    let pointExists;
    try {
      pointExists = this.persist.hasTrendPoint(this.trendsDir, schedule.report, schedule.id, slot.key);
    } catch {
      pointExists = false;
    }
    if (pointExists) {
      return this.repairStep(schedule, label, slot.key, 'state', () => {
        this.persist.reconcileSlot(this.stateFile, schedule.id, slot.key, this.now().toISOString());
        return { trend: 'ok', state: 'ok' };
      });
    }
    let meta = null;
    try {
      meta = this.reports.library.exists('approved', schedule.report) ? this.reports.library.readMeta('approved', schedule.report) : null;
    } catch { /* no saved run to go by: the slot runs */ }
    const run = (meta?.runs ?? []).findLast(r => r?.schedule?.id === schedule.id && r.schedule.slot === slot.key);
    if (!run) return null;
    return this.repairStep(schedule, label, slot.key, 'state', () => {
      const last = meta.last?.at === run.at ? meta.last : null;
      if (last) {
        const complete = last.previewExecuted === true && last.previewTruncated === false;
        const totals = complete ? columnTotals(last.columns || [], last.preview || [], last.maskedColumns || []) : null;
        this.persist.appendTrend(this.trendsDir, schedule.report, trendPoint({
          scheduleId: schedule.id, slot: slot.key, ranAt: run.at, preset: run.preset ?? null, params: run.params ?? null,
          last, sqlHash: run.sqlHash, version: run.version, totals,
        }));
      }
      this.persist.reconcileSlot(this.stateFile, schedule.id, slot.key, this.now().toISOString(), { trend: last ? 'ok' : 'lost' });
      return { trend: last ? 'ok' : 'lost', state: 'ok' };
    });
  }

  // One repair; never throws. A failed repair is retried by the next run-due.
  repairStep(schedule, label, slotKey, repaired, fn) {
    let persistence;
    try {
      persistence = fn();
    } catch (err) {
      persistence = { trend: repaired === 'trend' ? 'failed' : 'unknown', state: 'failed', error: persistenceError(err) };
    }
    this.audit({
      source: actor, actor, tool: 'schedule_repair', scheduleId: schedule.id, slot: slotKey, profile: schedule.profile, report: label,
      repaired, trend: persistence.trend, state: persistence.state, ...(persistence.error ? { errorCode: persistence.error.code } : {}),
    });
    return { id: schedule.id, slot: slotKey, status: 'ok', repaired, persistence, report: label };
  }

  // Runs one schedule. slot: the due slot ({ key, at, day }) whose own
  // calendar day (day, else at) the preset is resolved against, or null for a
  // manual run (resolved against now). at can be a day later inside a
  // daylight saving gap across midnight; day never is.
  // Returns { id, slot, status, report, persistence, errorCode?, message?,
  // trendError? }; never throws. status is the report execution;
  // persistence = { trend: 'ok' | 'failed' | 'skipped', state: 'ok' |
  // 'failed', error?: { code, message } } the local writes after it
  // (trend 'skipped': a manual or unsuccessful run adds no point).
  // trendError (the first persistence error code) is kept for older callers.
  // The messages go to the caller and the audit log only, never into a
  // notification or the state file the viewer reads.
  async run(schedule, slot) {
    const started = Date.now();
    const correlationId = crypto.randomUUID();
    const manual = !slot;
    const label = refLabel(schedule.report);
    const at = () => this.now().toISOString();
    let title = schedule.report.name;
    let status, errorCode = null, message = null, counts = null, pendingTrend = null;
    const persistence = { trend: 'skipped', state: 'ok' };
    const presetDate = slot ? slot.day ?? slot.at : this.now();
    try {
      const check = checkSchedule(this.reports.library, schedule, presetDate);
      title = check.title;
      if (check.problem) throw new ToolError(check.code, check.problem);
      const result = await this.db.withCorrelation(correlationId, () => this.reports.run(schedule.report, {
        stage: 'approved', includeLast: true, presetDate, ...(schedule.preset !== null ? { preset: schedule.preset } : {}),
        // The saved run names its schedule slot, so a failed state write can
        // be reconciled from it without running the report again.
        ...(manual ? {} : { schedule: { id: schedule.id, slot: slot.key } }),
      }));
      status = 'ok';
      counts = runRows(result.last ?? null);
      if (!manual) {
        let point = null;
        try {
          // The result this run stored, not meta.last re-read from disk: a
          // concurrent run_report may have replaced that meanwhile.
          const last = result.last ?? null;
          const complete = last?.previewExecuted === true && last?.previewTruncated === false;
          const totals = complete ? columnTotals(last.columns || [], last.preview || [], last.maskedColumns || []) : null;
          point = trendPoint({
            scheduleId: schedule.id, slot: slot.key, ranAt: last?.at ?? at(), preset: result.preset ?? null, params: result.params ?? null,
            last, sqlHash: result.sqlHash, version: result.version, totals,
          });
          this.persist.appendTrend(this.trendsDir, schedule.report, point);
          persistence.trend = 'ok';
        } catch (err) {
          persistence.trend = 'failed';
          persistence.error ??= persistenceError(err);
          // Kept in the state, so the next run-due appends it without SQL.
          if (point) pendingTrend = { slot: slot.key, point };
        }
      }
    } catch (err) {
      errorCode = classifyError(err).code;
      message = String(err?.message ?? err);
      status = isUnreachable(err) ? 'skipped-unreachable' : 'failed';
    }
    const record = {
      status, slot: slot?.key ?? null, at: at(), ...(errorCode ? { errorCode } : {}), ...(manual ? { manual: true } : {}),
      ...(persistence.trend === 'failed' ? { persistenceError: persistence.error.code } : {}),
    };
    try {
      this.persist.recordResult(this.stateFile, schedule.id, record, { pendingTrend });
    } catch (err) {
      // The run itself stands; the next run-due reconciles the slot from its
      // trend point or the report's saved run.
      persistence.state = 'failed';
      persistence.error ??= persistenceError(err);
    }
    const persistenceFailed = persistence.trend === 'failed' || persistence.state === 'failed';
    const trendError = persistenceFailed ? persistence.error.code : null;
    this.audit({
      source: actor, actor, tool: 'schedule_run', correlationId, scheduleId: schedule.id, slot: record.slot, ...(manual ? { manual: true } : {}),
      profile: schedule.profile, report: label, status, ms: Date.now() - started, ...(errorCode ? { errorCode, error: message } : {}),
      persistence: { trend: persistence.trend, state: persistence.state }, ...(trendError ? { trendError } : {}),
    });
    // A successful run carries its row count; an empty result and a failed
    // local write are notified in "failures" mode too.
    const note = {
      reportTitle: title, status, errorCode, ...(counts ? { rows: counts.rows, estimatedRows: counts.estimatedRows } : {}),
      ...(persistenceFailed ? { persistenceError: persistence.error.code } : {}),
    };
    if (this.notifyMode === 'all' || (this.notifyMode === 'failures' && (status !== 'ok' || isEmptyResult(note) || persistenceFailed))) {
      try { await this.notifyFn(note, { language: this.notifyLanguage }); } catch { /* never fatal */ }
    }
    return { id: schedule.id, slot: record.slot, status, persistence, ...(errorCode ? { errorCode, message } : {}), ...(trendError ? { trendError } : {}), report: label };
  }

  async close() {
    await this.db.close?.();
  }
}
