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
import { recordResult, readState, scheduleState, appendTrend, trendPoint, runRows, clearPendingTrend, reconcileSlot, hasTrendPoint, pendingTrends } from './store.js';
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
// A lost trend point (dropped or replaced before it could be appended)
// counts too: it is reported once and cannot be repaired.
export const persistenceFailed = r => ['failed', 'unknown', 'lost'].includes(r?.persistence?.trend) || ['failed', 'unknown'].includes(r?.persistence?.state)
  || (r?.persistence?.trendLost?.length ?? 0) > 0;

export class ScheduleRunner {
  // config: loadConfig() result. home: AUSPEX_HOME folder files (stateFile,
  // trendsDir). db, notifyFn, now: injectable for tests.
  // persist: replacements for the local state and trend writes (tests inject
  // faults at each boundary); the defaults are those of ./store.js.
  constructor(config, { stateFile, trendsDir, notifyMode = 'all', notifyLanguage = 'en', db, notifyFn = defaultNotify, audit, now = () => new Date(), persist = {} }) {
    this.persist = { appendTrend, recordResult, clearPendingTrend, reconcileSlot, hasTrendPoint, readState, ...persist };
    this.repairNotes = [];
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
  // (reconcile; the repairs are in this.repairs). A slot with evidence of a
  // finished run (a pending trend point, a trend point, a saved run) is never
  // returned, even when its repair failed: the repair is retried next time,
  // the SQL never runs again. A state file that cannot be read throws (it is
  // never replaced).
  due(schedules) {
    const now = this.now();
    const enabled = schedules.filter(s => s.enabled).map(s => ({ schedule: s, slot: latestDueSlot(s.cadence, now) }));
    const { repairs, finished } = this.reconcile(enabled);
    this.repairs = repairs;
    const state = this.persist.readState(this.stateFile, { strict: true });
    return enabled.filter(({ schedule, slot }) => slot && scheduleState(state, schedule.id)?.lastSuccessSlot !== slot.key
      && !finished.has(`${schedule.id}\n${slot.key}`));
  }

  // Repairs, per schedule, without running the report again:
  // - pendingTrends: the trend points of finished runs whose write failed are
  //   appended in slot order (appendTrend ignores a slot that has a point).
  // - a due slot without a recorded success whose trend point exists, or
  //   whose run the approved report saved (run.schedule = { id, slot }): the
  //   state write of a finished run failed. The slot is recorded as
  //   successful first, with the point rebuilt from the saved result pending
  //   (trend 'lost' when the saved result was replaced meanwhile), then the
  //   point is appended.
  // Returns { repairs: [run()-shaped results], finished: Set of "id\nslot" }.
  reconcile(enabled) {
    const state = this.persist.readState(this.stateFile, { strict: true });
    const repairs = [];
    const finished = new Set();
    for (const { schedule, slot } of enabled) {
      const own = scheduleState(state, schedule.id);
      const label = refLabel(schedule.report);
      const pending = pendingTrends(own);
      // Every pending slot finished its run: none of them runs again, also
      // those after a failing repair below.
      for (const p of pending) finished.add(`${schedule.id}\n${p.slot}`);
      for (const p of pending) {
        const step = this.repairStep(schedule, label, p.slot, 'trend', () => this.appendPending(schedule, p));
        repairs.push(step);
        if (step.persistence.trend === 'failed') break; // keep the slot order; the rest waits
      }
      if (!slot || own?.lastSuccessSlot === slot.key || pending.some(p => p.slot === slot.key)) continue;
      const repaired = this.reconcileSlotFromSaved(schedule, label, slot);
      if (repaired) {
        finished.add(`${schedule.id}\n${slot.key}`);
        repairs.push(repaired);
      }
    }
    return { repairs, finished };
  }

  // Appends one pending point, then drops it from the state. Each boundary
  // reports its own outcome.
  appendPending(schedule, p) {
    try {
      this.persist.appendTrend(this.trendsDir, schedule.report, p.point);
    } catch (err) {
      return { trend: 'failed', state: 'not-attempted', error: persistenceError(err) };
    }
    try {
      this.persist.clearPendingTrend(this.stateFile, schedule.id, p.slot, this.now().toISOString());
    } catch (err) {
      return { trend: 'ok', state: 'failed', error: persistenceError(err) };
    }
    return { trend: 'ok', state: 'ok' };
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
        try {
          this.persist.reconcileSlot(this.stateFile, schedule.id, slot.key, this.now().toISOString());
        } catch (err) {
          return { trend: 'ok', state: 'failed', error: persistenceError(err) };
        }
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
      let point = null;
      if (last) {
        const complete = last.previewExecuted === true && last.previewTruncated === false;
        const totals = complete ? columnTotals(last.columns || [], last.preview || [], last.maskedColumns || []) : null;
        point = trendPoint({
          scheduleId: schedule.id, slot: slot.key, ranAt: run.at, preset: run.preset ?? null, params: run.params ?? null,
          last, sqlHash: run.sqlHash, version: run.version, totals,
        });
      }
      let lost = [];
      try {
        const saved = this.persist.reconcileSlot(this.stateFile, schedule.id, slot.key, this.now().toISOString(),
          { trend: point ? 'ok' : 'lost', ...(point ? { pendingTrend: { slot: slot.key, point } } : {}) });
        lost = saved?.lostPendingSlots ?? [];
      } catch (err) {
        return { trend: 'not-attempted', state: 'failed', error: persistenceError(err) };
      }
      // Pending points of older slots dropped by the bound, like run().
      const withLost = r => (lost.length ? { ...r, trendLost: lost } : r);
      if (!point) return withLost({ trend: 'lost', state: 'ok' });
      return withLost(this.appendPending(schedule, { slot: slot.key, point }));
    });
  }

  // One repair; never throws. A failed repair is retried by the next run-due;
  // failures (and a lost point) are notified in failures mode too (code only).
  repairStep(schedule, label, slotKey, repaired, fn) {
    let persistence;
    try {
      persistence = fn();
    } catch (err) {
      persistence = { trend: 'unknown', state: 'unknown', error: persistenceError(err) };
    }
    this.audit({
      source: actor, actor, tool: 'schedule_repair', scheduleId: schedule.id, slot: slotKey, profile: schedule.profile, report: label,
      repaired, trend: persistence.trend, state: persistence.state, ...(persistence.trendLost ? { trendLost: persistence.trendLost } : {}),
      ...(persistence.error ? { errorCode: persistence.error.code } : {}),
    });
    const result = { id: schedule.id, slot: slotKey, status: 'ok', repaired, persistence, report: label };
    if (persistenceFailed(result) && this.notifyMode !== 'off') {
      const lostPoint = persistence.trend === 'lost' || (persistence.trendLost?.length ?? 0) > 0;
      this.repairNotes.push({
        reportTitle: schedule.report.name, status: 'ok', errorCode: null, persistenceError: persistence.error?.code ?? 'TREND_LOST',
        ...(lostPoint ? { trendLost: true } : {}),
      });
    }
    return result;
  }

  // Sends the notifications of failed repairs (after due()); never throws.
  async notifyRepairs() {
    const notes = this.repairNotes.splice(0);
    if (this.notifyMode !== 'all' && this.notifyMode !== 'failures') return;
    for (const note of notes) {
      try { await this.notifyFn(note, { language: this.notifyLanguage }); } catch { /* never fatal */ }
    }
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
      const saved = this.persist.recordResult(this.stateFile, schedule.id, record, { pendingTrend });
      if (saved?.lostPendingSlots?.length) persistence.trendLost = saved.lostPendingSlots;
    } catch (err) {
      // The run itself stands; the next run-due reconciles the slot from its
      // trend point or the report's saved run.
      persistence.state = 'failed';
      persistence.error ??= persistenceError(err);
    }
    const persistenceFailed = persistence.trend === 'failed' || persistence.state === 'failed' || !!persistence.trendLost;
    const trendError = persistenceFailed ? persistence.error?.code ?? 'TREND_LOST' : null;
    this.audit({
      source: actor, actor, tool: 'schedule_run', correlationId, scheduleId: schedule.id, slot: record.slot, ...(manual ? { manual: true } : {}),
      profile: schedule.profile, report: label, status, ms: Date.now() - started, ...(errorCode ? { errorCode, error: message } : {}),
      persistence: { trend: persistence.trend, state: persistence.state }, ...(trendError ? { trendError } : {}),
    });
    // A successful run carries its row count; an empty result and a failed
    // local write are notified in "failures" mode too.
    const note = {
      reportTitle: title, status, errorCode, ...(counts ? { rows: counts.rows, estimatedRows: counts.estimatedRows } : {}),
      ...(persistenceFailed ? { persistenceError: trendError } : {}),
      ...(persistence.trendLost ? { trendLost: true } : {}),
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
