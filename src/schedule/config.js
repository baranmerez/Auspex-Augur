// Scheduled report runs: the user-edited <AUSPEX_HOME or ~/.auspex>/schedules.json
// and the due-slot arithmetic. Files only: no database, no network.
//
// {
//   "taskTime": "08:05",            optional: time of the one daily Windows task
//   "notify": "all",                optional: all (default), failures or none
//   "schedules": [
//     { "id": "weekly-example", "profile": "exampledb",
//       "report": { "db": "exampledb", "schema": "example", "category": "Orders/Delivery", "name": "example-report" },
//       "preset": "last_7_days",
//       "cadence": { "weekly": "monday", "at": "08:00" } },
//     { "id": "daily-example", ..., "cadence": { "daily": true, "at": "07:30" } }
//   ]
// }
//
// Validation is strict: unknown keys, a missing profile, a profile other than
// the report's db segment, a duplicate id or a malformed cadence reject the
// whole file, so a typo never silently drops a schedule. Times are local
// wall-clock times of the machine the scheduler runs on. Slots are computed
// with calendar arithmetic (new Date(y, m, d, h, min)), never by adding
// milliseconds, so a daylight saving change cannot move a slot to another day.
import fs from 'node:fs';
import path from 'node:path';
import { auspexHome } from '../config.js';
import { normalizeRef } from '../reports/library.js';
import { ToolError } from '../errors.js';

export const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const notifyModes = ['all', 'failures', 'none'];
export const maxSchedules = 200;
const idPattern = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const profilePattern = /^[a-z][a-z0-9_-]{0,39}$/;
const timePattern = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const presetMax = 60;

export const schedulesFile = (env = process.env) => path.join(auspexHome(env), 'schedules.json');

const fail = message => new ToolError('INVALID_INPUT', message);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw fail(`${where}: unknown key "${String(k).slice(0, 40)}" (allowed: ${allowed.join(', ')}).`);
}

