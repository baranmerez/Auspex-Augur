// Schema memory: what Auspex has learned about each database, kept in local
// JSON files under <memoryDir>/<profile>/. It grows with the work: a table is
// recorded when describe_table reads it or when a plan touches it, never by
// crawling the catalog. Reading the memory never touches the database.
//
//   tables/<schema>/<table>.json   structure, used columns, change history
//   functions/<schema>/<name>.json all overloads of one function name:
//                                  properties, definition, inferred touches,
//                                  change history (describe_functions,
//                                  list_functions)
//   notes.json                     rules, observations and inferences
//   changelog.jsonl                explored tables and schema changes, for timelines
//   scanned-files.json             script files read for column scores: path
//                                  relative to its script root, sha256 and
//                                  lastReadAt (never the file contents)
//   graph.json                     derived view for the viewer and desktop app;
//                                  rebuilt after every change, safe to delete
//   graph.stale                    marker: a change was stored but graph.json
//                                  could not be rebuilt; the next memory
//                                  change, table_knowledge, the notes of a
//                                  query, or the viewer's memory routes
//                                  rebuild it and remove the marker
//
// Commit point: a mutation is committed once its canonical file (a table or
// function record, notes.json; for score_columns the table record) is
// written. Everything after that (changelog, graph.json, scanned-files.json,
// the notes and neighbours added to a result) is derived: a failure there
// never throws; the call returns its committed result with an additive
// repair field ({ graph?: 'stale', changelog?: 'failed', sections?:
// 'omitted', scannedFiles?: 'failed', marker?: 'failed', error: { code,
// message } }) and the graph is marked stale. Failures before the commit
// point throw and change nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { withFileLock } from '../fileLock.js';
import { writePrivateAtomic, appendPrivate, linkBelow } from '../privateFiles.js';
import path from 'node:path';
import { splitColumnRef } from './planUsage.js';
import { functionTouches, functionCalls, callsVersion } from './functionTouches.js';
import { classifyError } from '../errors.js';

export const noteKinds = ['rule', 'observation', 'inference'];
const historyLimit = 50;
const neighborLimit = 10;
const noteLineLimit = 10;
const databaseNoteLimit = 10;
const profilePattern = /^[a-z][a-z0-9_-]{0,39}$/;
// Column scores (score_columns): decided by the agent from read SQL, never
// computed here. Only the input is validated.
export const columnRoles = ['key', 'join', 'filter', 'display', 'aggregate', 'sort/group'];
export const scoreHistoryLimit = 5;
// agent: decided from read SQL; user: stated by the user, wins when present.
export const scoreLayers = ['agent', 'user'];
export const maxScannedFilesPerRoot = 20000;
export const maxScoreReason = 200;
export const maxScoredColumns = 2000;
export const maxScannedFiles = 1000;
export const maxTriggerSummary = 200;
export const maxTriggerSummaries = 200;
// remember evidenceCode: references into a configured code root (name, path
// relative to it, optional line and symbol); never the code itself.
export const maxEvidenceCode = 5;
export const maxCodeSymbol = 120;
export const maxCodeLine = 10000000;
const maxScannedPath = 500;
const sha256Pattern = /^[0-9a-f]{64}$/;
const reservedFileName = /^(con|prn|aux|nul|com\d|lpt\d)$/;

// errorCode (src/errors.js): INVALID_INPUT unless the throw site says otherwise.
export class MemoryError extends Error {
  constructor(message, errorCode = 'INVALID_INPUT') {
    super(message);
    this.errorCode = errorCode;
  }
}

// Lower-case letters, digits, _ and - stay; any other character becomes
// ~<UTF-8 hex>, so names that differ only in case (or reserved device names)
// never collide on case-insensitive file systems. The match is per code point
// (u flag): a character outside the Basic Multilingual Plane, such as an
// emoji, is one character with its own UTF-8 bytes, not two halves that would
// each turn into the replacement character and collide.
export function fileSegment(name) {
  const value = String(name ?? '');
  if (!value) throw new MemoryError('Schema and table names must not be empty.');
  const encoded = value.replace(/[^a-z0-9_-]/gu, ch => `~${Buffer.from(ch, 'utf8').toString('hex')}`);
  return reservedFileName.test(encoded) ? `~${encoded}` : encoded;
}

// fileSegment as it was before the u flag: each half of a surrogate pair
// became ~efbfbd. Only used to find and move such older table files.
const astralChar = /[\u{10000}-\u{10FFFF}]/u;
function legacySegment(name) {
  const encoded = String(name).replace(/[^a-z0-9_-]/g, ch => `~${Buffer.from(ch, 'utf8').toString('hex')}`);
  return reservedFileName.test(encoded) ? `~${encoded}` : encoded;
}

// Identity of a table in edges, graph ids and table_knowledge. Ordinary names
// stay "schema.table"; a name with a dot or a double quote is quoted the way
// quote_ident does it ("a.b", "x""y"), so example."orders.history" and
// "example.orders".history never share a key.
const keyPart = name => {
  const value = String(name ?? '');
  return /[."]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};
export const tableKey = (schema, table) => `${keyPart(schema)}.${keyPart(table)}`;

// Schema and table of a tableKey; null when the key is not one.
const tableKeyPattern = /^("(?:[^"]|"")*"|[^."]*)\.("(?:[^"]|"")*"|[^."]*)$/;
const unquotePart = part => (part.startsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part);
function splitTableKey(key) {
  const m = tableKeyPattern.exec(String(key ?? ''));
  return m ? { schema: unquotePart(m[1]), table: unquotePart(m[2]) } : null;
}

const sameTable = (a, b) => a.schema === b.schema && a.table === b.table;

// Definitions (view and function) are stored up to this many characters.
export const storedTextChars = 200000;
const charCount = text => Array.from(String(text)).length;
const cutText = (text, n) => (String(text).length <= n ? String(text) : Array.from(String(text)).slice(0, n).join(''));
const textOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The view fields of a describe result as stored: the definition cut at
// storedTextChars (viewHash stays the hash of the full text), options,
// populated (materialized views), sources and called functions. Fields the
// describe result does not have are left out.
function viewRecord(desc) {
  if (desc.viewDefinition === undefined || desc.viewDefinition === null) return {};
  const length = charCount(desc.viewDefinition);
  return {
    viewDefinition: cutText(desc.viewDefinition, storedTextChars),
    viewDefinitionLength: length,
    viewDefinitionTruncated: length > storedTextChars,
    ...(desc.viewOptions ? { viewOptions: { securityBarrier: !!desc.viewOptions.securityBarrier, checkOption: desc.viewOptions.checkOption ?? null } } : {}),
    ...(typeof desc.populated === 'boolean' ? { populated: desc.populated } : {}),
    ...(Array.isArray(desc.viewSources) ? {
      viewSources: desc.viewSources.map(v => ({ schema: v.schema, table: v.table, kind: v.kind ?? null, columns: [...new Set(v.columns ?? [])].sort(textOrder) })),
    } : {}),
    ...(Array.isArray(desc.viewFunctions) ? {
      viewFunctions: desc.viewFunctions.map(f => ({ schema: f.schema, name: f.name, arguments: f.arguments ?? '', volatility: f.volatility ?? null })),
    } : {}),
  };
}

// The structural part of a describe_table result, in the form stored and diffed.
export function recordFromDescribe(desc) {
  return {
    schema: desc.schema,
    table: desc.table,
    kind: desc.kind ?? null,
    oid: desc.oid ?? null,
    comment: desc.comment ?? null,
    estimatedRows: desc.estimated_rows ?? null,
    columns: desc.columns.map(c => ({
      name: c.column, attnum: c.attnum ?? null, type: c.type, notNull: !!c.not_null, default: c.default ?? null, comment: c.comment ?? null,
    })),
    constraints: desc.constraints.map(c => ({
      name: c.name, type: c.type, columns: c.columns ?? [], definition: c.definition,
      ...(c.type === 'foreign key' && c.ref_table ? { references: { schema: c.ref_schema, table: c.ref_table, columns: c.ref_columns ?? [] } } : {}),
    })),
    indexes: desc.indexes.map(i => ({ name: i.name, definition: i.definition })),
    referencedBy: desc.referencedBy.map(r => ({
      name: r.name, schema: r.from_schema, table: r.from_name, columns: r.columns ?? [], refColumns: r.ref_columns ?? [],
    })),
    viewHash: desc.viewDefinition ? crypto.createHash('sha256').update(desc.viewDefinition).digest('hex').slice(0, 16) : null,
    ...viewRecord(desc),
    // Views and materialized views that read this relation (any kind).
    ...(Array.isArray(desc.usedByViews) ? { usedByViews: desc.usedByViews.map(v => ({ schema: v.schema, table: v.table, kind: v.kind ?? null })) } : {}),
    // Triggers as describe_table read them (CREATE TRIGGER text, never the
    // function source). Absent when the describe result had none.
    ...(Array.isArray(desc.triggers) ? { triggers: desc.triggers.map(triggerRecord) } : {}),
  };
}

export function triggerRecord(t) {
  return {
    name: t.name, timing: t.timing ?? null, events: t.events ?? [], level: t.level ?? null, enabled: t.enabled ?? null,
    function: t.function ?? null, when: t.whenCondition ?? t.when ?? null, definition: t.definition ?? null, constraintTrigger: !!t.constraintTrigger,
  };
}

const definitionHash = text => crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);

