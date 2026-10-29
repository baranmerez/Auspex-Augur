#!/usr/bin/env node
// Scheduled report runs (docs/reports.md: Scheduled runs). Schedules live in
// <AUSPEX_HOME or ~/.auspex>/schedules.json, edited by the user.
//   node src/scheduleCli.js run-due        run every schedule whose latest due
//                                          slot has no successful run yet
//   node src/scheduleCli.js run --id <id>  run one schedule now (manual)
//   node src/scheduleCli.js status         schedules, last result, next slot
//   node src/scheduleCli.js task-command   print the Windows Task Scheduler
//                                          registration for the user to run
// Runs go through the read-only run_report path (src/schedule/runner.js),
// audited with source and actor "scheduler". Auspex never registers or
// changes a scheduled task itself; task-command only prints the command.
//
// Exit codes: 0 every run succeeded (or nothing was due), 1 at least one run
// was skipped (database unreachable) or failed, 2 usage or configuration
// error, 3 another scheduler run is in progress.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, auspexHome, readNotesLanguage, defaultProfilesFile } from './config.js';
import { Library, refLabel } from './reports/library.js';
import { loadSchedules, schedulesFile, nextSlot, cadenceText, taskTimeOf, parseTime } from './schedule/config.js';
import { stateFile, trendsDir, readState, scheduleState } from './schedule/store.js';
import { ScheduleRunner, checkSchedule, persistenceFailed } from './schedule/runner.js';
import { notify, notificationLanguages } from './schedule/notify.js';
import { acquireFileLock, LockBusyError } from './fileLock.js';

export const auspexRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const taskName = 'Auspex scheduled reports';
export const retryMinutes = 30;

const usage = 'Usage: scheduleCli.js run-due | run --id <id> | status | task-command, each with optional --home <absolute AUSPEX_HOME folder>';

// One scheduler at a time: the cross-process lock of src/fileLock.js (token,
// takeover marker, dead-owner takeover), held for the whole run. A run may
// last up to the task's 2 h execution limit, so a lock is reclaimable only
// after runLockMaxHoldMs, even when its pid looks alive (a pid reused after a
// reboot). A lock still held past the task limit is reported once per
// attempt with a notification instead of failing silently.
export const taskLimitMs = 2 * 60 * 60 * 1000;
export const runLockMaxHoldMs = 3 * 60 * 60 * 1000;

function lockAgeMs(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return null; }
}

function acquireRunLock(file, waitMs = 2000) {
  try {
    return acquireFileLock(file, { waitMs, maxHoldMs: runLockMaxHoldMs });
  } catch (err) {
    if (err instanceof LockBusyError) return null;
    throw err;
  }
}

// PowerShell single-quoted string.
const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;

