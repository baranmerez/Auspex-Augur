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
import { refLabel, normalizeRef } from '../reports/library.js';
import { sqlParamCount, resolvePreset } from '../reports/presets.js';
import { columnTotals } from '../reports/totals.js';
import { SchemaMemory } from '../memory/store.js';
import { memoryAudit } from '../memory/repairAudit.js';
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
// Never the error's own message: a parse error can quote the file it read.
function persistenceError(err) {
  const { code } = classifyError(err);
  const errno = typeof err?.code === 'string' && /^E[A-Z0-9]+$/.test(err.code) ? err.code : null;
  const message = errno ? `${errno}${err.syscall ? ` (${err.syscall})` : ''}`
    : err instanceof SyntaxError ? 'a local file is not valid JSON' : 'a local file could not be read or written';
  return { code, message };
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
  // the SQL never runs again. A slot is also held back while the report
  // metadata (where every scheduled run is saved before its trend point)
  // cannot be read. A state file that cannot be read throws (it is never
  // replaced).
  due(schedules) {
    const now = this.now();
    const enabled = schedules.filter(s => s.enabled).map(s => ({ schedule: s, slot: latestDueSlot(s.cadence, now) }));
    const { repairs, finished } = this.reconcile(enabled);
    this.repairs = repairs;
    const state = this.persist.readState(this.stateFile, { strict: true });
    // Slot keys (YYYY-MM-DDTHH:MM) compare in time order: a slot at or before
    // the last success (e.g. after the schedule time was moved earlier) is done.
    return enabled.filter(({ schedule, slot }) => slot && slot.key > (scheduleState(state, schedule.id)?.lastSuccessSlot ?? '')
      && !finished.has(`${schedule.id}\n${slot.key}`));
  }

  // Repairs, per schedule, without running the report again:
  // - pendingTrends: the trend points of finished runs whose write failed are
  //   appended in slot order to the report they were taken from.
  // - slots after lastSuccessSlot that finished although their state write
  //   failed: the latest due slot, and every slot the approved report's saved
  //   runs name (run.schedule = { id, slot }), also older ones the scheduler
  //   moved past. Evidence is the slot's trend point or the saved run. The
  //   slot is recorded as successful (lastSuccessSlot never moves back), with
  //   the point rebuilt from the saved result pending when the result is
  //   still that run's (trend 'lost' otherwise), then the point is appended.
  // - evidence that cannot be read (trend file, report metadata): the slot is
  //   neither run nor recorded; the repair reports state 'unknown' and is
  //   retried next time.
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
        if (step.persistence.trend === 'failed' || step.persistence.trend === 'unknown') break; // keep the slot order; the rest waits
      }
      const pendingSlots = new Set(pending.map(p => p.slot));
      for (const step of this.reconcileFromSaved(schedule, label, own, slot, pendingSlots)) {
        finished.add(`${schedule.id}\n${step.slot}`);
        repairs.push(step);
        // An older slot whose state is not recorded yet: the newer due slot
        // waits until that repair succeeds (keeps the slots in order).
        if (slot && step.slot < slot.key && ['failed', 'unknown'].includes(step.persistence.state)) finished.add(`${schedule.id}\n${slot.key}`);
      }
    }
    return { repairs, finished };
  }

  // The report a pending point goes to: { target } with the one stored with
  // it, or for an entry of an earlier build (no report) the schedule's report
  // when that is verifiably the report the point was taken from (its SQL
  // version is in the report's history), else target null (lost).
  // { error } when that history cannot be read now: the entry is kept.
  pendingTarget(schedule, p) {
    if (p.report) return { target: p.report };
    let meta;
    try {
      meta = this.reports.library.readMeta('approved', schedule.report);
    } catch (err) {
      return { error: err };
    }
    return { target: p.point?.sqlHash && (meta?.sqlVersions ?? []).some(v => v.hash === p.point.sqlHash) ? schedule.report : null };
  }

  // Appends one pending point, then drops it from the state. Each boundary
  // reports its own outcome; a point without a verifiable report is dropped
  // as lost (never written into another report's trend).
  appendPending(schedule, p) {
    const { target, error } = this.pendingTarget(schedule, p);
    if (error) return { trend: 'unknown', state: 'not-attempted', error: persistenceError(error) };
    if (target) {
      try {
        this.persist.appendTrend(this.trendsDir, target, p.point);
      } catch (err) {
        return { trend: 'failed', state: 'not-attempted', error: persistenceError(err) };
      }
    }
    try {
      this.persist.clearPendingTrend(this.stateFile, schedule.id, p.slot, this.now().toISOString());
    } catch (err) {
      return { trend: target ? 'ok' : 'lost', state: 'failed', error: persistenceError(err) };
    }
    return target ? { trend: 'ok', state: 'ok' } : { trend: 'lost', state: 'ok', trendLost: [p.slot] };
  }

  // Repairs of finished slots after lastSuccessSlot (see reconcile).
  reconcileFromSaved(schedule, label, own, dueSlot, pendingSlots) {
    const after = own?.lastSuccessSlot ?? '';
    let meta = null;
    let metaError = null;
    try {
      meta = this.reports.library.exists('approved', schedule.report) ? this.reports.library.readMeta('approved', schedule.report) : null;
    } catch (err) {
      metaError = err;
    }
    const tagged = (meta?.runs ?? []).filter(r => r?.schedule?.id === schedule.id && typeof r.schedule.slot === 'string');
    const slots = new Set(tagged.map(r => r.schedule.slot).filter(k => k > after));
    if (dueSlot && dueSlot.key > after) slots.add(dueSlot.key);
    const out = [];
    for (const slotKey of [...slots].sort()) {
      if (pendingSlots.has(slotKey) || slotKey === own?.lastSuccessSlot) continue;
      let pointExists = false;
      let trendError = null;
      try {
        pointExists = this.persist.hasTrendPoint(this.trendsDir, schedule.report, schedule.id, slotKey);
      } catch (err) {
        trendError = err;
      }
      const run = tagged.findLast(r => r.schedule.slot === slotKey);
      if (pointExists) {
        out.push(this.repairStep(schedule, label, slotKey, 'state', () => this.recordReconciled(schedule, slotKey, 'ok')));
      } else if (run) {
        out.push(this.repairStep(schedule, label, slotKey, 'state', () => {
          const point = this.pointFromSaved(schedule, meta, run, slotKey);
          return this.recordReconciled(schedule, slotKey, point ? 'pending' : 'lost', point);
        }));
      } else if (metaError || (trendError && !meta)) {
        // Not known whether this slot ran (its saved run cannot be read):
        // neither run it nor record it. A readable metadata without a run
        // for the slot proves it did not finish (run() saves the run before
        // the trend point): the slot is due, even when the trend file
        // cannot be read.
        out.push(this.repairStep(schedule, label, slotKey, 'state', () => ({ trend: 'unknown', state: 'unknown', error: persistenceError(metaError ?? trendError) })));
      }
    }
    return out;
  }

  // The trend point of a saved scheduled run, rebuilt from meta.last only
  // when that result is unambiguously this run's (exactly one saved run has
  // its time, and it is the tagged one); null when it is not.
  pointFromSaved(schedule, meta, run, slotKey) {
    const last = meta.last;
    const sameTime = (meta.runs ?? []).filter(r => r?.at === last?.at);
    if (!last || sameTime.length !== 1 || sameTime[0] !== run) return null;
    const complete = last.previewExecuted === true && last.previewTruncated === false;
    const totals = complete ? columnTotals(last.columns || [], last.preview || [], last.maskedColumns || []) : null;
    return trendPoint({
      scheduleId: schedule.id, slot: slotKey, ranAt: run.at, preset: run.preset ?? null, params: run.params ?? null,
      last, sqlHash: run.sqlHash, version: run.version, totals,
    });
  }

  // Records a finished slot as successful. trend: 'ok' (its point exists),
  // 'pending' (point given: kept pending first, then appended) or 'lost'.
  recordReconciled(schedule, slotKey, trend, point = null) {
    const report = normalizeRef(schedule.report);
    let lost = [];
    try {
      const saved = this.persist.reconcileSlot(this.stateFile, schedule.id, slotKey, this.now().toISOString(),
        { trend: trend === 'lost' ? 'lost' : 'ok', ...(point ? { pendingTrend: { slot: slotKey, point, report } } : {}) });
      lost = saved?.lostPendingSlots ?? [];
    } catch (err) {
      return { trend: trend === 'ok' ? 'ok' : 'not-attempted', state: 'failed', error: persistenceError(err) };
    }
    // Pending points of older slots dropped by the bound, like run().
    const withLost = r => (lost.length ? { ...r, trendLost: [...(r.trendLost ?? []), ...lost] } : r);
    if (trend === 'ok') return withLost({ trend: 'ok', state: 'ok' });
    if (trend === 'lost') return withLost({ trend: 'lost', state: 'ok' });
    return withLost(this.appendPending(schedule, { slot: slotKey, point, report }));
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
      this.repairNotes.push({ scheduleId: schedule.id, title: schedule.report.name, slot: slotKey, code: persistence.error?.code ?? 'TREND_LOST', lostPoint });
    }
    return result;
  }

  // Sends the notifications of failed repairs (after due()): one per
  // schedule with the number of slots and their range (the per-slot details
  // are in the command output and the audit log); never throws.
  async notifyRepairs() {
    const items = this.repairNotes.splice(0);
    if (this.notifyMode !== 'all' && this.notifyMode !== 'failures') return;
    const bySchedule = new Map();
    for (const item of items) bySchedule.set(item.scheduleId, [...(bySchedule.get(item.scheduleId) ?? []), item]);
    for (const list of bySchedule.values()) {
      const slots = list.map(i => i.slot).sort();
      const note = {
        reportTitle: list[0].title, status: 'ok', errorCode: null, persistenceError: list.find(i => i.code !== 'TREND_LOST')?.code ?? 'TREND_LOST',
        ...(list.some(i => i.lostPoint) ? { trendLost: true } : {}),
        ...(list.length > 1 ? { repairSlots: { count: list.length, from: slots[0], to: slots.at(-1) } } : {}),
      };
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
    let status, errorCode = null, message = null, counts = null, pendingTrend = null, runResult = null;
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
      runResult = result;
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
          if (point) pendingTrend = { slot: slot.key, point, report: normalizeRef(schedule.report) };
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
      ...memoryAudit(runResult),
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