// Structural changes between two recordings of the same table. Row estimates,
// defaults and comments are not changes. Same table (oid) and same attnum with
// a new name is a rename, not a drop plus an add.
export function diffTable(prev, next) {
  const changes = [];
  if (prev.kind && next.kind && prev.kind !== next.kind) changes.push({ change: 'kind-changed', from: prev.kind, to: next.kind });
  const oldCols = new Map(prev.columns.map(c => [c.name, c]));
  const newCols = new Map(next.columns.map(c => [c.name, c]));
  let dropped = prev.columns.filter(c => !newCols.has(c.name));
  let added = next.columns.filter(c => !oldCols.has(c.name));
  const pairs = [...prev.columns.filter(c => newCols.has(c.name)).map(c => [c, newCols.get(c.name)])];
  if (prev.oid != null && prev.oid === next.oid) {
    for (const a of added) {
      const d = dropped.find(x => x.attnum != null && x.attnum === a.attnum);
      if (!d) continue;
      changes.push({ change: 'column-renamed', from: d.name, to: a.name });
      pairs.push([d, a]);
      dropped = dropped.filter(x => x !== d);
      added = added.filter(x => x !== a);
    }
  }
  for (const c of dropped) changes.push({ change: 'column-dropped', column: c.name, type: c.type });
  for (const c of added) changes.push({ change: 'column-added', column: c.name, type: c.type });
  for (const [o, n] of pairs) {
    if (o.type !== n.type) changes.push({ change: 'column-type-changed', column: n.name, from: o.type, to: n.type });
    if (o.notNull !== n.notNull) changes.push({ change: 'column-nullability-changed', column: n.name, notNull: n.notNull });
  }
  diffNamed(changes, 'constraint', prev.constraints, next.constraints, c => c.name, c => c.definition);
  diffNamed(changes, 'index', prev.indexes, next.indexes, i => i.name, i => i.definition);
  diffNamed(changes, 'incoming-fk', prev.referencedBy || [], next.referencedBy || [], r => `${r.schema}.${r.table}.${r.name}`, r => r.columns.join(','));
  if (prev.viewHash && next.viewHash && prev.viewHash !== next.viewHash) changes.push({ change: 'view-definition-changed' });
  // Records from before view sources were stored have no field: no change.
  if (Array.isArray(prev.viewSources) && Array.isArray(next.viewSources)) {
    const ids = list => list.map(v => tableKey(v.schema, v.table)).sort(textOrder).join('\n');
    if (ids(prev.viewSources) !== ids(next.viewSources)) {
      const before = new Set(prev.viewSources.map(v => tableKey(v.schema, v.table)));
      const after = new Set(next.viewSources.map(v => tableKey(v.schema, v.table)));
      changes.push({
        change: 'view-sources-changed',
        added: [...after].filter(k => !before.has(k)).sort(textOrder),
        removed: [...before].filter(k => !after.has(k)).sort(textOrder),
      });
    }
  }
  // Records from before triggers were stored have no field: no false "added".
  if (Array.isArray(prev.triggers) && Array.isArray(next.triggers)) {
    diffNamed(changes, 'trigger', prev.triggers, next.triggers, t => t.name, t => t.definition);
    const before = new Map(prev.triggers.map(t => [t.name, t]));
    for (const t of next.triggers) {
      const old = before.get(t.name);
      if (old && old.enabled !== t.enabled) changes.push({ change: 'trigger-enabled-changed', name: t.name, from: old.enabled, to: t.enabled });
    }
  }
  return changes;
}

function diffNamed(changes, what, before, after, key, body) {
  const a = new Map(before.map(x => [key(x), x]));
  const b = new Map(after.map(x => [key(x), x]));
  for (const [k, x] of a) if (!b.has(k)) changes.push({ change: `${what}-dropped`, name: k, definition: body(x) });
  for (const [k, x] of b) {
    if (!a.has(k)) changes.push({ change: `${what}-added`, name: k, definition: body(x) });
    else if (body(a.get(k)) !== body(x)) changes.push({ change: `${what}-changed`, name: k, from: body(a.get(k)), to: body(x) });
  }
}

export function changeText(c) {
  switch (c.change) {
    case 'column-added': return `column ${c.column} added (${c.type})`;
    case 'column-dropped': return `column ${c.column} dropped (was ${c.type})`;
    case 'column-renamed': return `column ${c.from} renamed to ${c.to}`;
    case 'column-type-changed': return `column ${c.column} type ${c.from} -> ${c.to}`;
    case 'column-nullability-changed': return `column ${c.column} is now ${c.notNull ? 'NOT NULL' : 'nullable'}`;
    case 'kind-changed': return `relation kind ${c.from} -> ${c.to}`;
    case 'view-definition-changed': return 'view definition changed';
    case 'view-sources-changed': return `view sources changed${c.added?.length ? `: added ${c.added.join(', ')}` : ''}${c.removed?.length ? `${c.added?.length ? ';' : ':'} removed ${c.removed.join(', ')}` : ''}`;
    case 'overload-added': return `overload (${c.arguments}) added`;
    case 'overload-removed': return `overload (${c.arguments}) removed`;
    case 'definition-changed': return `definition of (${c.arguments}) changed`;
    case 'flags-changed': return `properties of (${c.arguments}) changed: ${(c.fields ?? []).join(', ')}`;
    case 'trigger-enabled-changed': return `trigger ${c.name} ${c.from} -> ${c.to}`;
    default: {
      const [what, verb] = [c.change.slice(0, c.change.lastIndexOf('-')), c.change.slice(c.change.lastIndexOf('-') + 1)];
      return `${what.replace('-', ' ')} ${c.name} ${verb}`;
    }
  }
}

function noteLine(n) {
  const target = n.column ? ` ${n.column}` : '';
  const suffix = n.kind === 'observation' && n.asOf ? ` (as of ${n.asOf})`
    : n.kind === 'inference' ? (n.evidenceCode?.length ? ' (code inference, unconfirmed)' : ' (unconfirmed)') : '';
  return `#${n.id} ${n.kind}${target}: ${n.text}${suffix}`;
}

// Memory folder -> profiles known stale in this process (see markGraphStale).
const staleByRoot = new Map();

export class SchemaMemory {
  // approvedJoins(profile) -> [{ left: 'schema.table.column', right: ... }] from
  // approved reports: the "used" relation level.
  // storeUpgradedCalls: write recomputed function calls back into the
  // function records (upgradeCalls). Only the MCP server sets it; the viewer,
  // desktop CLI and scheduler compute them in memory and never write function
  // records.
  constructor(root, { now = () => new Date().toISOString(), approvedJoins = () => [], scannedFilesPerRoot = maxScannedFilesPerRoot, storeUpgradedCalls = false } = {}) {
    this.scannedFilesPerRoot = scannedFilesPerRoot;
    this.storeUpgradedCalls = storeUpgradedCalls;
    this.root = path.resolve(root);
    // Profiles whose graph is stale although neither graph.stale nor the
    // removal of graph.json could be written (markGraphStale); shared by all
    // instances on this memory folder in this process (keyed by the resolved
    // root, so it must be set first).
    if (!staleByRoot.has(this.root)) staleByRoot.set(this.root, new Set());
    this.staleProfiles = staleByRoot.get(this.root);
    this.now = now;
    this.approvedJoins = approvedJoins;
    this.cache = new Map();
  }

  // Refuses a memory path whose folders or file below the root are a
  // symbolic link or junction, so no read or write leaves the memory folder.
  // The root itself may be a link (a configured folder).
  checkPath(file) {
    const link = linkBelow(this.root, file);
    if (link) throw Object.assign(new MemoryError(`Schema memory path ${link} is a link or junction; refused.`, 'DISK_ERROR'), { linkRefused: true });
    return file;
  }

  profileDir(profile) {
    if (!profilePattern.test(String(profile || ''))) throw new MemoryError(`Invalid profile name "${profile}".`, 'PROFILE_INVALID');
    return this.checkPath(path.join(this.root, profile));
  }

  tablePath(profile, schema, table) {
    return this.checkPath(path.join(this.profileDir(profile), 'tables', fileSegment(schema), `${fileSegment(table)}.json`));
  }

  // The cache key names the file's identity, not only its time and size: every
  // write replaces the file with a rename (a new inode, a new NTFS file id on
  // Windows, and a new ctime), so another process's write is seen even when it
  // has the same length and modification time. A filesystem that reports no
  // inode (ino 0, some network shares) gives no identity: read without cache.
  // cache: false reads without keeping the value (function records with
  // their bodies are not kept in memory).
  readJson(file, fallback, { cache = true } = {}) {
    this.checkPath(file);
    let stat;
    try {
      stat = fs.statSync(file, { bigint: true });
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
    const key = stat.ino === 0n ? null : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const hit = key && this.cache.get(file);
    if (hit && hit.key === key) return structuredClone(hit.value);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cache) {
      this.cache.delete(file);
      return value;
    }
    if (key) this.cache.set(file, { key, value });
    else this.cache.delete(file);
    return structuredClone(value);
  }

  writeJson(file, value) {
    writePrivateAtomic(this.checkPath(file), `${JSON.stringify(value, null, 1)}\n`);
    this.cache.delete(file);
  }

  // Where an older Auspex wrote a table whose schema or table name holds a
  // character outside the Basic Multilingual Plane (see legacySegment), or
  // null when the name has none and the path did not change.
  legacyTablePath(profile, schema, table) {
    if (!astralChar.test(`${schema}${table}`)) return null;
    return this.checkPath(path.join(this.profileDir(profile), 'tables', legacySegment(schema), `${legacySegment(table)}.json`));
  }

  // A record under an old file name counts only when it is this very table:
  // two such names used to share one file, and the later one overwrote it.
  readTable(profile, schema, table) {
    const record = this.readJson(this.tablePath(profile, schema, table), null);
    if (record) return record;
    const legacy = this.legacyTablePath(profile, schema, table);
    const old = legacy ? this.readJson(legacy, null) : null;
    return old && old.schema === schema && old.table === table ? old : null;
  }

  // Writing under the current file name also removes this table's record
  // under the old one, so it is not listed twice.
  // The record is committed once written; removing the older copy is
  // cleanup after the commit and never fails the call (stderr only; the old
  // copy is ignored by readTable while the new one exists).
  writeTable(profile, record) {
    this.writeJson(this.tablePath(profile, record.schema, record.table), record);
    try {
      const legacy = this.legacyTablePath(profile, record.schema, record.table);
      if (!legacy) return;
      const old = this.readJson(legacy, null, { cache: false });
      if (old && old.schema === record.schema && old.table === record.table) {
        fs.rmSync(legacy, { force: true });
        this.cache.delete(legacy);
      }
    } catch (err) {
      process.stderr.write(`auspex: schema memory older table file not removed: ${repairError(err).message}\n`);
    }
  }

