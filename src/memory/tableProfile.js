// Table profile: a short prose description of one table (what it is for,
// what it does, where it is used, what it depends on, what to watch out
// for), kept per table in <memory>/<profile>/table-profiles/<schema>/<table>.json
// next to the table records (src/memory/store.js reads and writes it under
// the profile's memory lock). This module holds the pure parts: input
// checks, the input fingerprint and its freshness, and the tables a table
// cannot live without. Nothing here reads a database or a file.
//
// Record:
//   { schema, table, nextVersion,
//     current:  version | null   the profile as shown
//     proposal: version | null   an agent rewrite of a user-owned profile,
//                                waiting for the user to accept or reject it
//     history:  [version...]     replaced, rejected and superseded versions
//                                (newest last, at most historyLimit)
//     required: [{ schema, table, at }]  tables the user marked as required }
// version:
//   { version, author: 'agent' | 'user', confirmedAt?, at, language,
//     sections: { purpose, behavior, usage, dependencies, caveats },
//     sources: { <section>: [{ type, ref }] }, fingerprint, basedOn?, status? }
// A profile is user-owned once the user wrote it, confirmed it or accepted an
// agent proposal; an agent save never replaces a user-owned profile.
import crypto from 'node:crypto';
import { MemoryError, tableKey } from './store.js';

export const profileSections = ['purpose', 'behavior', 'usage', 'dependencies', 'caveats'];
export const sourceTypes = ['note', 'report', 'trigger', 'function', 'table', 'column', 'score', 'code', 'view'];
export const maxSectionChars = 4000;
export const maxProfileChars = 12000;
export const maxSourcesPerSection = 20;
export const maxSourceRef = 200;
export const profileHistoryLimit = 20;
export const maxRequiredMarks = 100;
const maxLanguage = 40;
const controlInLine = /[\u0000-\u001f\u007f-\u009f]/;
// Text keeps line breaks and tabs; other control characters are refused.
const controlInText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const maxName = 63;

const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 16);
const textOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function validName(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxName && !controlInLine.test(value);
}

// sections: every key of profileSections, each a string (may be empty, but
// not all of them), at most maxSectionChars each and maxProfileChars in all.
export function validateSections(sections) {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) throw new MemoryError('sections must be an object.');
  const extra = Object.keys(sections).filter(k => !profileSections.includes(k));
  if (extra.length) throw new MemoryError(`sections has unknown keys: ${extra.join(', ')}; use ${profileSections.join(', ')}.`);
  const out = {};
  let total = 0;
  for (const key of profileSections) {
    const value = sections[key] ?? '';
    if (typeof value !== 'string') throw new MemoryError(`sections.${key} must be a string.`);
    const text = value.replace(/\r\n?/g, '\n').trim();
    if (controlInText.test(text)) throw new MemoryError(`sections.${key} contains control characters.`);
    if (text.length > maxSectionChars) throw new MemoryError(`sections.${key} is longer than ${maxSectionChars} characters.`);
    total += text.length;
    out[key] = text;
  }
  if (!total) throw new MemoryError('The profile is empty; write at least one section.');
  if (total > maxProfileChars) throw new MemoryError(`The profile is longer than ${maxProfileChars} characters; keep it to about one page.`);
  return out;
}

// sources: per section a list of { type, ref } (ref one line); sections
// without sources may be left out.
export function validateSources(sources) {
  if (sources === undefined || sources === null) return Object.fromEntries(profileSections.map(k => [k, []]));
  if (typeof sources !== 'object' || Array.isArray(sources)) throw new MemoryError('sources must be an object keyed by section.');
  const extra = Object.keys(sources).filter(k => !profileSections.includes(k));
  if (extra.length) throw new MemoryError(`sources has unknown keys: ${extra.join(', ')}; use ${profileSections.join(', ')}.`);
  const out = {};
  for (const key of profileSections) {
    const list = sources[key] ?? [];
    if (!Array.isArray(list)) throw new MemoryError(`sources.${key} must be an array.`);
    if (list.length > maxSourcesPerSection) throw new MemoryError(`sources.${key} has more than ${maxSourcesPerSection} entries.`);
    const seen = new Set();
    out[key] = list.map((s, i) => {
      const where = `sources.${key}[${i}]`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new MemoryError(`${where} must be an object { type, ref }.`);
      const keys = Object.keys(s).filter(k => k !== 'type' && k !== 'ref');
      if (keys.length) throw new MemoryError(`${where} has unknown keys: ${keys.join(', ')}.`);
      if (!sourceTypes.includes(s.type)) throw new MemoryError(`${where}.type must be one of ${sourceTypes.join(', ')}.`);
      const ref = typeof s.ref === 'number' && Number.isSafeInteger(s.ref) ? String(s.ref) : s.ref;
      if (typeof ref !== 'string' || !ref.trim()) throw new MemoryError(`${where}.ref must be a non-empty string.`);
      if (ref.length > maxSourceRef || controlInLine.test(ref)) throw new MemoryError(`${where}.ref must be one line of at most ${maxSourceRef} characters.`);
      if (s.type === 'note' && !/^[1-9][0-9]{0,15}$/.test(ref.trim())) throw new MemoryError(`${where}.ref must be a note id for type note.`);
      const item = { type: s.type, ref: ref.trim() };
      const id = `${item.type}\n${item.ref}`;
      if (seen.has(id)) throw new MemoryError(`${where} is listed twice.`);
      seen.add(id);
      return item;
    });
  }
  return out;
}

