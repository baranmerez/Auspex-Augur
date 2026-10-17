#!/usr/bin/env node
// Scheduled report runs (README: Scheduled runs). Schedules live in
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
import { loadConfig, auspexHome } from './config.js';
import { Library, refLabel } from './reports/library.js';
import { loadSchedules, schedulesFile, nextSlot, cadenceText, taskTimeOf, parseTime } from './schedule/config.js';
import { stateFile, trendsDir, readState, scheduleState } from './schedule/store.js';
import { ScheduleRunner, checkSchedule } from './schedule/runner.js';
import { notify } from './schedule/notify.js';
import { acquireFileLock, LockBusyError } from './fileLock.js';

export const auspexRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const taskName = 'Auspex scheduled reports';
export const retryMinutes = 30;

const usage = 'Usage: scheduleCli.js run-due | run --id <id> | status | task-command';

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
export function taskCommand({ time, nodePath = process.execPath, root = auspexRoot }) {
  const retry = addMinutes(time, retryMinutes);
  const script = path.join(root, 'src', 'scheduleCli.js');
  return [
    `# Registers the Windows task "${taskName}" for the current user. Review it, then run it yourself in PowerShell.`,
    `$action = New-ScheduledTaskAction -Execute ${psQuote(nodePath)} -Argument ${psQuote(`"${script}" run-due`)} -WorkingDirectory ${psQuote(root)}`,
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

function home(env) {
  return { stateFile: stateFile(env), trendsDir: trendsDir(env), lockFile: path.join(auspexHome(env), 'scheduler.lock') };
}

async function runSchedules(pick, loaded, config, env, deps) {
  const h = home(env);
  const release = acquireRunLock(h.lockFile, deps.lockWaitMs);
  if (!release) {
    const age = lockAgeMs(h.lockFile);
    const stuck = age !== null && age > taskLimitMs;
    if (stuck) await (deps.notifyFn ?? notify)({ reportTitle: 'scheduler lock', status: 'failed', errorCode: 'LOCK_BUSY' });
    const message = stuck
      ? `The scheduler lock ${h.lockFile} has been held for ${Math.round(age / 60000)} minutes, longer than the task limit; it is taken over after ${runLockMaxHoldMs / 3600000} h. Check for a hung scheduler process.`
      : 'Another scheduler run is in progress.';
    return { status: 3, out: { ok: false, code: 'BUSY', message } };
  }
  const runner = new ScheduleRunner(config, { stateFile: h.stateFile, trendsDir: h.trendsDir, notifyMode: loaded.notify, ...deps });
  try {
    const results = [];
    for (const { schedule, slot } of pick(runner)) results.push(await runner.run(schedule, slot));
    const bad = results.some(r => r.status !== 'ok');
    return { status: bad ? 1 : 0, out: { ok: !bad, ran: results.length, results } };
  } finally {
    await runner.close();
    release();
  }
}

function statusOut(loaded, config, env, now) {
  const state = readState(home(env).stateFile);
  const lib = new Library(config.libraryDir);
  return {
    ok: true, file: loaded.file, missing: loaded.missing, notify: loaded.notify, taskTime: taskTimeOf(loaded),
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
export async function main(argv, env = process.env, deps = {}) {
  const command = argv[0];
  if (!['run-due', 'run', 'status', 'task-command'].includes(command ?? '')) return { status: 2, out: { ok: false, code: 'INVALID_INPUT', message: usage } };
  let loaded, config;
  try {
    loaded = loadSchedules(schedulesFile(env));
    if (command === 'task-command') {
      return { status: 0, text: taskCommand({ time: taskTimeOf(loaded), nodePath: deps.nodePath ?? process.execPath }) };
    }
    config = loadConfig(env);
  } catch (err) {
    const out = { ok: false, code: err.errorCode ?? 'INVALID_INPUT', message: err.message };
    // An unattended run-due must not fail silently on a broken file.
    if (command === 'run-due') await (deps.notifyFn ?? notify)({ reportTitle: 'schedules.json', status: 'failed', errorCode: out.code });
    return { status: 2, out };
  }
  const now = deps.now ?? (() => new Date());
  if (command === 'status') return { status: 0, out: statusOut(loaded, config, env, now()) };
  if (command === 'run-due') return runSchedules(runner => runner.due(loaded.schedules), loaded, config, env, { ...deps, now });
  let id;
  try { id = parseIdArgs(argv.slice(1)); } catch (err) { return { status: 2, out: { ok: false, code: 'INVALID_INPUT', message: err.message } }; }
  const schedule = loaded.schedules.find(s => s.id === id);
  if (!schedule) return { status: 2, out: { ok: false, code: 'NOT_FOUND', message: `No schedule "${id}" in ${loaded.file}.` } };
  return runSchedules(() => [{ schedule, slot: null }], loaded, config, env, { ...deps, now });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { status, out, text } = await main(process.argv.slice(2), process.env);
  process.stdout.write(text !== undefined ? `${text}\n` : `${JSON.stringify(out, null, 1)}\n`);
  process.exitCode = status;
}