  // Every table record once. An older copy of a table under its earlier file
  // name (legacySegment) that could not be removed yet is left out when the
  // record under the current name exists, as readTable does.
  listTables(profile) {
    const dir = this.checkPath(path.join(this.profileDir(profile), 'tables'));
    if (!fs.existsSync(dir)) return [];
    const byKey = new Map();
    for (const schemaDir of fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory())) {
      for (const f of fs.readdirSync(path.join(dir, schemaDir.name)).filter(f => f.endsWith('.json'))) {
        const file = path.join(dir, schemaDir.name, f);
        let record;
        try {
          record = this.readJson(file, null);
        } catch (err) {
          if (!err.linkRefused) throw err;
          // One linked table file must not fail the view and every later write.
          process.stderr.write(`auspex: schema memory table skipped: ${err.message}\n`);
          continue;
        }
        if (!record) continue;
        const key = tableKey(record.schema, record.table);
        let canonical = false;
        try { canonical = this.tablePath(profile, record.schema, record.table) === file; } catch { /* odd names: not canonical */ }
        const seen = byKey.get(key);
        if (!seen || (canonical && !seen.canonical)) byKey.set(key, { record, canonical });
      }
    }
    return [...byKey.values()].map(v => v.record).sort((a, b) => tableKey(a.schema, a.table).localeCompare(tableKey(b.schema, b.table)));
  }

  // Read-modify-write of one profile's memory (tables, notes, view) runs under
  // a cross-process lock (<memory>/<profile>/.lock); re-entrant in a process.
  locked(profile, fn) {
    return withFileLock(path.join(this.profileDir(profile), '.lock'), fn);
  }

  profiles() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter(d => d.isDirectory() && profilePattern.test(d.name))
      .map(d => d.name)
      .sort();
  }

  // Best effort like the audit log: the table or note is already stored, so a
  // refused or failed append (for example a linked changelog.jsonl) is
  // reported on stderr and does not fail the call.
  appendChangelog(profile, entry, repair = null) {
    const file = path.join(this.profileDir(profile), 'changelog.jsonl');
    try {
      appendPrivate(file, `${JSON.stringify(entry)}\n`);
      return true;
    } catch (err) {
      process.stderr.write(`auspex: schema memory changelog write failed: ${err.message}\n`);
      if (repair) {
        repair.changelog = 'failed';
        repair.error ??= repairError(err);
      }
      return false;
    }
  }

  // ---------- derived steps after a commit ----------
  graphStalePath(profile) {
    return path.join(this.profileDir(profile), 'graph.stale');
  }

  // True when a stored change has not reached graph.json yet: graph.stale
  // exists, or graph.json is missing although the profile has stored records
  // (the marker could not be written and graph.json was removed instead).
  isGraphStale(profile) {
    if (this.staleProfiles.has(profile)) return true;
    try {
      if (fs.existsSync(this.checkPath(this.graphStalePath(profile)))) return true;
      const dir = this.profileDir(profile);
      if (fs.existsSync(this.checkPath(path.join(dir, 'graph.json')))) return false;
      return ['tables', 'functions', 'notes.json'].some(f => fs.existsSync(path.join(dir, f)));
    } catch {
      return false;
    }
  }

  // Server-side reads of the memory (table_knowledge, notes for a query)
  // first rebuild a stale graph.json, under the profile lock.
  healIfStale(profile) {
    if (!this.rebuilding && this.isGraphStale(profile)) this.healGraph(profile);
  }

  // Durable stale mark. When even the marker cannot be written, graph.json is
  // removed so an outdated graph never looks current. False when neither
  // worked.
  // When neither works, this process still knows (staleProfiles) and
  // rebuilds on its next read; another process cannot see it.
  markGraphStale(profile, error) {
    try {
      writePrivateAtomic(this.checkPath(this.graphStalePath(profile)), `${JSON.stringify({ at: this.now(), error })}\n`);
      return true;
    } catch {
      this.staleProfiles.add(profile);
      try {
        fs.rmSync(this.checkPath(path.join(this.profileDir(profile), 'graph.json')), { force: true });
      } catch { /* reported through repair.marker */ }
      return false;
    }
  }

  // Rebuilds graph.json after a commit; never throws (see the header).
  rebuildAfterCommit(profile, repair) {
    try {
      this.rebuildViewUnlocked(profile);
    } catch (err) {
      repair.graph = 'stale';
      repair.error ??= repairError(err);
      if (!this.markGraphStale(profile, repair.error)) repair.marker = 'failed';
    }
  }

  // A derived part of a committed result (notes, neighbours): the fallback
  // when it cannot be computed.
  derivedSection(repair, fn, fallback = {}) {
    try {
      return fn();
    } catch (err) {
      repair.sections = 'omitted';
      repair.error ??= repairError(err);
      return fallback;
    }
  }

  // Rebuilds a stale graph.json (best effort; the next call tries again).
  healGraph(profile) {
    try {
      this.rebuildView(profile);
      return true;
    } catch (err) {
      process.stderr.write(`auspex: schema memory graph still stale: ${repairError(err).message}\n`);
      return false;
    }
  }

  // A linked changelog reads as empty (one stderr line), so the view still
  // rebuilds and a memory write that already happened is not reported failed.
  readChangelog(profile, limit = 200) {
    const file = path.join(this.profileDir(profile), 'changelog.jsonl');
    try {
      this.checkPath(file);
    } catch (err) {
      process.stderr.write(`auspex: schema memory changelog not read: ${err.message}\n`);
      return [];
    }
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  // describe_table read the full structure: store it and report what changed
  // since the last recording.
  recordDescribe(desc) {
    return this.locked(desc.profile, () => this.recordDescribeUnlocked(desc));
  }

  // describe_tables: records each table like recordDescribe, under one lock
  // and with one view rebuild. Returns one result per desc, in order; a
  // failure is reported for that table only.
  recordDescribeMany(profile, descs) {
    return this.locked(profile, () => {
      const out = descs.map(desc => {
        try {
          return this.recordDescribeUnlocked({ ...desc, profile }, { rebuild: false });
        } catch (err) {
          return { memoryError: err.message };
        }
      });
      const repair = {};
      this.rebuildAfterCommit(profile, repair);
      return withRepair(out, repair);
    });
  }

  recordDescribeUnlocked(desc, { rebuild = true } = {}) {
    const profile = desc.profile;
    const next = recordFromDescribe(desc);
    const prev = this.readTable(profile, next.schema, next.table);
    const at = this.now();
    const firstTime = !prev?.describedAt;
    const changes = firstTime ? [] : diffTable(prev, next);
    const record = {
      ...next,
      firstSeen: prev?.firstSeen ?? at,
      lastSeen: at,
      describedAt: at,
      usedColumns: prev?.usedColumns ?? {},
      history: [...(prev?.history ?? []), ...(changes.length ? [{ at, changes }] : [])].slice(-historyLimit),
      ...(prev && 'estRows' in prev ? { estRows: prev.estRows, estRowsAt: prev.estRowsAt } : {}), // relation_stats
      ...(prev?.relationStats ? { relationStats: prev.relationStats } : {}),
      ...(prev?.columnScores ? { columnScores: prev.columnScores, scoredAt: prev.scoredAt } : {}), // score_columns
      ...(prev?.triggerSummaries ? { triggerSummaries: prev.triggerSummaries } : {}),
    };
    this.writeTable(profile, record); // commit point
    const repair = {};
    if (firstTime) this.appendChangelog(profile, { at, schema: next.schema, table: next.table, event: 'explored' }, repair);
    else if (changes.length) this.appendChangelog(profile, { at, schema: next.schema, table: next.table, event: 'changed', changes }, repair);
    if (rebuild) this.rebuildAfterCommit(profile, repair);
    return {
      recorded: firstTime ? 'first time' : 'updated',
      ...(firstTime ? {} : { lastDescribedAt: prev.describedAt }),
      ...(changes.length ? { changesSinceLast: changes.map(changeText) } : {}),
      ...this.derivedSection(repair, () => this.notesSection(profile, [next])),
      ...repairField(repair),
    };
  }

  // A plan touched these relations: remember that they exist and which columns
  // were used. Relations not described yet stay "seen" (name and usage only).
  recordSeen(profile, relations) {
    return this.locked(profile, () => this.recordSeenUnlocked(profile, relations));
  }

  recordSeenUnlocked(profile, relations) {
    this.touchSeenUnlocked(profile, relations); // commit point
    const repair = {};
    if (relations.length) this.rebuildAfterCommit(profile, repair);
    return {
      ...this.derivedSection(repair, () => this.notesSection(profile, relations)),
      ...this.derivedSection(repair, () => this.neighborsSection(profile, relations)),
      ...repairField(repair),
    };
  }

  // Writes each relation's record (a "seen" stub when it is new) with
  // lastSeen and used columns; update(record, rel, at) may add more before
  // the write. Does not rebuild the view.
  // All records are read before the first write, so an unreadable record
  // fails the call with nothing changed. A write that fails after others were
  // written leaves a partial change: the graph is marked stale (it must not
  // look current) and the call fails naming how many records were written.
  touchSeenUnlocked(profile, relations, update = null) {
    const at = this.now();
    const prior = relations.map(rel => this.readTable(profile, rel.schema, rel.table));
    let written = 0;
    for (const [i, rel] of relations.entries()) {
      const prev = prior[i];
      const record = prev ?? {
        schema: rel.schema, table: rel.table, kind: null, oid: null, comment: null, estimatedRows: null,
        columns: [], constraints: [], indexes: [], referencedBy: [], viewHash: null,
        firstSeen: at, describedAt: null, usedColumns: {}, history: [],
      };
      record.lastSeen = at;
      for (const col of rel.columns || []) {
        const used = Object.hasOwn(record.usedColumns, col) ? record.usedColumns[col] : { count: 0 };
        setOwn(record.usedColumns, col, { count: (used?.count ?? 0) + 1, lastUsed: at });
      }
      update?.(record, rel, at);
      try {
        this.writeTable(profile, record);
      } catch (err) {
        if (!written) throw err;
        const error = repairError(err);
        if (!this.markGraphStale(profile, error)) process.stderr.write('auspex: schema memory graph could not be marked stale\n');
        throw Object.assign(new MemoryError(`Only ${written} of ${relations.length} table records were written (${error.message}); the graph is marked stale. Repeating the call counts the used columns of the written tables again.`, 'DISK_ERROR'), { partialCommit: { written, total: relations.length } });
      }
      written += 1;
    }
    return at;
  }

  // relation_stats: the centers and their visible neighbours are recorded as
  // seen (never as explored), each with its row estimate (estRows), and each
  // center with its ranked foreign keys and linked-row estimates
  // (relationStats), which graph() turns into edge figures. One view rebuild.
  // Returns the keys (schema.table) of the relations explored so far.
  recordRelationStats(profile, centers) {
    return this.locked(profile, () => {
      const rels = new Map();
      const put = (schema, table, estRows) => {
        const key = tableKey(schema, table);
        if (!rels.has(key)) rels.set(key, { schema, table, estRows });
        return rels.get(key);
      };
      for (const c of centers) {
        for (const item of [...c.instance, ...c.dependent]) put(item.schema, item.table, item.tableEstRows);
      }
      for (const c of centers) {
        const keep = ({ schema, table, constraint, columns, refColumns, linkedRows }) => ({ schema, table, constraint, columns, refColumns, linkedRows });
        Object.assign(put(c.schema, c.table, c.estRows), { estRows: c.estRows, relationStats: { instance: c.instance.map(keep), dependent: c.dependent.map(keep) } });
      }
      this.touchSeenUnlocked(profile, [...rels.values()], (record, rel, at) => {
        record.estRows = rel.estRows ?? null;
        record.estRowsAt = at;
        if (rel.relationStats) record.relationStats = { at, ...rel.relationStats };
      }); // commit point
      const repair = {};
      this.rebuildAfterCommit(profile, repair);
      // explored null (unknown) when the records cannot be read back.
      const explored = this.derivedSection(repair, () => new Set([...rels.keys()].filter(key => this.readTable(profile, rels.get(key).schema, rels.get(key).table)?.describedAt)), null);
      return { explored, ...repairField(repair) };
    });
  }

  // ---------- functions ----------
  // One file per schema and function name with every overload known.
  functionPath(profile, schema, name) {
    return this.checkPath(path.join(this.profileDir(profile), 'functions', fileSegment(schema), `${fileSegment(name)}.json`));
  }

  readFunction(profile, schema, name) {
    return this.readJson(this.functionPath(profile, schema, name), null, { cache: false });
  }

  // A function record without its definitions, for the graph: every
  // overload keeps its stored call list (calls). Calls missing or stored by an
  // older scanner (callsVersion) are computed from the stored definition and
  // written back once (upgradeCalls), so later rebuilds read no bodies.
  // Cached by file identity like readJson; the bodies are never cached.
  // The result is shared: callers must not change it.
  readFunctionSummary(profile, file) {
    this.checkPath(file);
    const stat = fs.statSync(file, { bigint: true });
    const key = stat.ino === 0n ? null : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    this.summaryCache ??= new Map();
    const hit = key && this.summaryCache.get(file);
    if (hit && hit.key === key) return hit.value;
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const current = o => callsCurrent(o);
    const value = {
      ...rec,
      overloads: (rec.overloads ?? []).map(({ definition, ...o }) => (current(o) ? o : { ...o, calls: functionCalls(definition), callsVersion })),
    };
    // After an upgrade the file has a new identity: the next read caches it.
    const upgraded = this.storeUpgradedCalls && (rec.overloads ?? []).some(o => !current(o)) && this.upgradeCalls(profile, file, rec);
    if (key && !upgraded) this.summaryCache.set(file, { key, value });
    return value;
  }

  // Stores the calls of a record written before calls existed or by an older
  // scanner (callsVersion), computed from its stored definitions, so later
  // graph rebuilds read no bodies. Best effort: a failed write only means the
  // calls are computed again next time. True when the file was written.
  upgradeCalls(profile, file, rec) {
    try {
      return this.locked(profile, () => {
        const latest = this.readJson(file, null, { cache: false });
        if (!latest || JSON.stringify(latest) !== JSON.stringify(rec)) return false;
        const overloads = latest.overloads.map(o => (callsCurrent(o) ? o : { ...o, calls: functionCalls(o.definition), callsVersion }));
        this.writeJson(file, { ...latest, overloads });
        return true;
      });
    } catch (err) {
      process.stderr.write(`auspex: schema memory function calls not stored: ${err.message}\n`);
      return false;
    }
  }

  // Every stored function record, without definitions (readFunctionSummary).
  listFunctions(profile) {
    const dir = this.checkPath(path.join(this.profileDir(profile), 'functions'));
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const schemaDir of fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory())) {
      for (const f of fs.readdirSync(path.join(dir, schemaDir.name)).filter(f => f.endsWith('.json'))) {
        try {
          out.push(this.readFunctionSummary(profile, path.join(dir, schemaDir.name, f)));
        } catch (err) {
          if (!err.linkRefused) throw err;
          process.stderr.write(`auspex: schema memory function skipped: ${err.message}\n`);
        }
      }
    }
    return out.filter(Boolean).sort((a, b) => textOrder(tableKey(a.schema, a.name), tableKey(b.schema, b.name)));
  }

  // describe_functions read these overloads (catalog.describeFunctions
  // entries without error): store them per schema and name and report what
  // changed since the last describe. partial: keys (tableKey of schema and
  // name) whose overloads may be incomplete (a pattern result cut at its
  // limit); their missing overloads are kept, never reported as removed.
  // One view rebuild. Returns one entry per function name, in input order.
  recordFunctions(profile, fns, { partial = new Set() } = {}) {
    return this.locked(profile, () => {
      const groups = new Map();
      for (const f of fns) {
        const key = tableKey(f.schema, f.name);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
      }
      const out = [...groups].map(([key, list]) => {
        try {
          return { function: key, ...this.recordFunctionUnlocked(profile, list, !partial.has(key)) };
        } catch (err) {
          return { function: key, memoryError: err.message };
        }
      });
      const repair = {};
      this.rebuildAfterCommit(profile, repair);
      return withRepair(out, repair);
    });
  }

  recordFunctionUnlocked(profile, list, complete) {
    const { schema, name } = list[0];
    const prev = this.readFunction(profile, schema, name);
    const at = this.now();
    const next = list.map(f => overloadFromDescribe(f));
    const firstTime = !prev?.describedAt;
    const changes = firstTime ? [] : diffFunction(prev.overloads ?? [], next, complete);
    const fresh = new Set(next.map(o => o.arguments));
    const kept = complete ? [] : (prev?.overloads ?? []).filter(o => !fresh.has(o.arguments));
    const record = {
      schema, name,
      firstSeen: prev?.firstSeen ?? at,
      lastSeen: at,
      describedAt: at,
      overloads: [...kept, ...next].sort((a, b) => textOrder(a.arguments, b.arguments)),
      history: [...(prev?.history ?? []), ...(changes.length ? [{ at, changes }] : [])].slice(-historyLimit),
    };
    this.writeJson(this.functionPath(profile, schema, name), record);
    return {
      recorded: firstTime ? 'first time' : 'updated',
      ...(prev?.describedAt ? { lastDescribedAt: prev.describedAt } : {}),
      changesSinceLast: changes.map(changeText),
    };
  }

  // list_functions: overloads seen in the catalog inventory, without
  // definitions. A new function is recorded as seen; an existing record keeps
  // every overload it has (definitions included) and only gains the overloads
  // it did not know yet (listedOnly). Unchanged records are not rewritten.
  recordListedFunctions(profile, rows) {
    return this.locked(profile, () => {
      const groups = new Map();
      for (const r of rows) {
        const key = tableKey(r.schema, r.name);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      let added = 0;
      let overloadsAdded = 0;
      let overloadsRefreshed = 0;
      let failed = 0;
      for (const list of groups.values()) {
        try {
          const { schema, name } = list[0];
          const prev = this.readFunction(profile, schema, name);
          const known = new Set((prev?.overloads ?? []).map(o => o.arguments));
          const fresh = list.filter(r => !known.has(r.arguments ?? '')).map(seenOverload);
          // A listed-only overload takes the trigger facts of the new list
          // (the catalog may have gained or lost triggers); a described
          // overload and every definition stay as they are.
          const listed = new Map(list.map(r => [r.arguments ?? '', r]));
          let refreshed = 0;
          const kept = (prev?.overloads ?? []).map(o => {
            const r = listed.get(o.arguments);
            if (!o.listedOnly || !r) return o;
            const facts = triggerFacts(r);
            if (JSON.stringify(facts) === JSON.stringify(triggerFacts(o))) return o;
            refreshed += 1;
            return { ...o, ...facts };
          });
          if (prev && !fresh.length && !refreshed) continue;
          const at = this.now();
          const record = prev
            ? { ...prev, lastSeen: at, overloads: [...kept, ...fresh].sort((a, b) => textOrder(a.arguments, b.arguments)) }
            : { schema, name, firstSeen: at, lastSeen: at, describedAt: null, overloads: fresh.sort((a, b) => textOrder(a.arguments, b.arguments)), history: [] };
          this.writeJson(this.functionPath(profile, schema, name), record);
          if (prev) {
            overloadsAdded += fresh.length;
            overloadsRefreshed += refreshed;
          } else added += 1;
        } catch (err) {
          failed += 1;
          process.stderr.write(`auspex: schema memory function not recorded: ${err.message}\n`);
        }
      }
      const repair = {};
      if (added || overloadsAdded || overloadsRefreshed) this.rebuildAfterCommit(profile, repair);
      return { functionsAdded: added, overloadsAdded, ...(overloadsRefreshed ? { overloadsRefreshed } : {}), ...(failed ? { failed } : {}), ...repairField(repair) };
    });
  }

  // graph.json functions: one light entry per stored function name (no
  // definitions), with the views and stored functions that call it.
  functionsView(profile, tables) {
    const fns = this.listFunctions(profile);
    const byViews = new Map();
    for (const t of tables) {
      for (const f of t.viewFunctions ?? []) {
        const id = tableKey(f.schema, f.name);
        if (!byViews.has(id)) byViews.set(id, new Set());
        byViews.get(id).add(tableKey(t.schema, t.table));
      }
    }
    const byFunctions = new Map();
    for (const g of fns) {
      const caller = tableKey(g.schema, g.name);
      for (const o of g.overloads ?? []) {
        for (const ref of o.calls ?? []) {
          const id = tableKey(ref.schema ?? g.schema, ref.name);
          if (id === caller) continue;
          if (!byFunctions.has(id)) byFunctions.set(id, new Set());
          byFunctions.get(id).add(caller);
        }
      }
    }
    const sorted = set => [...(set ?? [])].sort(textOrder);
    return fns.map(f => {
      const id = tableKey(f.schema, f.name);
      const overloads = f.overloads ?? [];
      const union = field => [...new Set(overloads.flatMap(o => o.touches?.[field] ?? []))].sort(textOrder).slice(0, 50);
      const triggers = new Set(overloads.flatMap(o => (o.usedByTriggers ?? []).map(t => `${t.table}\n${t.trigger}`)));
      return {
        id, schema: f.schema, name: f.name,
        file: `functions/${fileSegment(f.schema)}/${fileSegment(f.name)}.json`,
        state: f.describedAt ? 'explored' : 'seen',
        overloads: overloads.length,
        kinds: [...new Set(overloads.map(o => o.kind).filter(Boolean))].sort(textOrder),
        role: functionRole(overloads),
        timings: [...new Set(overloads.flatMap(o => (o.usedByTriggers ?? []).map(t => t.timing).filter(Boolean)))].sort(textOrder),
        triggerTables: [...new Set(overloads.flatMap(o => (o.usedByTriggers ?? []).map(triggerTableId).filter(Boolean)))].sort(textOrder),
        language: overloads[0]?.language ?? null,
        flags: {
          volatile: overloads.some(o => o.volatility === 'volatile'),
          securityDefiner: overloads.some(o => o.securityDefiner === true),
          definerWithoutSearchPath: overloads.some(o => o.securityDefiner === true && !(o.config ?? []).some(c => /^search_path=/i.test(String(c)))),
        },
        usedByTriggers: triggers.size,
        calledBy: { views: sorted(byViews.get(id)), functions: sorted(byFunctions.get(id)) },
        touches: { reads: union('reads'), writes: union('writes') },
        changes: (f.history ?? []).length,
      };
    });
  }

  // ---------- notes ----------
  readNotes(profile) {
    return this.readJson(path.join(this.profileDir(profile), 'notes.json'), { nextId: 1, notes: [] });
  }

  writeNotes(profile, data) {
    this.writeJson(path.join(this.profileDir(profile), 'notes.json'), data);
  }

  // codeRoots: names an evidenceCode root must be one of (null = not checked).
  addNote(profile, { kind, schema, table, column, text, evidence, evidenceCode, source }, { codeRoots = null } = {}) {
    return this.locked(profile, () => this.addNoteUnlocked(profile, { kind, schema, table, column, text, evidence, evidenceCode, source }, { codeRoots }));
  }

  addNoteUnlocked(profile, { kind, schema, table, column, text, evidence, evidenceCode, source }, { codeRoots = null } = {}) {
    if (!noteKinds.includes(kind)) throw new MemoryError(`kind must be one of ${noteKinds.join(', ')}.`);
    const body = String(text || '').trim();
    if (!body) throw new MemoryError('Note text is empty.');
    if (body.length > 2000) throw new MemoryError('Note text is longer than 2000 characters.');
    if (!!schema !== !!table) throw new MemoryError('Give both schema and table, or neither for a database-wide note.');
    if (column && !table) throw new MemoryError('A column note needs schema and table.');
    const figures = evidence?.figures;
    if (figures && Object.keys(figures).length > 50) throw new MemoryError('Evidence figures are limited to 50 entries.');
    if (evidence?.sql && evidence.sql.length > 20000) throw new MemoryError('Evidence SQL is longer than 20000 characters.');
    const code = validateEvidenceCode(evidenceCode, codeRoots);
    if (code.length && kind === 'rule') throw new MemoryError('evidenceCode is only valid with kind inference or observation (a rule comes from the user).');
    const at = this.now();
    const data = this.readNotes(profile);
    const note = {
      id: data.nextId,
      kind,
      schema: schema || null,
      table: table || null,
      column: column || null,
      text: body,
      source: source || (kind === 'rule' ? 'user' : 'analysis'),
      status: 'active',
      createdAt: at,
      ...(kind === 'observation' ? { asOf: at.slice(0, 10) } : {}),
      ...(evidence?.sql || figures ? { evidence: { ...(evidence.sql ? { sql: evidence.sql } : {}), ...(figures ? { figures } : {}) } } : {}),
      ...(code.length ? { evidenceCode: code } : {}),
    };
    data.notes.push(note);
    data.nextId += 1;
    this.writeNotes(profile, data); // commit point
    const repair = {};
    if (note.table) this.appendChangelog(profile, { at, schema: note.schema, table: note.table, event: 'note', noteId: note.id, kind }, repair);
    this.rebuildAfterCommit(profile, repair);
    return { ...note, ...repairField(repair) };
  }

  // An inference the user agreed with becomes a rule or an observation.
  confirmNote(profile, id, kind) {
    return this.locked(profile, () => this.confirmNoteUnlocked(profile, id, kind));
  }

  confirmNoteUnlocked(profile, id, kind) {
    if (kind !== 'rule' && kind !== 'observation') throw new MemoryError('Confirm as kind rule or observation.');
    const data = this.readNotes(profile);
    const note = data.notes.find(n => n.id === id);
    if (!note) throw new MemoryError(`Note #${id} not found.`, 'NOT_FOUND');
    if (note.status !== 'active') throw new MemoryError(`Note #${id} is archived.`, 'PRECONDITION_FAILED');
    const at = this.now();
    Object.assign(note, { kind, confirmedAt: at, ...(kind === 'observation' && !note.asOf ? { asOf: at.slice(0, 10) } : {}) });
    this.writeNotes(profile, data); // commit point
    const repair = {};
    this.rebuildAfterCommit(profile, repair);
    return { ...note, ...repairField(repair) };
  }

  // Notes are never deleted; a wrong or outdated note is archived with a reason.
  archiveNote(profile, id, reason) {
    return this.locked(profile, () => this.archiveNoteUnlocked(profile, id, reason));
  }

  archiveNoteUnlocked(profile, id, reason) {
    const why = String(reason || '').trim();
    if (!why) throw new MemoryError('Archiving needs a reason.');
    const data = this.readNotes(profile);
    const note = data.notes.find(n => n.id === id);
    if (!note) throw new MemoryError(`Note #${id} not found.`, 'NOT_FOUND');
    Object.assign(note, { status: 'archived', archivedAt: this.now(), archivedReason: why });
    this.writeNotes(profile, data); // commit point
    const repair = {};
    this.rebuildAfterCommit(profile, repair);
    return { ...note, ...repairField(repair) };
  }

  activeNotes(profile, tables) {
    const notes = this.readNotes(profile).notes.filter(n => n.status === 'active');
    if (!tables) return notes;
    return notes.filter(n => n.table && tables.some(t => n.schema === t.schema && n.table === t.table));
  }

  // Active notes about the whole database (no table). Rules are mandatory and
  // always returned in full; observations and inferences share a fixed budget
  // and the rest is counted, never dropped silently.
  databaseNotesSection(profile) {
    const order = { rule: 0, observation: 1, inference: 2 };
    const all = this.readNotes(profile).notes
      .filter(n => n.status === 'active' && !n.table)
      .sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3) || a.id - b.id);
    if (!all.length) return {};
    const rules = all.filter(n => n.kind === 'rule');
    const others = all.filter(n => n.kind !== 'rule');
    const shown = [...rules, ...others.slice(0, databaseNoteLimit)];
    return {
      databaseNotes: shown.map(n => ({
        id: n.id, scope: 'database', kind: n.kind, confirmed: n.kind !== 'inference', text: n.text,
        ...(n.asOf ? { asOf: n.asOf } : {}),
        ...(n.evidenceCode?.length ? { evidenceCode: n.evidenceCode } : {}),
      })),
      ...(others.length > databaseNoteLimit ? { moreDatabaseNotes: others.length - databaseNoteLimit } : {}),
    };
  }

  notesSection(profile, tables) {
    const notes = this.activeNotes(profile, tables);
    if (!notes.length) return {};
    const lines = notes.slice(0, noteLineLimit).map(n => (tables.length > 1 ? `${n.schema}.${n.table} ` : '') + noteLine(n));
    if (notes.length > noteLineLimit) lines.push(`... ${notes.length - noteLineLimit} more (table_knowledge)`);
    return { notes: lines };
  }

  // Notes on tables named schema.table in free SQL (only tables already in memory).
  notesForSql(profile, sql) {
    this.healIfStale(profile);
    const text = String(sql || '').toLowerCase();
    const notes = this.activeNotes(profile).filter(n => n.table);
    const touched = [];
    for (const n of notes) {
      const t = { schema: n.schema, table: n.table };
      if (!touched.some(x => sameTable(x, t)) && text.includes(`${n.schema}.${n.table}`.toLowerCase())) touched.push(t);
    }
    return touched.length ? this.notesSection(profile, touched) : {};
  }

  // ---------- column scores ----------
  // score_columns: 1-5 importance of columns of one described table, relative
  // within the table, in two layers per column: agent (decided from read SQL:
  // roles, one-line reason, number of reports/scripts) and user (stated by the
  // user: score, optional roles; clearUser removes it). The effective score is
  // the user score when present. A new score replaces the current one of its
  // layer only; the replaced states are kept newest first (scoreHistoryLimit).
  // Columns and layers not listed keep their score. scannedFiles records which script files were
  // read (path relative to its script root, sha256, lastReadAt), never their
  // contents. scriptRoots: names the root of a scanned file must be one of.
  scoreColumns(profile, input, { scriptRoots = null } = {}) {
    const { schema, table, columns, triggers, scannedFiles } = validateScoreInput(input, scriptRoots);
    return this.locked(profile, () => {
      const rec = this.readTable(profile, schema, table);
      if (!rec) throw new MemoryError(`${tableKey(schema, table)} is not in memory. Describe it first (describe_table or describe_tables).`, 'NOT_FOUND');
      if (!rec.describedAt) throw new MemoryError(`${tableKey(schema, table)} was only seen in a plan; its structure is not recorded. Describe it first (describe_table or describe_tables).`, 'PRECONDITION_FAILED');
      const known = new Set(rec.columns.map(c => c.name));
      const unknown = columns.map(c => c.name).filter(name => !known.has(name));
      if (unknown.length) throw new MemoryError(`Not columns of ${tableKey(schema, table)} in the recorded structure: ${unknown.join(', ')}. Nothing was saved; describe the table again if it changed.`);
      if (triggers.length && !Array.isArray(rec.triggers)) throw new MemoryError(`The triggers of ${tableKey(schema, table)} are not recorded yet. Describe the table again (describe_table or describe_tables); nothing was saved.`, 'PRECONDITION_FAILED');
      const recorded = new Map((rec.triggers ?? []).map(t => [t.name, t]));
      const unknownTriggers = triggers.map(t => t.name).filter(name => !recorded.has(name));
      if (unknownTriggers.length) throw new MemoryError(`Not triggers of ${tableKey(schema, table)} in the recorded structure: ${unknownTriggers.join(', ')}. Nothing was saved; describe the table again if it changed.`);
      const scores = {};
      for (const [name, value] of Object.entries(rec.columnScores ?? {})) setOwn(scores, name, value);
      const noUser = columns.filter(c => c.clearUser && !activeUser(Object.hasOwn(scores, c.name) ? scores[c.name] : null)).map(c => c.name);
      if (noUser.length) throw new MemoryError(`No user score to clear on: ${noUser.join(', ')}. Nothing was saved.`, 'PRECONDITION_FAILED');
      const at = this.now();
      for (const c of columns) {
        const entry = { ...(Object.hasOwn(scores, c.name) ? scores[c.name] : {}) };
        const prev = entry[c.by] ?? null;
        // The previous state of this layer goes to its own history, newest first.
        const history = prev ? [layerHistoryItem(prev), ...(prev.history ?? [])].slice(0, scoreHistoryLimit) : [];
        if (c.clearUser) entry.user = { cleared: true, at, history };
        else if (c.by === 'user') entry.user = { score: c.score, ...(c.roles ? { roles: c.roles } : {}), at, history };
        else entry.agent = { score: c.score, roles: c.roles, reason: c.reason, sources: c.sources, at, history };
        setOwn(scores, c.name, entry);
      }
      if (columns.length) Object.assign(rec, { columnScores: scores, scoredAt: at });
      if (triggers.length) {
        const summaries = {};
        for (const [name, value] of Object.entries(rec.triggerSummaries ?? {})) setOwn(summaries, name, value);
        // definitionHash marks the summary stale when the trigger changes later.
        for (const t of triggers) setOwn(summaries, t.name, { summary: t.summary, at, definitionHash: definitionHash(recorded.get(t.name).definition) });
        rec.triggerSummaries = summaries;
      }
      this.writeTable(profile, rec); // commit point: the scores and summaries
      const repair = {};
      // scanned-files.json is bookkeeping (files to skip next time): a failed
      // write only means they are read again.
      let scanned = null;
      if (scannedFiles.length) {
        try {
          scanned = this.recordScannedUnlocked(profile, scannedFiles, at);
        } catch (err) {
          repair.scannedFiles = 'failed';
          repair.error ??= repairError(err);
        }
      }
      this.rebuildAfterCommit(profile, repair);
      return {
        relation: tableKey(schema, table),
        scoredAt: at,
        scored: columns.length,
        ...(triggers.length ? { triggersSummarized: triggers.length } : {}),
        unscoredColumns: rec.columns.filter(c => !effectiveScore(Object.hasOwn(scores, c.name) ? scores[c.name] : null)).map(c => c.name),
        ...(scanned ? { scannedFiles: scanned } : {}),
        ...repairField(repair),
      };
    });
  }

  scannedFilesPath(profile) {
    return path.join(this.profileDir(profile), 'scanned-files.json');
  }

  // { files: [{ root, path, sha256, lastReadAt }] }, sorted by root and path.
  readScannedFiles(profile, root = null) {
    const files = this.readJson(this.scannedFilesPath(profile), { files: [] }).files;
    return root ? files.filter(f => f.root === root) : files;
  }

  // Each root keeps at most scannedFilesPerRoot entries; beyond that the
  // entries read longest ago are pruned (they are only re-read next time).
  recordScannedUnlocked(profile, scannedFiles, at) {
    const byKey = new Map(this.readScannedFiles(profile).map(f => [`${f.root}\n${f.path}`, f]));
    for (const f of scannedFiles) byKey.set(`${f.root}\n${f.path}`, { root: f.root, path: f.path, sha256: f.sha256, lastReadAt: at });
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0); // code-point order, locale independent
    const byRoot = new Map();
    for (const f of byKey.values()) byRoot.set(f.root, [...(byRoot.get(f.root) ?? []), f]);
    let pruned = 0;
    const kept = [...byRoot.values()].flatMap(list => {
      if (list.length <= this.scannedFilesPerRoot) return list;
      pruned += list.length - this.scannedFilesPerRoot;
      return list.sort((a, b) => cmp(b.lastReadAt, a.lastReadAt) || cmp(a.path, b.path)).slice(0, this.scannedFilesPerRoot);
    });
    const files = kept.sort((a, b) => cmp(a.root, b.root) || cmp(a.path, b.path));
    this.writeJson(this.scannedFilesPath(profile), { files });
    return { recorded: scannedFiles.length, total: files.length, ...(pruned ? { pruned } : {}) };
  }

  // ---------- relations ----------
  // Every relation edge known for a profile: fk (declared), used (joined in an
  // approved report), suggested (same name as another table's primary key).
  edges(profile, tables = this.listTables(profile)) {
    const edges = new Map();
    const add = (level, from, to, columns, refColumns) => {
      const key = `${level}|${tableKey(from.schema, from.table)}|${tableKey(to.schema, to.table)}|${columns.join(',')}`;
      if (!edges.has(key)) edges.set(key, { level, from: tableKey(from.schema, from.table), to: tableKey(to.schema, to.table), columns, refColumns });
    };
    for (const t of tables) {
      for (const c of t.constraints.filter(c => c.references)) add('fk', t, c.references, c.columns, c.references.columns);
      for (const r of t.referencedBy || []) add('fk', r, t, r.columns, r.refColumns);
    }
    // relation_stats: foreign keys with linked-row estimates; the latest
    // measurement of an edge wins. A describe of the source or the target
    // table after the measurement is newer evidence: a measured key that the
    // source no longer declares, or that the target no longer lists as
    // referencing it, is not published, and its figures are left out with it
    // (they stay in the table file and come back if the key does).
    const byKey = new Map(tables.map(t => [tableKey(t.schema, t.table), t]));
    const newer = (rel, s) => {
      const rec = byKey.get(tableKey(rel.schema, rel.table));
      return rec?.describedAt && s.at && rec.describedAt > s.at ? rec : null;
    };
    const dropped = (s, from, to, e) => {
      const columns = (e.columns || []).join(',');
      const source = newer(from, s);
      if (source && !source.constraints.some(c => c.references && sameTable(c.references, to) && c.columns.join(',') === columns)) return true;
      const target = newer(to, s);
      return !!target && !(target.referencedBy || []).some(r => sameTable(r, from) && (r.columns || []).join(',') === columns);
    };
    const measured = (s, from, to, e) => {
      if (dropped(s, from, to, e)) return;
      add('fk', from, to, e.columns, e.refColumns);
      const edge = edges.get(`fk|${tableKey(from.schema, from.table)}|${tableKey(to.schema, to.table)}|${e.columns.join(',')}`);
      if (!edge.statsAt || edge.statsAt < s.at) Object.assign(edge, { linkedRows: e.linkedRows ?? null, estimated: true, statsAt: s.at });
    };
    for (const t of tables) {
      const s = t.relationStats;
      if (!s) continue;
      for (const e of s.instance || []) measured(s, t, e, e);
      for (const e of s.dependent || []) measured(s, e, t, e);
    }
    const fkPairs = new Set([...edges.values()].map(e => `${e.from}|${e.to}`));
    for (const pair of this.approvedJoins(profile) || []) {
      const [l, r] = [splitColumnRef(pair.left), splitColumnRef(pair.right)];
      if (!l || !r || sameTable(l, r)) continue;
      if (fkPairs.has(`${tableKey(l.schema, l.table)}|${tableKey(r.schema, r.table)}`) || fkPairs.has(`${tableKey(r.schema, r.table)}|${tableKey(l.schema, l.table)}`)) continue;
      add('used', l, r, [l.column], [r.column]);
    }
    for (const e of suggestedEdges(tables, edges)) add('suggested', e.from, e.to, e.columns, e.refColumns);
    return [...edges.values()];
  }

  neighborsOf(profile, rels, edges) {
    const keys = new Set(rels.map(r => tableKey(r.schema, r.table)));
    const out = new Set();
    for (const e of edges) {
      if (e.level === 'suggested') continue;
      if (keys.has(e.from) && !keys.has(e.to)) out.add(e.to);
      if (keys.has(e.to) && !keys.has(e.from)) out.add(e.from);
    }
    return [...out];
  }

  // Neighbors of the given tables that were never described: candidates to
  // explore next, only after the user agrees.
  neighborsSection(profile, rels, tables = this.listTables(profile)) {
    const described = new Set(tables.filter(t => t.describedAt).map(t => tableKey(t.schema, t.table)));
    const unexplored = this.neighborsOf(profile, rels, this.edges(profile, tables)).filter(k => !described.has(k)).sort();
    if (!unexplored.length) return {};
    return { unexploredNeighbors: { tables: unexplored.slice(0, neighborLimit), more: Math.max(0, unexplored.length - neighborLimit) } };
  }

  // Everything memory knows about one table, without touching the database.
  knowledge(profile, schema, table) {
    this.healIfStale(profile);
    const rec = this.readTable(profile, schema, table);
    if (!rec) {
      const notes = this.activeNotes(profile, [{ schema, table }]).map(n => ({ id: n.id, kind: n.kind, column: n.column, text: n.text, ...(n.evidenceCode?.length ? { evidenceCode: n.evidenceCode } : {}) }));
      return { relation: tableKey(schema, table), known: false, hint: 'Not in memory yet. describe_table records it (reads the catalog only).', ...(notes.length ? { notes } : {}), ...this.databaseNotesSection(profile) };
    }
    const tables = this.listTables(profile);
    const key = tableKey(schema, table);
    const edges = this.edges(profile, tables).filter(e => e.from === key || e.to === key);
    const notes = this.activeNotes(profile, [rec]);
    const pk = rec.constraints.find(c => c.type === 'primary key')?.columns ?? [];
    const fkCols = new Set(rec.constraints.filter(c => c.references).flatMap(c => c.columns));
    const noted = new Set(notes.map(n => n.column).filter(Boolean));
    const used = rec.usedColumns || {};
    const tags = c => [pk.includes(c.name) && 'pk', fkCols.has(c.name) && 'fk', Object.hasOwn(used, c.name) && 'used', noted.has(c.name) && 'note'].filter(Boolean);
    const keyColumns = rec.columns.filter(c => tags(c).length).map(c => `${c.name} ${c.type} [${tags(c).join(',')}]`);
    const seenOnly = Object.keys(used).filter(name => !rec.columns.some(c => c.name === name)).map(name => `${name} [used]`);
    const edgeText = e => (e.from === key
      ? `${e.columns.join(',')} -> ${e.to}(${e.refColumns.join(',')})`
      : `${e.from}(${e.columns.join(',')}) -> ${e.refColumns.join(',')}`);
    return {
      relation: key,
      known: true,
      explored: !!rec.describedAt,
      kind: rec.kind,
      describedAt: rec.describedAt,
      lastSeen: rec.lastSeen,
      estimatedRows: rec.estimatedRows,
      comment: rec.comment,
      columnCount: rec.columns.length,
      keyColumns: [...keyColumns, ...seenOnly],
      otherColumns: rec.columns.filter(c => !tags(c).length).map(c => c.name).join(', '),
      relations: {
        fk: edges.filter(e => e.level === 'fk' && e.from === key).map(edgeText),
        referencedBy: edges.filter(e => e.level === 'fk' && e.to === key).map(edgeText),
        used: edges.filter(e => e.level === 'used').map(edgeText),
        suggested: edges.filter(e => e.level === 'suggested').map(e => `${edgeText(e)} (name match, unconfirmed)`),
      },
      notes: notes.map(n => ({
        id: n.id, kind: n.kind, column: n.column, text: n.text, ...(n.asOf ? { asOf: n.asOf } : {}), ...(n.evidence?.figures ? { figures: n.evidence.figures } : {}),
        ...(n.evidenceCode?.length ? { evidenceCode: n.evidenceCode } : {}),
      })),
      recentChanges: (rec.history || []).slice(-5).map(h => `${h.at.slice(0, 10)}: ${h.changes.map(changeText).join('; ')}`),
      ...columnScoresSection(rec, notes),
      ...(Array.isArray(rec.triggers) ? { triggers: triggersWithSummaries(rec) } : {}),
      ...this.databaseNotesSection(profile),
      ...this.neighborsSection(profile, [rec], tables),
    };
  }

  // Nodes and edges for the viewer: explored and seen tables plus unexplored
  // neighbors (known only by name, from foreign keys).
  graph(profile) {
    const tables = this.listTables(profile);
    const edges = this.edges(profile, tables);
    const notes = this.activeNotes(profile);
    const nodes = new Map(tables.map(t => [tableKey(t.schema, t.table), {
      id: tableKey(t.schema, t.table), schema: t.schema, table: t.table,
      file: `tables/${fileSegment(t.schema)}/${fileSegment(t.table)}.json`,
      state: t.describedAt ? 'explored' : 'seen', describedAt: t.describedAt ?? null, kind: t.kind, estimatedRows: t.estimatedRows,
      columnCount: t.columns.length, changes: (t.history || []).length,
      notes: notes.filter(n => n.schema === t.schema && n.table === t.table).length,
      ...(t.estRows !== undefined ? { estRows: t.estRows } : {}),
      ...(t.columnScores ? { scoredAt: t.scoredAt, columnScores: columnScoresView(t.columnScores) } : {}),
      ...(t.triggers?.length ? { triggers: triggersWithSummaries(t) } : {}),
      ...(Array.isArray(t.viewSources) ? { viewSources: [...new Set(t.viewSources.map(v => tableKey(v.schema, v.table)))] } : {}),
      ...(Array.isArray(t.viewFunctions) ? { viewFunctions: [...new Set(t.viewFunctions.map(f => tableKey(f.schema, f.name)))] } : {}),
    }]));
    for (const e of edges) {
      for (const id of [e.from, e.to]) {
        if (nodes.has(id)) continue;
        const { schema, table } = splitTableKey(id) ?? { schema: null, table: id };
        nodes.set(id, { id, schema, table, state: 'unexplored', describedAt: null, kind: null, estimatedRows: null, columnCount: 0, changes: 0, notes: 0 });
      }
    }
    // A view or materialized view reads its sources: one edge to each source
    // that is a node (columns: the source columns the view uses).
    const viewEdges = tables.flatMap(t => (t.viewSources ?? [])
      .filter(v => nodes.has(tableKey(v.schema, v.table)) && !sameTable(v, t))
      .map(v => ({ level: 'view', from: tableKey(t.schema, t.table), to: tableKey(v.schema, v.table), columns: v.columns ?? [], refColumns: [] })));
    return { profile, nodes: [...nodes.values()], edges: [...edges, ...viewEdges], functions: this.functionsView(profile, tables) };
  }

  // Everything the viewer shows for one profile, in one file the viewer and
  // the desktop app read as is (no relation logic outside this module).
  view(profile) {
    const { nodes, edges, functions } = this.graph(profile);
    const notes = this.readNotes(profile).notes;
    const changelog = this.readChangelog(profile, 300);
    const count = state => nodes.filter(n => n.state === state).length;
    return {
      profile,
      generatedAt: this.now(),
      summary: {
        explored: count('explored'), seen: count('seen'), unexplored: count('unexplored'),
        edges: edges.length, notes: notes.filter(n => n.status === 'active').length,
        changeTimes: changelog.filter(e => e.event === 'changed').map(e => e.at),
        lastActivity: changelog.at(-1)?.at ?? null,
      },
      nodes, edges, functions, notes, changelog,
    };
  }

  rebuildView(profile) {
    return this.locked(profile, () => this.rebuildViewUnlocked(profile));
  }

  rebuildViewUnlocked(profile) {
    this.rebuilding = true;
    try {
      this.writeJson(path.join(this.profileDir(profile), 'graph.json'), this.view(profile));
    } finally {
      this.rebuilding = false;
    }
    // graph.json is current again.
    this.staleProfiles.delete(profile);
    try {
      fs.rmSync(this.checkPath(this.graphStalePath(profile)), { force: true });
    } catch { /* stays marked: the next read rebuilds once more */ }
  }
}

