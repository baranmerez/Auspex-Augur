// Schema memory: what Auspex has learned about each database, kept in local
// JSON files under <memoryDir>/<profile>/. It grows with the work: a table is
// recorded when describe_table reads it or when a plan touches it, never by
// crawling the catalog. Reading the memory never touches the database.
//
//   tables/<schema>/<table>.json   structure, used columns, change history
//   notes.json                     rules, observations and inferences
//   changelog.jsonl                explored tables and schema changes, for timelines
//   graph.json                     derived view for the viewer and desktop app;
//                                  rebuilt after every change, safe to delete
import crypto from 'node:crypto';
import fs from 'node:fs';
import { withFileLock, renameRetrying } from '../fileLock.js';
import path from 'node:path';
import { splitColumnRef } from './planUsage.js';

export const noteKinds = ['rule', 'observation', 'inference'];
const historyLimit = 50;
const neighborLimit = 10;
const noteLineLimit = 10;
const databaseNoteLimit = 10;
const profilePattern = /^[a-z][a-z0-9_-]{0,39}$/;
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
// never collide on case-insensitive file systems.
export function fileSegment(name) {
  const value = String(name ?? '');
  if (!value) throw new MemoryError('Schema and table names must not be empty.');
  const encoded = value.replace(/[^a-z0-9_-]/g, ch => `~${Buffer.from(ch, 'utf8').toString('hex')}`);
  return reservedFileName.test(encoded) ? `~${encoded}` : encoded;
}

const tableKey = (schema, table) => `${schema}.${table}`;
const sameTable = (a, b) => a.schema === b.schema && a.table === b.table;

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  renameRetrying(tmp, file); // the viewer may be reading the target on Windows
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
  };
}

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
    default: {
      const [what, verb] = [c.change.slice(0, c.change.lastIndexOf('-')), c.change.slice(c.change.lastIndexOf('-') + 1)];
      return `${what.replace('-', ' ')} ${c.name} ${verb}`;
    }
  }
}

function noteLine(n) {
  const target = n.column ? ` ${n.column}` : '';
  const suffix = n.kind === 'observation' && n.asOf ? ` (as of ${n.asOf})` : n.kind === 'inference' ? ' (unconfirmed)' : '';
  return `#${n.id} ${n.kind}${target}: ${n.text}${suffix}`;
}

export class SchemaMemory {
  // approvedJoins(profile) -> [{ left: 'schema.table.column', right: ... }] from
  // approved reports: the "used" relation level.
  constructor(root, { now = () => new Date().toISOString(), approvedJoins = () => [] } = {}) {
    this.root = path.resolve(root);
    this.now = now;
    this.approvedJoins = approvedJoins;
    this.cache = new Map();
  }

  profileDir(profile) {
    if (!profilePattern.test(String(profile || ''))) throw new MemoryError(`Invalid profile name "${profile}".`, 'PROFILE_INVALID');
    return path.join(this.root, profile);
  }

  tablePath(profile, schema, table) {
    return path.join(this.profileDir(profile), 'tables', fileSegment(schema), `${fileSegment(table)}.json`);
  }

  readJson(file, fallback) {
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
    writeFileAtomic(file, `${JSON.stringify(value, null, 1)}\n`);
    this.cache.delete(file);
  }

  readTable(profile, schema, table) {
    return this.readJson(this.tablePath(profile, schema, table), null);
  }

  writeTable(profile, record) {
    this.writeJson(this.tablePath(profile, record.schema, record.table), record);
  }

  listTables(profile) {
    const dir = path.join(this.profileDir(profile), 'tables');
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

  appendChangelog(profile, entry) {
    const file = path.join(this.profileDir(profile), 'changelog.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  readChangelog(profile, limit = 200) {
    const file = path.join(this.profileDir(profile), 'changelog.jsonl');
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

  addNote(profile, { kind, schema, table, column, text, evidence, source }) {
    return this.locked(profile, () => this.addNoteUnlocked(profile, { kind, schema, table, column, text, evidence, source }));
  }

  addNoteUnlocked(profile, { kind, schema, table, column, text, evidence, source }) {
    if (!noteKinds.includes(kind)) throw new MemoryError(`kind must be one of ${noteKinds.join(', ')}.`);
    const body = String(text || '').trim();
    if (!body) throw new MemoryError('Note text is empty.');
    if (body.length > 2000) throw new MemoryError('Note text is longer than 2000 characters.');
    if (!!schema !== !!table) throw new MemoryError('Give both schema and table, or neither for a database-wide note.');
    if (column && !table) throw new MemoryError('A column note needs schema and table.');
    const figures = evidence?.figures;
    if (figures && Object.keys(figures).length > 50) throw new MemoryError('Evidence figures are limited to 50 entries.');
    if (evidence?.sql && evidence.sql.length > 20000) throw new MemoryError('Evidence SQL is longer than 20000 characters.');
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
      const notes = this.activeNotes(profile, [{ schema, table }]).map(n => ({ id: n.id, kind: n.kind, column: n.column, text: n.text }));
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
      notes: notes.map(n => ({ id: n.id, kind: n.kind, column: n.column, text: n.text, ...(n.asOf ? { asOf: n.asOf } : {}), ...(n.evidence?.figures ? { figures: n.evidence.figures } : {}) })),
      recentChanges: (rec.history || []).slice(-5).map(h => `${h.at.slice(0, 10)}: ${h.changes.map(changeText).join('; ')}`),
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