// "HH:MM" plus minutes, wrapped around midnight.
function addMinutes(time, minutes) {
  const { hour, minute } = parseTime(time, 'time');
  const total = (hour * 60 + minute + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// The PowerShell commands that register the daily task (printed, never run).
// Restart on failure once after 30 minutes; Task Scheduler applies that
// setting when the task cannot start, so a second daily trigger 30 minutes
// later retries an unreachable database as well: run-due is a no-op for
// slots that already succeeded.
// home: the AUSPEX_HOME of this shell, passed to the task as --home because a
// scheduled task does not inherit it. notes: comment lines (never values).
export function taskCommand({ time, nodePath = process.execPath, root = auspexRoot, home = null, notes = [] }) {
  const retry = addMinutes(time, retryMinutes);
  const script = path.join(root, 'src', 'scheduleCli.js');
  const args = `"${script}" run-due${home ? ` --home "${home}"` : ''}`;
  return [
    `# Registers the Windows task "${taskName}" for the current user. Review it, then run it yourself in PowerShell.`,
    `# Run task-command again and re-register the task after changing schedule times or taskTime (task time: ${time}).`,
    ...notes.map(n => `# ${n}`),
    `$action = New-ScheduledTaskAction -Execute ${psQuote(nodePath)} -Argument ${psQuote(args)} -WorkingDirectory ${psQuote(root)}`,
    `$triggers = @((New-ScheduledTaskTrigger -Daily -At ${psQuote(time)}), (New-ScheduledTaskTrigger -Daily -At ${psQuote(retry)}))`,
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes ${retryMinutes}) -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew`,
    `Register-ScheduledTask -TaskName ${psQuote(taskName)} -Description ${psQuote('Runs due Auspex report schedules (read-only).')} -Action $action -Trigger $triggers -Settings $settings`,
    '',
    '# Remove it again with:',
    `# Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -Confirm:$false`,
  ].join('\n');
}

function parseIdArgs(args) {
  let id;
  for (let i = 0; i < args.length; i++) {
    const m = /^--id(?:=(.*))?$/.exec(args[i]);
    if (!m || id !== undefined) throw new Error(usage);
    id = m[1] ?? args[++i];
  }
  if (!id) throw new Error(usage);
  return id;
}

// Language of the notifications: "language" in schedules.json, else the
// notesLanguage of the profiles file when a notification language matches it
// (pt-BR -> pt), else English. Never fails: a broken file means English.
export function notificationLanguage(loaded, env) {
  if (loaded?.language) return loaded.language;
  try {
    const notes = readNotesLanguage(env.AUSPEX_PROFILES_FILE || defaultProfilesFile(env));
    const base = String(notes ?? '').toLowerCase().split('-')[0];
    return notificationLanguages.includes(base) ? base : 'en';
  } catch {
    return 'en';
  }
}

function home(env) {
  return { stateFile: stateFile(env), trendsDir: trendsDir(env), lockFile: path.join(auspexHome(env), 'scheduler.lock') };
}

async function runSchedules(pick, loaded, config, env, deps) {
  const h = home(env);
  const release = acquireRunLock(h.lockFile, deps.lockWaitMs);
  if (!release) {
    const age = lockAgeMs(h.lockFile);
    const stuck = age !== null && age > taskLimitMs;
    if (stuck) await (deps.notifyFn ?? notify)({ reportTitle: 'scheduler lock', status: 'failed', errorCode: 'LOCK_BUSY' }, { language: notificationLanguage(loaded, env) });
    const message = stuck
      ? `The scheduler lock ${h.lockFile} has been held for ${Math.round(age / 60000)} minutes, longer than the task limit; it is taken over after ${runLockMaxHoldMs / 3600000} h. Check for a hung scheduler process.`
      : 'Another scheduler run is in progress.';
    return { status: 3, out: { ok: false, code: 'BUSY', message } };
  }
  const runner = new ScheduleRunner(config, { stateFile: h.stateFile, trendsDir: h.trendsDir, notifyMode: loaded.notify, notifyLanguage: notificationLanguage(loaded, env), ...deps });
  try {
    // A state file that cannot be read stops the run before any SQL; it is
    // never replaced (a missing file is a fresh installation).
    try {
      readState(h.stateFile, { strict: true });
    } catch (err) {
      return { status: 1, out: { ok: false, code: 'STATE_UNREADABLE', file: h.stateFile, message: err.message } };
    }
    const results = [];
    const picked = pick(runner);
    await runner.notifyRepairs?.();
    for (const { schedule, slot } of picked) results.push(await runner.run(schedule, slot));
    const repairs = runner.repairs ?? [];
    // Failed when a report run failed or a local write (trend, state) after
    // it failed; the report result itself stays as it was.
    const bad = results.some(r => r.status !== 'ok' || persistenceFailed(r)) || repairs.some(persistenceFailed);
    return { status: bad ? 1 : 0, out: { ok: !bad, ran: results.length, results, ...(repairs.length ? { repairs } : {}) } };
  } finally {
    await runner.close();
    release();
  }
}

// Enabled schedules due later in the day than the daily task: the task runs
// them only the next day (or at its 30-minute retry).
export function lateScheduleWarnings(loaded) {
  const taskTime = taskTimeOf(loaded);
  return loaded.schedules.filter(s => s.enabled && s.cadence.at > taskTime)
    .map(s => `Schedule "${s.id}" is due at ${s.cadence.at}, later than the task time ${taskTime}: the daily task runs it only the next day. Set "taskTime" in schedules.json to ${s.cadence.at} or later, run task-command again and re-register the task.`);
}

function statusOut(loaded, config, env, now) {
  const state = readState(home(env).stateFile);
  let stateError = null;
  try { readState(home(env).stateFile, { strict: true }); } catch (err) { stateError = err.message; }
  const lib = new Library(config.libraryDir);
  return {
    ok: true, file: loaded.file, missing: loaded.missing, notify: loaded.notify, language: notificationLanguage(loaded, env), taskTime: taskTimeOf(loaded),
    warnings: lateScheduleWarnings(loaded), ...(stateError ? { stateError } : {}),
    schedules: loaded.schedules.map(s => {
      const own = scheduleState(state, s.id);
      const check = checkSchedule(lib, s, now);
      return {
        id: s.id, enabled: s.enabled, profile: s.profile, report: refLabel(s.report), title: check.title, preset: s.preset,
        cadence: cadenceText(s.cadence), problem: check.problem,
        profileKnown: config.profiles.has(s.profile),
        last: own?.last ?? null, lastSuccessSlot: own?.lastSuccessSlot ?? null,
        next: s.enabled ? nextSlot(s.cadence, now)?.key ?? null : null,
      };
    }),
  };
}

// deps (tests): db, notifyFn, now for the runner; lockWaitMs for the run lock.
// --home <dir> anywhere after the command: the AUSPEX_HOME for this run (the
// printed task passes it, since a task does not inherit the shell's).
function splitHome(args) {
  const rest = [];
  let home;
  for (let i = 0; i < args.length; i++) {
    const m = /^--home(?:=(.*))?$/.exec(args[i]);
    if (!m) { rest.push(args[i]); continue; }
    if (home !== undefined) throw new Error('--home given twice');
    home = m[1] ?? args[++i];
    if (typeof home !== 'string' || !path.isAbsolute(home) || /[\u0000-\u001f"]/.test(home)) throw new Error('--home needs an absolute folder path');
    if (!fs.statSync(home, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--home folder ${home} does not exist`);
  }
  return { rest, home };
}

// Comment lines for the printed task: settings of this shell the task will
// not see. Names only, never values (an AUSPEX_DB_* value is a connection string).
function envNotes(loaded, env) {
  const notes = [];
  let config = null;
  try { config = loadConfig(env); } catch { /* reported by status and run-due */ }
  const fromEnv = [...new Set(loaded.schedules.filter(s => config?.profileInfo.get(s.profile)?.source === 'env').map(s => s.profile))];
  if (fromEnv.length) {
    notes.push(`Profile(s) ${fromEnv.join(', ')} come from AUSPEX_DB_* variables of this shell, which the task does not inherit: put them into profiles.json (passwords stay in pgpass) or set them as user environment variables.`);
  }
  const other = Object.keys(env).filter(k => /^AUSPEX_/i.test(k) && !/^AUSPEX_(HOME|DB_.*)$/i.test(k)).sort();
  if (other.length) notes.push(`The task does not inherit ${other.join(', ')} from this shell; set them as user environment variables if the scheduler needs them.`);
  return notes;
}

export async function main(argv, env = process.env, deps = {}) {
  const command = argv[0];
  if (!['run-due', 'run', 'status', 'task-command'].includes(command ?? '')) return { status: 2, out: { ok: false, code: 'INVALID_INPUT', message: usage } };
  let args;
  try {
    const split = splitHome(argv.slice(1));
    args = split.rest;
    if (split.home) env = { ...env, AUSPEX_HOME: split.home };
  } catch (err) {
    return { status: 2, out: { ok: false, code: 'INVALID_INPUT', message: err.message } };
  }
  let loaded, config;
  try {
    loaded = loadSchedules(schedulesFile(env));
    if (command === 'task-command') {
      const home = env.AUSPEX_HOME ? path.resolve(env.AUSPEX_HOME) : null;
      return { status: 0, text: taskCommand({ time: taskTimeOf(loaded), nodePath: deps.nodePath ?? process.execPath, home, notes: [...lateScheduleWarnings(loaded), ...envNotes(loaded, env)] }) };
    }
    config = loadConfig(env);
  } catch (err) {
    const out = { ok: false, code: err.errorCode ?? 'INVALID_INPUT', message: err.message };
    // An unattended run-due must not fail silently on a broken file.
    if (command === 'run-due') await (deps.notifyFn ?? notify)({ reportTitle: 'schedules.json', status: 'failed', errorCode: out.code }, { language: notificationLanguage(loaded, env) });
    return { status: 2, out };
  }
  const now = deps.now ?? (() => new Date());
  if (command === 'status') return { status: 0, out: statusOut(loaded, config, env, now()) };
  if (command === 'run-due') return runSchedules(runner => runner.due(loaded.schedules), loaded, config, env, { ...deps, now });
  let id;
  try { id = parseIdArgs(args); } catch (err) { return { status: 2, out: { ok: false, code: 'INVALID_INPUT', message: err.message } }; }
  const schedule = loaded.schedules.find(s => s.id === id);
  if (!schedule) return { status: 2, out: { ok: false, code: 'NOT_FOUND', message: `No schedule "${id}" in ${loaded.file}.` } };
  return runSchedules(() => [{ schedule, slot: null }], loaded, config, env, { ...deps, now });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { status, out, text } = await main(process.argv.slice(2), process.env);
  process.stdout.write(text !== undefined ? `${text}\n` : `${JSON.stringify(out, null, 1)}\n`);
  process.exitCode = status;
}