// Safe description of a post-commit failure: the error code and the errno
// or class, never file content (a JSON parse error message can quote it).
function repairError(err) {
  const { code } = classifyError(err);
  const message = err instanceof MemoryError ? err.message
    : err?.code ? `${err.code}${err.syscall ? ` (${err.syscall})` : ''}`
      : err instanceof SyntaxError ? 'a memory file is not valid JSON' : 'derived view could not be written';
  return { code, message };
}

const repairField = repair => (Object.keys(repair).length ? { repair } : {});

// A list result (one entry per table or function) with the repair of the
// shared rebuild on every entry that was committed.
const withRepair = (list, repair) => (Object.keys(repair).length ? list.map(e => (e.memoryError ? e : { ...e, repair: { ...e.repair, ...repair, error: e.repair?.error ?? repair.error } })) : list);

// Stored calls are current when written by this scanner version or a newer
// one (a newer build's records are never rewritten by an older one).
const callsCurrent = o => Array.isArray(o.calls) && Number.isInteger(o.callsVersion) && o.callsVersion >= callsVersion;

const functionFlagFields = ['volatility', 'securityDefiner', 'strict', 'parallel', 'config', 'owner'];

// One overload of a describe_functions entry as stored. The definition is the
// text the memory keeps (memoryDefinition, cut at storedTextChars) when the
// entry has it, else the returned one.
export function overloadFromDescribe(f) {
  const stored = f.memoryDefinition !== undefined ? f.memoryDefinition : f.definition;
  const definition = stored === null || stored === undefined ? null : cutText(stored, storedTextChars);
  const length = f.definitionLength ?? (definition === null ? null : charCount(definition));
  return {
    arguments: f.arguments ?? '',
    returns: f.returns ?? null,
    kind: f.kind ?? null,
    language: f.language ?? null,
    volatility: f.volatility ?? null,
    securityDefiner: !!f.securityDefiner,
    strict: !!f.strict,
    parallel: f.parallel ?? null,
    config: f.config ?? [],
    owner: f.owner ?? null,
    canExecute: !!f.canExecute,
    comment: f.comment ?? null,
    usedByTriggers: f.usedByTriggers ?? [],
    returnsTrigger: f.returnsTrigger ?? f.returns === 'trigger',
    definition,
    definitionLength: length,
    truncated: definition !== null && length !== null && length > charCount(definition),
    definitionHash: definition === null ? null : definitionHash(definition),
    touches: functionTouches({ definition, schema: f.schema, language: f.language, arguments: f.arguments ?? '' }),
    // Functions the body calls as written ({ schema | null, name }), for the
    // graph's calledBy without reading the body again.
    calls: functionCalls(definition),
    callsVersion,
  };
}