// "HH:MM" -> { hour, minute }.
export function parseTime(value, where) {
  const m = typeof value === 'string' ? timePattern.exec(value) : null;
  if (!m) throw fail(`${where} must be a 24-hour local time "HH:MM", e.g. "08:00".`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function validateCadence(c, where) {
  if (!isObject(c)) throw fail(`${where} must be an object, e.g. { "weekly": "monday", "at": "08:00" } or { "daily": true, "at": "08:00" }.`);
  const weekly = Object.hasOwn(c, 'weekly'), daily = Object.hasOwn(c, 'daily');
  if (weekly === daily) throw fail(`${where} needs exactly one of "weekly" or "daily".`);
  onlyKeys(c, [weekly ? 'weekly' : 'daily', 'at'], where);
  const time = parseTime(c.at, `${where}.at`);
  if (daily) {
    if (c.daily !== true) throw fail(`${where}.daily must be true.`);
    return { daily: true, at: c.at, ...time };
  }
  const day = typeof c.weekly === 'string' ? c.weekly.trim().toLowerCase() : '';
  if (!weekdays.includes(day)) throw fail(`${where}.weekly must be a weekday name in English (${weekdays.join(', ')}).`);
  return { weekly: day, weekday: weekdays.indexOf(day), at: c.at, ...time };
}

function validateEntry(s, i, ids) {
  const where = `schedules[${i}]`;
  if (!isObject(s)) throw fail(`${where} must be an object.`);
  onlyKeys(s, ['id', 'profile', 'report', 'preset', 'cadence', 'enabled'], where);
  if (typeof s.id !== 'string' || !idPattern.test(s.id)) throw fail(`${where}.id must be 1-60 characters a-z, 0-9, - or _, starting with a letter or digit.`);
  if (ids.has(s.id)) throw fail(`${where}: the id "${s.id}" is used twice.`);
  ids.add(s.id);
  const label = `schedule "${s.id}"`;
  // No default profile: every schedule names the database it runs on.
  if (typeof s.profile !== 'string' || !s.profile.trim()) throw fail(`${label}: "profile" is required (there is no default profile).`);
  const profile = s.profile.trim().toLowerCase();
  if (!profilePattern.test(profile)) throw fail(`${label}: "profile" is not a valid profile name.`);
  if (!isObject(s.report)) throw fail(`${label}: "report" must be an object { db, schema, category, name }.`);
  onlyKeys(s.report, ['db', 'schema', 'category', 'name'], `${label}.report`);
  let report;
  try {
    report = normalizeRef(s.report);
  } catch (err) {
    throw fail(`${label}.report: ${err.message}`);
  }
  if (report.name !== s.report.name) throw fail(`${label}.report.name must be the library name "${report.name}" exactly as list_reports shows it.`);
  if (report.db !== profile) throw fail(`${label}: "profile" (${profile}) must be the report's db (${report.db}); a report runs on the database it was saved for.`);
  let preset = null;
  if (s.preset !== undefined) {
    if (typeof s.preset !== 'string' || !s.preset.trim() || s.preset.length > presetMax || /[\u0000-\u001f\u007f]/.test(s.preset)) {
      throw fail(`${label}: "preset" must be a built-in preset key or a custom preset name of the report (1-${presetMax} characters).`);
    }
    preset = s.preset.trim();
  }
  if (s.enabled !== undefined && typeof s.enabled !== 'boolean') throw fail(`${label}: "enabled" must be true or false.`);
  return { id: s.id, profile, report, preset, cadence: validateCadence(s.cadence, `${label}.cadence`), enabled: s.enabled !== false };
}

// Validates the parsed file content; returns { taskTime, notify, schedules }.
export function validateSchedules(data) {
  if (!isObject(data)) throw fail('schedules.json must be a JSON object with a "schedules" array.');
  onlyKeys(data, ['schedules', 'taskTime', 'notify'], 'schedules.json');
  if (!Array.isArray(data.schedules)) throw fail('schedules.json: "schedules" must be an array.');
  if (data.schedules.length > maxSchedules) throw fail(`schedules.json: at most ${maxSchedules} schedules.`);
  const ids = new Set();
  const schedules = data.schedules.map((s, i) => validateEntry(s, i, ids));
  if (data.taskTime !== undefined) parseTime(data.taskTime, 'schedules.json: "taskTime"');
  if (data.notify !== undefined && !notifyModes.includes(data.notify)) throw fail(`schedules.json: "notify" must be one of ${notifyModes.join(', ')}.`);
  return { taskTime: data.taskTime ?? null, notify: data.notify ?? 'all', schedules };
}

// The validated schedules file, or { missing: true, schedules: [] } when it
// does not exist. Any other problem throws, so a broken file is never ignored.
export function loadSchedules(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file, missing: true, taskTime: null, notify: 'all', schedules: [] };
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw fail(`${file} is not valid JSON: ${err.message}`);
  }
  return { file, missing: false, ...validateSchedules(data) };
}

const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The slot of a cadence on the local calendar day of date: { key, at }.
// key is the local date and time ("2026-10-12T08:00"), stable across daylight
// saving changes; at is the moment it falls due. A time inside a skipped
// spring-forward hour falls due at the first valid moment after it.
function slotOn(cadence, date) {
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), cadence.hour, cadence.minute);
  return { key: `${isoDay(date)}T${pad(cadence.hour)}:${pad(cadence.minute)}`, at };
}

const matchesDay = (cadence, date) => cadence.daily === true || date.getDay() === cadence.weekday;

// The most recent slot that is due at now (at <= now), or null.
export function latestDueSlot(cadence, now = new Date()) {
  for (let k = 0; k <= 8; k++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - k);
    if (!matchesDay(cadence, date)) continue;
    const slot = slotOn(cadence, date);
    if (slot.at <= now) return slot;
  }
  return null;
}

// The first slot after now.
export function nextSlot(cadence, now = new Date()) {
  for (let k = 0; k <= 8; k++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k);
    if (!matchesDay(cadence, date)) continue;
    const slot = slotOn(cadence, date);
    if (slot.at > now) return slot;
  }
  return null;
}

// Short human description of a cadence: "weekly monday 08:00", "daily 07:30".
export const cadenceText = c => (c.daily ? `daily ${c.at}` : `weekly ${c.weekly} ${c.at}`);

// Time of the one daily task: taskTime, else the latest "at" of the enabled
// schedules (every slot of the day is due when the task runs), else 08:00.
export function taskTimeOf(loaded) {
  if (loaded.taskTime) return loaded.taskTime;
  const times = loaded.schedules.filter(s => s.enabled).map(s => s.cadence.at).sort();
  return times.at(-1) ?? '08:00';
}