export function validateLanguage(language) {
  if (language === undefined || language === null || language === '') return null;
  if (typeof language !== 'string' || language.length > maxLanguage || controlInLine.test(language)) throw new MemoryError(`language must be one line of at most ${maxLanguage} characters.`);
  return language.trim() || null;
}

// ---------- mentions in report SQL ----------
const nameChar = '[\\p{L}\\p{N}_$]';
const escapeRe = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripSql = sql => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/"/g, '');
// True when the SQL names schema.table, or the bare table name not after a
// dot (the same rule as the viewer's "mentioned in SQL").
export function sqlMentions(sql, schema, table) {
  if (typeof sql !== 'string' || !table) return false;
  const name = escapeRe(table), tail = `(?!${nameChar})`;
  const qualified = `(?<!${nameChar})${escapeRe(schema)}\\s*\\.\\s*${name}${tail}`;
  const bare = `(?<!${nameChar})(?<!\\.\\s*)${name}${tail}`;
  return new RegExp(`${qualified}|${bare}`, 'iu').test(stripSql(sql));
}

// ---------- fingerprint ----------
// What the profile is based on, as Auspex sees it in memory at save time:
//   structure  the recorded columns, constraints (with their definition and
//              referenced columns), indexes and triggers (null when
//              the table's structure is not recorded)
//   notes      [[id, kind, hash]] of the active notes on the table
//   triggers   hash of the agent's trigger summaries with the freshness of
//              each (summaryState) and the function definition it was
//              based on, so a summary that turns stale changes it
//   scores     hash of the effective column scores
//   reports    [[report key, SQL hash]] of draft and approved reports whose
//              SQL mentions the table (null when the library was not read)
//   reportsIncomplete  true when only part of the library was read (a cap
//              or an unreadable report); left out otherwise
export function profileInputs({ rec, notes, reports, reportsComplete = true, effectiveScore, summaryState = () => null }) {
  const described = !!rec?.describedAt;
  const structure = described ? hash({
    columns: (rec.columns ?? []).map(c => [c.name, c.type, !!c.notNull]),
    constraints: (rec.constraints ?? []).map(c => [c.name, c.type, c.columns ?? [], c.definition ?? null, c.references ? [tableKey(c.references.schema, c.references.table), c.references.columns ?? []] : null]),
    indexes: (rec.indexes ?? []).map(i => i.definition ?? i.name),
    triggers: (rec.triggers ?? []).map(t => [t.name, t.definition ?? null]),
  }) : null;
  const noteItems = (notes ?? []).map(n => [n.id, n.kind, hash(`${n.column ?? ''}\n${n.text}`)]).sort((a, b) => a[0] - b[0]);
  const summaries = Object.entries(rec?.triggerSummaries ?? {})
    .map(([name, s]) => [name, s?.summary ?? null, summaryState(name), s?.functionEvidence?.definitionHash ?? null])
    .sort((a, b) => textOrder(a[0], b[0]));
  const scores = Object.entries(rec?.columnScores ?? {}).map(([name, e]) => [name, effectiveScore(e)?.score ?? null]).sort((a, b) => textOrder(a[0], b[0]));
  const reportItems = reports === null ? null : reports.map(r => [r.key, r.sqlHash ?? null]).sort((a, b) => textOrder(a[0], b[0]));
  return {
    structure,
    notes: noteItems,
    triggers: summaries.length ? hash(summaries) : null,
    scores: scores.length ? hash(scores) : null,
    reports: reportItems,
    ...(reportItems !== null && reportsComplete === false ? { reportsIncomplete: true } : {}),
  };
}

export function fingerprintOf(inputs) {
  return { hash: hash(inputs), ...inputs };
}