// graph role of a function name from catalog facts: trigger when an
// overload returns trigger (records without returnsTrigger: the return type
// text), else the first of procedure, aggregate, window any overload is.
function functionRole(overloads) {
  if (overloads.some(o => o.returnsTrigger ?? o.returns === 'trigger')) return 'trigger';
  for (const kind of ['procedure', 'aggregate', 'window']) if (overloads.some(o => o.kind === kind)) return kind;
  return 'function';
}

// Table id of a usedByTriggers entry: tableKey from schema and tableName, or
// the stored table text of older records.
const triggerTableId = t => (t.schema !== undefined && t.tableName !== undefined ? tableKey(t.schema, t.tableName) : t.table ?? null);

// Trigger facts of an overload: whether it returns trigger and the triggers
// that call it (catalog.functionTriggerFromRow shape).
function triggerFacts(o) {
  return { returnsTrigger: o.returnsTrigger ?? o.returns === 'trigger', usedByTriggers: o.usedByTriggers ?? [] };
}

// An overload only listed (list_functions): no definition, no properties
// beyond the inventory and the trigger facts.
function seenOverload(r) {
  return {
    arguments: r.arguments ?? '', returns: r.returns ?? null, kind: r.kind ?? null, language: r.language ?? null, volatility: r.volatility ?? null,
    ...triggerFacts(r),
    definition: null, definitionLength: null, truncated: false, definitionHash: null, touches: null, calls: [], callsVersion, listedOnly: true,
  };
}

