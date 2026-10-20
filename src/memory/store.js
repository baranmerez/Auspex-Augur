// Schema memory: what Auspex has learned about each database, kept in local
// JSON files under <memoryDir>/<profile>/. It grows with the work: a table is
// recorded when describe_table reads it or when a plan touches it, never by
// crawling the catalog. Reading the memory never touches the database.
//
//   tables/<schema>/<table>.json   structure, used columns, change history
//   notes.json                     rules, observations and inferences
//   changelog.jsonl                explored tables and schema changes, for timelines
//   scanned-files.json             script files read for column scores: path
//                                  relative to its script root, sha256 and
//                                  lastReadAt (never the file contents)
//   graph.json                     derived view for the viewer and desktop app;
//                                  rebuilt after every change, safe to delete
import crypto from 'node:crypto';
import fs from 'node:fs';
import { withFileLock } from '../fileLock.js';
import { writePrivateAtomic, appendPrivate, linkBelow } from '../privateFiles.js';
import path from 'node:path';
import { splitColumnRef } from './planUsage.js';

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

const tableKey = (schema, table) => `${schema}.${table}`;
const sameTable = (a, b) => a.schema === b.schema && a.table === b.table;

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

export class SchemaMemory {
  // approvedJoins(profile) -> [{ left: 'schema.table.column', right: ... }] from
  // approved reports: the "used" relation level.
  constructor(root, { now = () => new Date().toISOString(), approvedJoins = () => [], scannedFilesPerRoot = maxScannedFilesPerRoot } = {}) {
    this.scannedFilesPerRoot = scannedFilesPerRoot;
    this.root = path.resolve(root);
    this.now = now;
    this.approvedJoins = approvedJoins;
    this.cache = new Map();
  }

  // Refuses a memory path whose folders or file below the root are a
  // symbolic link or junction, so no read or write leaves the memory folder.
  // The root itself may be a link (a configured folder).
  checkPath(file) {
    const link = linkBelow(this.root, file);
    if (link) throw new MemoryError(`Schema memory path ${link} is a link or junction; refused.`, 'DISK_ERROR');
    return file;
  }

  profileDir(profile) {
    if (!profilePattern.test(String(profile || ''))) throw new MemoryError(`Invalid profile name "${profile}".`, 'PROFILE_INVALID');
    return this.checkPath(path.join(this.root, profile));
  }

  tablePath(profile, schema, table) {
    return this.checkPath(path.join(this.profileDir(profile), 'tables', fileSegment(schema), `${fileSegment(table)}.json`));
  }

