// Parameter presets for library reports.
// Built-in presets are relative date ranges for reports saved with
// dateRange: true, whose SQL takes exactly two parameters, $1 = start
// (inclusive) and $2 = end (exclusive). They resolve when the report runs to
// ISO dates (YYYY-MM-DD); day boundaries are computed in the local time zone
// of the machine Auspex runs on. Compared with a timestamptz column, such a
// date is read in the database session time zone, so compare with $1::date /
// $2::date or a date column. Calendar arithmetic only (no millisecond
// offsets), so daylight saving changes cannot shift a day.
// Custom presets are named parameter sets stored in the report metadata
// (meta.presets: [{ name, params }]).
import { stripLiteralsAndComments } from '../sqlGuard.js';

export const builtInPresetKeys = ['today', 'yesterday', 'last_7_days', 'this_month', 'last_month', 'this_year', 'last_year'];
export const builtInParamCount = 2;
export const maxPresetName = 60;
export const maxPresets = 50;

const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// new Date(y, m, d) normalizes overflowing months and days in local time.
const day = (y, m, d) => isoDay(new Date(y, m, d));

// [start, end) for a built-in key at the moment now, or null for an unknown key.
// last_7_days covers the last seven calendar days including today.
export function resolveBuiltInPreset(key, now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (key) {
    case 'today': return [day(y, m, d), day(y, m, d + 1)];
    case 'yesterday': return [day(y, m, d - 1), day(y, m, d)];
    case 'last_7_days': return [day(y, m, d - 6), day(y, m, d + 1)];
    case 'this_month': return [day(y, m, 1), day(y, m + 1, 1)];
    case 'last_month': return [day(y, m - 1, 1), day(y, m, 1)];
    case 'this_year': return [day(y, 0, 1), day(y + 1, 0, 1)];
    case 'last_year': return [day(y - 1, 0, 1), day(y, 0, 1)];
    default: return null;
  }
}

// Number of parameters the SQL uses: the highest $n outside literals,
// quoted identifiers and comments (PostgreSQL numbers them from $1).
export function sqlParamCount(sql) {
  let masked;
  try { masked = stripLiteralsAndComments(String(sql ?? '')); } catch { return 0; }
  let max = 0;
  for (const m of masked.matchAll(/(?<![A-Za-z0-9_$])\$(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

// Built-in keys a report offers: only when it was saved with dateRange: true
// and its SQL takes exactly two parameters.
export const builtInPresetsFor = (paramCount, dateRange) => (dateRange === true && paramCount === builtInParamCount ? builtInPresetKeys : []);

// Checks the dateRange flag of save_report against the SQL; throws fail(message).
export function checkDateRange(dateRange, paramCount, fail) {
  if (dateRange === undefined) return undefined;
  if (typeof dateRange !== 'boolean') throw fail('dateRange must be true or false.');
  if (dateRange && paramCount !== builtInParamCount) {
    throw fail(`dateRange: true needs SQL with exactly ${builtInParamCount} parameters ($1 start inclusive, $2 end exclusive); this SQL uses ${paramCount}.`);
  }
  return dateRange;
}

const isParamValue = v => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const nameKey = name => name.normalize('NFC').toLocaleLowerCase('en');

// Checks and normalizes custom presets for SQL with paramCount parameters.
// Returns [{ name, params }] or throws fail(message).
export function validatePresets(presets, paramCount, fail) {
  if (!Array.isArray(presets)) throw fail('presets must be an array.');
  if (presets.length > maxPresets) throw fail(`At most ${maxPresets} presets per report.`);
  const seen = new Set();
  return presets.map((p, i) => {
    const label = `Preset ${i + 1}`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw fail(`${label} must be an object { name, params }.`);
    const name = String(p.name ?? '').normalize('NFC').trim();
    if (!name || name.length > maxPresetName) throw fail(`${label}: name must be 1-${maxPresetName} characters.`);
    if (/[\u0000-\u001f\u007f]/.test(name)) throw fail(`${label}: name must not contain control characters.`);
    if (builtInPresetKeys.includes(nameKey(name))) throw fail(`${label}: "${name}" is a built-in preset name; choose another name.`);
    if (seen.has(nameKey(name))) throw fail(`${label}: the name "${name}" is used twice (names are compared case-insensitively).`);
    seen.add(nameKey(name));
    if (!Array.isArray(p.params)) throw fail(`${label} ("${name}"): params must be an array.`);
    if (p.params.length !== paramCount) throw fail(`${label} ("${name}"): params has ${p.params.length} value(s), but the SQL uses ${paramCount} parameter(s).`);
    if (!p.params.every(isParamValue)) throw fail(`${label} ("${name}"): params may only hold strings, numbers, booleans or null.`);
    return { name, params: [...p.params] };
  });
}

// Custom preset found by name (case-insensitive), or undefined.
export const findCustomPreset = (presets, name) => (presets || []).find(p => nameKey(p.name) === nameKey(String(name ?? '').trim()));

// The parameter values for a run with preset (a built-in key or a custom name)
// against SQL with paramCount parameters: { preset, params, builtIn }, or throws fail(message).
export function resolvePreset(name, presets, paramCount, fail, now = new Date(), dateRange = false) {
  const key = String(name ?? '').trim();
  if (builtInPresetKeys.includes(key)) {
    if (dateRange !== true) {
      throw fail(`Built-in preset "${key}" is not available: this report has no date-range parameters; save it with dateRange: true when $1 and $2 are a [start, end) date range.`);
    }
    if (paramCount !== builtInParamCount) {
      throw fail(`Built-in preset "${key}" needs SQL with exactly ${builtInParamCount} parameters ($1 start inclusive, $2 end exclusive); this report uses ${paramCount}. Pass params or a custom preset.`);
    }
    return { preset: key, params: resolveBuiltInPreset(key, now), builtIn: true };
  }
  const custom = findCustomPreset(presets, key);
  if (!custom) {
    const names = [...builtInPresetsFor(paramCount, dateRange), ...(presets || []).map(p => p.name)];
    throw fail(`Unknown preset "${key}". Available: ${names.length ? names.join(', ') : 'none'}.`);
  }
  if (custom.params.length !== paramCount) {
    throw fail(`Preset "${custom.name}" has ${custom.params.length} value(s), but the current SQL uses ${paramCount} parameter(s); save the report with updated presets.`);
  }
  return { preset: custom.name, params: [...custom.params], builtIn: false };
}

// Names of stored presets that no longer fit SQL with paramCount parameters.
export const mismatchedPresets = (presets, paramCount) => (presets || []).filter(p => p.params?.length !== paramCount).map(p => p.name);