// Changes between the stored overloads of a function and a new describe.
// Listed-only overloads count as new when described; removals are only
// reported when the describe saw every overload (complete).
export function diffFunction(prev, next, complete = true) {
  const changes = [];
  const before = new Map(prev.map(o => [o.arguments, o]));
  const after = new Set(next.map(o => o.arguments));
  if (complete) for (const o of prev) if (!after.has(o.arguments)) changes.push({ change: 'overload-removed', arguments: o.arguments });
  for (const o of next) {
    const old = before.get(o.arguments);
    if (!old || old.listedOnly) {
      changes.push({ change: 'overload-added', arguments: o.arguments });
      continue;
    }
    // The stored text is cut at storedTextChars: a change after that point
    // only shows in the full length.
    // A record cut at a lower cap than today's: the new text continuing the
    // old stored one with the same full length is the same definition.
    const capRaised = old.truncated === true && typeof old.definition === 'string' && typeof o.definition === 'string'
      && old.definitionLength === o.definitionLength && o.definition.length > old.definition.length && o.definition.startsWith(old.definition);
    const hashChanged = old.definitionHash && o.definitionHash && old.definitionHash !== o.definitionHash && !capRaised;
    const lengthChanged = Number.isInteger(old.definitionLength) && Number.isInteger(o.definitionLength) && old.definitionLength !== o.definitionLength;
    if (hashChanged || lengthChanged) changes.push({ change: 'definition-changed', arguments: o.arguments });
    const fields = functionFlagFields.filter(k => JSON.stringify(old[k] ?? null) !== JSON.stringify(o[k] ?? null));
    if (fields.length) changes.push({ change: 'flags-changed', arguments: o.arguments, fields });
  }
  return changes;
}