  readJson(file, fallback) {
    this.checkPath(file);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return structuredClone(hit.value);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
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
  writeTable(profile, record) {
    this.writeJson(this.tablePath(profile, record.schema, record.table), record);
    const legacy = this.legacyTablePath(profile, record.schema, record.table);
    if (!legacy) return;
    const old = this.readJson(legacy, null);
    if (old && old.schema === record.schema && old.table === record.table) {
      fs.rmSync(legacy, { force: true });
      this.cache.delete(legacy);
    }
  }

  listTables(profile) {
    const dir = this.checkPath(path.join(this.profileDir(profile), 'tables'));
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const schemaDir of fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory())) {
      for (const f of fs.readdirSync(path.join(dir, schemaDir.name)).filter(f => f.endsWith('.json'))) {
        out.push(this.readJson(path.join(dir, schemaDir.name, f), null));
      }
    }
    return out.filter(Boolean).sort((a, b) => tableKey(a.schema, a.table).localeCompare(tableKey(b.schema, b.table)));
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
  appendChangelog(profile, entry) {
    const file = path.join(this.profileDir(profile), 'changelog.jsonl');
    try {
      appendPrivate(file, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      process.stderr.write(`auspex: schema memory changelog write failed: ${err.message}\n`);
    }
  }

  readChangelog(profile, limit = 200) {
    const file = this.checkPath(path.join(this.profileDir(profile), 'changelog.jsonl'));
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
      this.rebuildViewUnlocked(profile);
      return out;
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
    this.writeTable(profile, record);
    if (firstTime) this.appendChangelog(profile, { at, schema: next.schema, table: next.table, event: 'explored' });
    else if (changes.length) this.appendChangelog(profile, { at, schema: next.schema, table: next.table, event: 'changed', changes });
    if (rebuild) this.rebuildView(profile);
    return {
      recorded: firstTime ? 'first time' : 'updated',
      ...(firstTime ? {} : { lastDescribedAt: prev.describedAt }),
      ...(changes.length ? { changesSinceLast: changes.map(changeText) } : {}),
      ...this.notesSection(profile, [next]),
    };
  }

  // A plan touched these relations: remember that they exist and which columns
  // were used. Relations not described yet stay "seen" (name and usage only).
  recordSeen(profile, relations) {
    return this.locked(profile, () => this.recordSeenUnlocked(profile, relations));
  }

  recordSeenUnlocked(profile, relations) {
    this.touchSeenUnlocked(profile, relations);
    if (relations.length) this.rebuildView(profile);
    return {
      ...this.notesSection(profile, relations),
      ...this.neighborsSection(profile, relations),
    };
  }

  // Writes each relation's record (a "seen" stub when it is new) with
  // lastSeen and used columns; update(record, rel, at) may add more before
  // the write. Does not rebuild the view.
  touchSeenUnlocked(profile, relations, update = null) {
    const at = this.now();
    for (const rel of relations) {
      const prev = this.readTable(profile, rel.schema, rel.table);
      const record = prev ?? {
        schema: rel.schema, table: rel.table, kind: null, oid: null, comment: null, estimatedRows: null,
        columns: [], constraints: [], indexes: [], referencedBy: [], viewHash: null,
        firstSeen: at, describedAt: null, usedColumns: {}, history: [],
      };
      record.lastSeen = at;
      for (const col of rel.columns || []) {
        const used = record.usedColumns[col] ?? { count: 0 };
        record.usedColumns[col] = { count: used.count + 1, lastUsed: at };
      }
      update?.(record, rel, at);
      this.writeTable(profile, record);
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
      });
      this.rebuildViewUnlocked(profile);
      return { explored: new Set([...rels.keys()].filter(key => this.readTable(profile, rels.get(key).schema, rels.get(key).table)?.describedAt)) };
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
    this.writeNotes(profile, data);
    if (note.table) this.appendChangelog(profile, { at, schema: note.schema, table: note.table, event: 'note', noteId: note.id, kind });
    this.rebuildView(profile);
    return note;
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
    this.writeNotes(profile, data);
    this.rebuildView(profile);
    return note;
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
    this.writeNotes(profile, data);
    this.rebuildView(profile);
    return note;
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
      this.writeTable(profile, rec);
      const scanned = scannedFiles.length ? this.recordScannedUnlocked(profile, scannedFiles, at) : null;
      this.rebuildViewUnlocked(profile);
      return {
        relation: tableKey(schema, table),
        scoredAt: at,
        scored: columns.length,
        ...(triggers.length ? { triggersSummarized: triggers.length } : {}),
        unscoredColumns: rec.columns.filter(c => !effectiveScore(Object.hasOwn(scores, c.name) ? scores[c.name] : null)).map(c => c.name),
        ...(scanned ? { scannedFiles: scanned } : {}),
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
    // measurement of an edge wins.
    const measured = (s, from, to, e) => {
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
    const tags = c => [pk.includes(c.name) && 'pk', fkCols.has(c.name) && 'fk', used[c.name] && 'used', noted.has(c.name) && 'note'].filter(Boolean);
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
      state: t.describedAt ? 'explored' : 'seen', kind: t.kind, estimatedRows: t.estimatedRows,
      columnCount: t.columns.length, changes: (t.history || []).length,
      notes: notes.filter(n => n.schema === t.schema && n.table === t.table).length,
      ...(t.estRows !== undefined ? { estRows: t.estRows } : {}),
      ...(t.columnScores ? { scoredAt: t.scoredAt, columnScores: columnScoresView(t.columnScores) } : {}),
      ...(t.triggers?.length ? { triggers: triggersWithSummaries(t) } : {}),
    }]));
    for (const e of edges) {
      for (const id of [e.from, e.to]) {
        if (nodes.has(id)) continue;
        const dot = id.indexOf('.');
        nodes.set(id, { id, schema: id.slice(0, dot), table: id.slice(dot + 1), state: 'unexplored', kind: null, estimatedRows: null, columnCount: 0, changes: 0, notes: 0 });
      }
    }
    return { profile, nodes: [...nodes.values()], edges };
  }

  // Everything the viewer shows for one profile, in one file the viewer and
  // the desktop app read as is (no relation logic outside this module).
  view(profile) {
    const { nodes, edges } = this.graph(profile);
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
      nodes, edges, notes, changelog,
    };
  }

  rebuildView(profile) {
    return this.locked(profile, () => this.rebuildViewUnlocked(profile));
  }

  rebuildViewUnlocked(profile) {
    this.writeJson(path.join(this.profileDir(profile), 'graph.json'), this.view(profile));
  }
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