// Freshness of a stored version against the inputs now:
//   { state: 'fresh' | 'stale' | 'unverified', reasons: [{ code, ... }] }
// stale codes: structure-changed, notes-added (kind, count), notes-removed
// (count), notes-changed (count), trigger-summaries-changed, scores-changed,
// reports-added / reports-removed / reports-changed (count).
// unverified codes: legacy (no fingerprint), structure-missing (written
// before the structure was recorded), table-missing (no longer in memory),
// reports-unknown (the report library could not be read then or now),
// reports-incomplete (only part of it could be read then or now).
// A detected change wins over a gap; missing evidence is never fresh.
export function profileFreshness(fp, now) {
  if (!fp || typeof fp !== 'object' || typeof fp.hash !== 'string') return { state: 'unverified', reasons: [{ code: 'legacy' }] };
  const stale = [], gaps = [];
  if (fp.structure === null || fp.structure === undefined) {
    if (now.structure !== null) gaps.push({ code: 'structure-missing' });
  } else if (now.structure === null) gaps.push({ code: 'table-missing' });
  else if (fp.structure !== now.structure) stale.push({ code: 'structure-changed' });
  const before = new Map((Array.isArray(fp.notes) ? fp.notes : []).map(([id, kind, h]) => [id, { kind, h }]));
  const after = new Map(now.notes.map(([id, kind, h]) => [id, { kind, h }]));
  const added = {};
  for (const [id, n] of after) if (!before.has(id)) added[n.kind] = (added[n.kind] ?? 0) + 1;
  for (const kind of Object.keys(added).sort()) stale.push({ code: 'notes-added', kind, count: added[kind] });
  const removed = [...before.keys()].filter(id => !after.has(id)).length;
  if (removed) stale.push({ code: 'notes-removed', count: removed });
  const changed = [...after].filter(([id, n]) => before.has(id) && (before.get(id).kind !== n.kind || before.get(id).h !== n.h)).length;
  if (changed) stale.push({ code: 'notes-changed', count: changed });
  if ((fp.triggers ?? null) !== now.triggers) stale.push({ code: 'trigger-summaries-changed' });
  if ((fp.scores ?? null) !== now.scores) stale.push({ code: 'scores-changed' });
  if (!Array.isArray(fp.reports) || now.reports === null) gaps.push({ code: 'reports-unknown' });
  else if (fp.reportsIncomplete || now.reportsIncomplete) gaps.push({ code: 'reports-incomplete' });
  else {
    const was = new Map(fp.reports.map(([k, h]) => [k, h]));
    const is = new Map(now.reports.map(([k, h]) => [k, h]));
    const count = pred => [...pred].length;
    const add = count([...is.keys()].filter(k => !was.has(k)));
    const gone = count([...was.keys()].filter(k => !is.has(k)));
    const edited = count([...is].filter(([k, h]) => was.has(k) && was.get(k) !== h));
    if (add) stale.push({ code: 'reports-added', count: add });
    if (gone) stale.push({ code: 'reports-removed', count: gone });
    if (edited) stale.push({ code: 'reports-changed', count: edited });
  }
  if (stale.length) return { state: 'stale', reasons: stale };
  if (gaps.length) return { state: 'unverified', reasons: gaps };
  return { state: 'fresh', reasons: [] };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// One English line for a freshness result ("2 new rules; structure changed").
export function freshnessText(reasons) {
  const text = r => {
    switch (r.code) {
      case 'structure-changed': return 'structure changed';
      case 'notes-added': return plural(r.count, `new ${r.kind}`, `new ${r.kind === 'inference' ? 'inferences' : `${r.kind}s`}`);
      case 'notes-removed': return plural(r.count, 'note archived', 'notes archived');
      case 'notes-changed': return plural(r.count, 'note changed', 'notes changed');
      case 'trigger-summaries-changed': return 'trigger summaries changed';
      case 'scores-changed': return 'column scores changed';
      case 'reports-added': return plural(r.count, 'new report', 'new reports');
      case 'reports-removed': return plural(r.count, 'report removed', 'reports removed');
      case 'reports-changed': return plural(r.count, 'report changed', 'reports changed');
      case 'legacy': return 'written before freshness was recorded';
      case 'structure-missing': return 'written before the structure was recorded';
      case 'table-missing': return 'the table is no longer in memory';
      case 'reports-unknown': return 'the report library could not be compared';
      case 'reports-incomplete': return 'not every report could be read';
      default: return r.code;
    }
  };
  return reasons.map(text).join('; ');
}

// ---------- tables a table cannot live without ----------
// The last name part in singular form as well ("status_codes" also reads
// "status_code"); only a plain English plural is undone, nothing else.
function nameForms(name) {
  const lower = name.toLowerCase();
  const parts = lower.split('_');
  const last = parts.at(-1);
  const singular = last.endsWith('ies') && last.length > 3 ? `${last.slice(0, -3)}y`
    : /(ses|xes|zes|ches|shes)$/.test(last) ? last.slice(0, -2)
      : last.endsWith('s') && !last.endsWith('ss') && last.length > 1 ? last.slice(0, -1) : last;
  return new Set([lower, [...parts.slice(0, -1), singular].join('_')]);
}

// A code column without a foreign key mapped to a known table by name parts:
// the column name, or the column name without its last part ("status_code"
// -> "status", "customer_id" -> "customer"), equals the table name or its
// singular. Only a single match counts; ties are no evidence.
export function nameMatches(column, tables) {
  const lower = column.toLowerCase();
  const parts = lower.split('_');
  const wanted = new Set([lower, ...(parts.length > 1 ? [parts.slice(0, -1).join('_')] : [])]);
  const hits = tables.filter(t => [...nameForms(t.table)].some(f => wanted.has(f)));
  return hits.length === 1 ? hits[0] : null;
}

// rec: the table record; tables: every table record in memory (for name
// matches); triggerReads(t) -> ['schema.table', ...] the tables the
// trigger's function reads (inferred from its stored body); marks: the
// user's required marks. Returns { required, optional }: required tables
// with their evidence (catalog: a foreign key whose columns are all NOT
// NULL; inference: a name match or a table read by a trigger function;
// user: the user's mark), and optional references (a foreign key with a
// nullable column, not required by other evidence).
export function requiredTables({ rec, tables, triggerReads, marks }) {
  const self = rec ? tableKey(rec.schema, rec.table) : null;
  const byId = new Map();
  const entry = (schema, table) => {
    const id = tableKey(schema, table);
    if (!byId.has(id)) byId.set(id, { id, schema, table, evidence: [] });
    return byId.get(id);
  };
  const optional = new Map();
  const described = !!rec?.describedAt;
  const notNull = new Set(described ? rec.columns.filter(c => c.notNull).map(c => c.name) : []);
  const fkColumns = new Set();
  for (const c of described ? rec.constraints.filter(c => c.references) : []) {
    for (const col of c.columns ?? []) fkColumns.add(col);
    const target = c.references;
    if (tableKey(target.schema, target.table) === self) continue;
    const columns = c.columns ?? [];
    if (columns.length && columns.every(col => notNull.has(col))) entry(target.schema, target.table).evidence.push({ type: 'catalog', constraint: c.name, columns });
    else {
      const id = tableKey(target.schema, target.table);
      if (!optional.has(id)) optional.set(id, { id, schema: target.schema, table: target.table, evidence: [] });
      optional.get(id).evidence.push({ type: 'catalog-nullable', constraint: c.name, columns });
    }
  }
  if (described) {
    const pk = new Set(rec.constraints.find(c => c.type === 'primary key')?.columns ?? []);
    const others = tables.filter(t => tableKey(t.schema, t.table) !== self);
    for (const c of rec.columns) {
      if (fkColumns.has(c.name) || pk.has(c.name)) continue;
      const hit = nameMatches(c.name, others);
      if (hit) entry(hit.schema, hit.table).evidence.push({ type: 'inference', basis: 'name', column: c.name });
    }
    for (const t of rec.triggers ?? []) {
      for (const key of triggerReads(t) ?? []) {
        if (key === self) continue;
        const known = tables.find(x => tableKey(x.schema, x.table) === key);
        const parts = known ? { schema: known.schema, table: known.table } : splitKey(key);
        if (!parts) continue;
        const e = entry(parts.schema, parts.table);
        if (!e.evidence.some(v => v.basis === 'trigger' && v.trigger === t.name)) e.evidence.push({ type: 'inference', basis: 'trigger', trigger: t.name, ...(t.function ? { function: t.function } : {}) });
      }
    }
  }
  for (const m of marks ?? []) entry(m.schema, m.table).evidence.push({ type: 'user', at: m.at });
  const rank = e => (e.evidence.some(v => v.type === 'catalog') ? 0 : e.evidence.some(v => v.type === 'user') ? 1 : 2);
  const required = [...byId.values()].sort((a, b) => rank(a) - rank(b) || textOrder(a.id, b.id));
  return { required, optional: [...optional.values()].filter(o => !byId.has(o.id)).sort((a, b) => textOrder(a.id, b.id)) };
}

// "schema.table" (quoted parts allowed) -> { schema, table }, or null.
function splitKey(key) {
  const m = /^("(?:[^"]|"")*"|[^."]*)\.("(?:[^"]|"")*"|[^."]*)$/.exec(key);
  if (!m) return null;
  const un = p => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p);
  return { schema: un(m[1]), table: un(m[2]) };
}