// A column named exactly like the single-column primary key of exactly one
// other known table, with no declared foreign key on it, is a suggestion.
function suggestedEdges(tables, existing) {
  const byPk = new Map();
  for (const t of tables) {
    const pk = t.constraints.find(c => c.type === 'primary key');
    if (pk?.columns.length === 1) byPk.set(pk.columns[0], [...(byPk.get(pk.columns[0]) || []), t]);
  }
  const linked = new Set([...existing.values()].flatMap(e => [`${e.from}|${e.columns.join(',')}`]));
  const out = [];
  for (const t of tables) {
    const ownPk = t.constraints.find(c => c.type === 'primary key')?.columns ?? [];
    for (const c of t.columns) {
      const targets = (byPk.get(c.name) || []).filter(x => !sameTable(x, t));
      if (targets.length !== 1 || ownPk.includes(c.name)) continue;
      if (linked.has(`${tableKey(t.schema, t.table)}|${c.name}`)) continue;
      out.push({ from: t, to: targets[0], columns: [c.name], refColumns: [c.name] });
    }
  }
  return out;
}

// Own property even for names like "__proto__" (column names come from the
// database).
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function rejectUnknownKeys(obj, allowed, what) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new MemoryError(`${what} must be an object.`);
  const extra = Object.keys(obj).filter(k => !allowed.includes(k));
  if (extra.length) throw new MemoryError(`${what} has unknown keys: ${extra.join(', ')}.`);
}

// A script path relative to its script root, with / separators; never
// absolute, never leaving the root.
function normalizeScannedPath(value, where, rootLabel = 'script root') {
  if (typeof value !== 'string' || !value.trim()) throw new MemoryError(`${where}.path must be a non-empty string.`);
  const rel = value.trim().replace(/\\/g, '/');
  if (rel.length > maxScannedPath) throw new MemoryError(`${where}.path is longer than ${maxScannedPath} characters.`);
  if (/[\x00-\x1f\x7f]/.test(rel)) throw new MemoryError(`${where}.path contains control characters.`);
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new MemoryError(`${where}.path must be relative to its ${rootLabel}, not absolute.`);
  if (rel.split('/').some(s => s === '' || s === '.' || s === '..')) throw new MemoryError(`${where}.path must not contain empty, "." or ".." segments.`);
  return rel;
}

// Strict check of remember evidenceCode: at most maxEvidenceCode references
// { root, path, line?, symbol? }; root is a configured code root name, path is
// relative to it (no absolute, drive or UNC path, no "." or ".." segments,
// separators normalised to /), line a positive integer, symbol one line.
// Returns the normalized list ([] when absent).
export function validateEvidenceCode(list, codeRoots = null) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new MemoryError('evidenceCode must be an array.');
  if (list.length > maxEvidenceCode) throw new MemoryError(`At most ${maxEvidenceCode} evidenceCode references per note.`);
  const seen = new Set();
  return list.map((ref, i) => {
    const where = `evidenceCode[${i}]`;
    rejectUnknownKeys(ref, ['root', 'path', 'line', 'symbol'], where);
    if (typeof ref.root !== 'string' || !profilePattern.test(ref.root)) throw new MemoryError(`${where}.root must be the name of a configured code root (list_profiles), not a path.`);
    if (codeRoots && !codeRoots.includes(ref.root)) {
      throw new MemoryError(`${where}.root "${ref.root}" is not a configured code root (list_profiles: ${codeRoots.join(', ') || 'none; add "codeRoots" to profiles.json'}).`);
    }
    const rel = normalizeScannedPath(ref.path, where, 'code root');
    const out = { root: ref.root, path: rel };
    if (ref.line !== undefined) {
      if (!Number.isInteger(ref.line) || ref.line < 1 || ref.line > maxCodeLine) throw new MemoryError(`${where}.line must be an integer between 1 and ${maxCodeLine}.`);
      out.line = ref.line;
    }
    if (ref.symbol !== undefined) {
      if (typeof ref.symbol !== 'string' || !ref.symbol.trim()) throw new MemoryError(`${where}.symbol must be a non-empty string.`);
      const symbol = ref.symbol.trim();
      if (/[\x00-\x1f\x7f]/.test(symbol)) throw new MemoryError(`${where}.symbol must be one line without control characters.`);
      if (symbol.length > maxCodeSymbol) throw new MemoryError(`${where}.symbol is longer than ${maxCodeSymbol} characters.`);
      out.symbol = symbol;
    }
    const key = `${out.root}\n${out.path}\n${out.line ?? ''}\n${out.symbol ?? ''}`;
    if (seen.has(key)) throw new MemoryError(`${where} is listed twice.`);
    seen.add(key);
    return out;
  });
}

// Strict check of a score_columns input; the whole call is rejected on the
// first problem. Returns the normalized input.
export function validateScoreInput(input, scriptRoots = null) {
  rejectUnknownKeys(input, ['schema', 'table', 'columns', 'triggers', 'scannedFiles'], 'Input');
  const { schema, table, columns = [], triggers = [], scannedFiles = [] } = input;
  for (const [key, value] of [['schema', schema], ['table', table]]) {
    if (typeof value !== 'string' || !value) throw new MemoryError(`${key} must be a non-empty string.`);
  }
  if (!Array.isArray(columns)) throw new MemoryError('columns must be an array.');
  if (!Array.isArray(triggers)) throw new MemoryError('triggers must be an array.');
  if (!columns.length && !triggers.length) throw new MemoryError('Give at least one entry in columns or triggers.');
  if (columns.length > maxScoredColumns) throw new MemoryError(`At most ${maxScoredColumns} columns per call.`);
  const seen = new Set();
  const roleList = (roles, where) => {
    if (!Array.isArray(roles)) throw new MemoryError(`${where}.roles must be an array (may be empty).`);
    const badRole = roles.find(r => !columnRoles.includes(r));
    if (badRole !== undefined) throw new MemoryError(`${where}.roles: "${badRole}" is not one of ${columnRoles.join(', ')}.`);
    if (new Set(roles).size !== roles.length) throw new MemoryError(`${where}.roles lists a role twice.`);
    return columnRoles.filter(r => roles.includes(r));
  };
  const checkScore = (score, where) => {
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new MemoryError(`${where}.score must be an integer from 1 to 5.`);
  };
  const outColumns = columns.map((c, i) => {
    const where = `columns[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new MemoryError(`${where} must be an object.`);
    const by = c.by ?? (c.clearUser !== undefined ? 'user' : 'agent');
    if (!scoreLayers.includes(by)) throw new MemoryError(`${where}.by must be one of ${scoreLayers.join(', ')}.`);
    if (c.clearUser !== undefined) {
      rejectUnknownKeys(c, ['name', 'by', 'clearUser'], where);
      if (c.clearUser !== true || by !== 'user') throw new MemoryError(`${where}.clearUser must be true and only removes the user score.`);
    } else if (by === 'user') {
      rejectUnknownKeys(c, ['name', 'by', 'score', 'roles'], where);
    } else {
      rejectUnknownKeys(c, ['name', 'by', 'score', 'roles', 'reason', 'sources'], where);
    }
    if (typeof c.name !== 'string' || !c.name) throw new MemoryError(`${where}.name must be a non-empty string.`);
    // One agent and one user entry per column and call.
    if (seen.has(`${by}\n${c.name}`)) throw new MemoryError(`Column ${c.name} is listed twice for ${by}.`);
    seen.add(`${by}\n${c.name}`);
    if (c.clearUser) return { name: c.name, by, clearUser: true };
    checkScore(c.score, where);
    if (by === 'user') return { name: c.name, by, score: c.score, ...(c.roles !== undefined ? { roles: roleList(c.roles, where) } : {}) };
    const roles = roleList(c.roles, where);
    if (typeof c.reason !== 'string' || !c.reason.trim()) throw new MemoryError(`${where}.reason must be a non-empty string.`);
    const reason = c.reason.trim();
    if (/[\r\n]/.test(reason)) throw new MemoryError(`${where}.reason must be one line.`);
    if (reason.length > maxScoreReason) throw new MemoryError(`${where}.reason is longer than ${maxScoreReason} characters.`);
    if (!Number.isInteger(c.sources) || c.sources < 0) throw new MemoryError(`${where}.sources must be an integer >= 0.`);
    return { name: c.name, by, score: c.score, roles, reason, sources: c.sources };
  });
  if (triggers.length > maxTriggerSummaries) throw new MemoryError(`At most ${maxTriggerSummaries} triggers per call.`);
  const seenTriggers = new Set();
  const outTriggers = triggers.map((t, i) => {
    const where = `triggers[${i}]`;
    rejectUnknownKeys(t, ['name', 'summary'], where);
    if (typeof t.name !== 'string' || !t.name) throw new MemoryError(`${where}.name must be a non-empty string.`);
    if (seenTriggers.has(t.name)) throw new MemoryError(`Trigger ${t.name} is listed twice.`);
    seenTriggers.add(t.name);
    if (typeof t.summary !== 'string' || !t.summary.trim()) throw new MemoryError(`${where}.summary must be a non-empty string.`);
    const summary = t.summary.trim();
    if (/[\r\n]/.test(summary)) throw new MemoryError(`${where}.summary must be one line.`);
    if (summary.length > maxTriggerSummary) throw new MemoryError(`${where}.summary is longer than ${maxTriggerSummary} characters.`);
    return { name: t.name, summary };
  });
  if (!Array.isArray(scannedFiles)) throw new MemoryError('scannedFiles must be an array.');
  if (scannedFiles.length > maxScannedFiles) throw new MemoryError(`At most ${maxScannedFiles} scannedFiles per call.`);
  const seenFiles = new Set();
  const outFiles = scannedFiles.map((f, i) => {
    const where = `scannedFiles[${i}]`;
    rejectUnknownKeys(f, ['root', 'path', 'sha256'], where);
    if (typeof f.root !== 'string' || !profilePattern.test(f.root)) throw new MemoryError(`${where}.root must be the name of a configured script root (list_profiles), not a path.`);
    if (scriptRoots && !scriptRoots.includes(f.root)) throw new MemoryError(`${where}.root "${f.root}" is not a configured script root (list_profiles).`);
    const rel = normalizeScannedPath(f.path, where);
    if (typeof f.sha256 !== 'string' || !sha256Pattern.test(f.sha256.toLowerCase())) throw new MemoryError(`${where}.sha256 must be 64 hex characters.`);
    const key = `${f.root}\n${rel}`;
    if (seenFiles.has(key)) throw new MemoryError(`${where} is listed twice.`);
    seenFiles.add(key);
    return { root: f.root, path: rel, sha256: f.sha256.toLowerCase() };
  });
  return { schema, table, columns: outColumns, triggers: outTriggers, scannedFiles: outFiles };
}

// A layer's state before it is replaced, for its history.
function layerHistoryItem(layer) {
  if (layer.cleared) return { cleared: true, at: layer.at };
  return { score: layer.score, ...(layer.reason !== undefined ? { reason: layer.reason } : {}), ...(layer.roles ? { roles: layer.roles } : {}), at: layer.at };
}

const activeUser = entry => (entry?.user && !entry.user.cleared ? entry.user : null);

// The user score wins over the agent score; null when neither is set.
export function effectiveScore(entry) {
  const user = activeUser(entry);
  if (user) return { score: user.score, by: 'user' };
  if (entry?.agent) return { score: entry.agent.score, by: 'agent' };
  return null;
}

// graph.json: the stored layers plus the effective score per column.
function columnScoresView(columnScores) {
  const out = {};
  for (const [column, entry] of Object.entries(columnScores)) {
    const effective = effectiveScore(entry);
    setOwn(out, column, { ...(effective ? { score: effective.score, scoreBy: effective.by } : { score: null }), ...entry });
  }
  return out;
}

// table_knowledge: effective score highest first with both layers, the ids of
// active notes on the column (rules such as the user's usage note), columns
// that left the structure marked, and the columns without any score.
function columnScoresSection(rec, notes = []) {
  if (!rec.columnScores) return {};
  const inStructure = new Set(rec.columns.map(c => c.name));
  const entries = Object.entries(rec.columnScores)
    .map(([column, entry]) => [column, entry, effectiveScore(entry)])
    .sort(([a, , x], [b, , y]) => (y?.score ?? 0) - (x?.score ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([column, entry, effective]) => {
      const noteIds = notes.filter(n => n.column === column).map(n => n.id);
      return {
        column, score: effective?.score ?? null, scoreBy: effective?.by ?? null,
        ...(entry.agent ? { agent: entry.agent } : {}),
        ...(entry.user ? { user: entry.user } : {}),
        ...(noteIds.length ? { noteIds } : {}),
        ...(inStructure.has(column) ? {} : { inStructure: false }),
      };
    });
  return {
    scoredAt: rec.scoredAt,
    columnScores: entries,
    unscoredColumns: rec.columns.filter(c => !effectiveScore(Object.hasOwn(rec.columnScores, c.name) ? rec.columnScores[c.name] : null)).map(c => c.name),
  };
}

// Recorded triggers with the agent's one-line summary (score_columns);
// summaryStale when the trigger definition changed after the summary.
function triggersWithSummaries(rec) {
  const summaries = rec.triggerSummaries ?? {};
  return (rec.triggers ?? []).map(t => {
    const s = Object.hasOwn(summaries, t.name) ? summaries[t.name] : null;
    return {
      ...t,
      ...(s ? { summary: s.summary, summaryAt: s.at, ...(s.definitionHash !== definitionHash(t.definition) ? { summaryStale: true } : {}) } : {}),
    };
  });
}
