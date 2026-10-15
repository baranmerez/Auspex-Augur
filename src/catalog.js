import { ToolError } from './errors.js';

// Catalog queries used for browsing. They are fixed, parameterized SQL and run
// inside the same READ ONLY transaction wrapper as user queries.

const listSchemasSql = `
select n.nspname as schema,
       pg_get_userbyid(n.nspowner) as owner,
       has_schema_privilege(n.oid, 'USAGE') as can_use,
       (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p','v','m','f')) as relations,
       obj_description(n.oid, 'pg_namespace') as comment
from pg_namespace n
where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
order by n.nspname`;

const listTablesSql = `
select c.relname as name,
       case c.relkind when 'r' then 'table' when 'p' then 'partitioned' when 'v' then 'view'
                      when 'm' then 'matview' when 'f' then 'foreign' end as kind,
       case when c.reltuples < 0 then null else c.reltuples::bigint end as estimated_rows, -- -1 = never analyzed
       pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
       has_table_privilege(c.oid, 'SELECT') as can_select,
       obj_description(c.oid, 'pg_class') as comment
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1
  and c.relkind in ('r','p','v','m','f')
  and not c.relispartition
  and ($2::text is null or c.relname ilike $2)
order by c.relname
limit 1000`;

// One row per requested name (schema and name arrays, in order); oid is null
// when the relation does not exist.
const relationsByNameSql = `
select r.ord::int as ord, c.oid::bigint as oid, c.relkind,
       case when c.reltuples < 0 then null else c.reltuples::bigint end as estimated_rows, -- -1 = never analyzed
       obj_description(c.oid, 'pg_class') as comment
from unnest($1::text[], $2::text[]) with ordinality as r(schema, name, ord)
left join pg_namespace n on n.nspname = r.schema
left join pg_class c on c.relnamespace = n.oid and c.relname = r.name
order by r.ord`;

const relationKinds = { r: 'table', p: 'partitioned', v: 'view', m: 'matview', f: 'foreign' };

// The describe queries below take an array of relation oids ($1), so one
// statement covers any number of tables; relid tells the rows apart.
const columnsSql = `
select a.attrelid::bigint as relid,
       a.attname as column,
       a.attnum,
       format_type(a.atttypid, a.atttypmod) as type,
       a.attnotnull as not_null,
       pg_get_expr(d.adbin, d.adrelid) as default,
       has_column_privilege(a.attrelid, a.attnum, 'SELECT') as can_select,
       col_description(a.attrelid, a.attnum) as comment
from pg_attribute a
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped
order by a.attrelid, a.attnum`;

// Key columns and the referenced table are returned explicitly: the text of
// pg_get_constraintdef omits the schema when it is on the search_path.
const keyColumns = (keys, rel) => `(select array_agg(a.attname::text order by k.ord)
        from unnest(${keys}) with ordinality k(attnum, ord)
        join pg_attribute a on a.attrelid = ${rel} and a.attnum = k.attnum)`;

const constraintsSql = `
select con.conrelid::bigint as relid,
       con.conname as name,
       case con.contype when 'p' then 'primary key' when 'u' then 'unique' when 'f' then 'foreign key'
                        when 'c' then 'check' when 'x' then 'exclusion' else con.contype::text end as type,
       pg_get_constraintdef(con.oid) as definition,
       ${keyColumns('con.conkey', 'con.conrelid')} as columns,
       fn.nspname as ref_schema,
       fc.relname as ref_table,
       ${keyColumns('con.confkey', 'con.confrelid')} as ref_columns
from pg_constraint con
left join pg_class fc on fc.oid = con.confrelid
left join pg_namespace fn on fn.oid = fc.relnamespace
where con.conrelid = any($1::oid[])
order by con.conrelid, con.contype, con.conname`;

const indexesSql = `
select x.indrelid::bigint as relid, i.relname as name, pg_get_indexdef(x.indexrelid) as definition
from pg_index x join pg_class i on i.oid = x.indexrelid
where x.indrelid = any($1::oid[])
order by x.indrelid, i.relname`;

const referencedBySql = `
select con.confrelid::bigint as relid,
       n.nspname || '.' || c.relname as from_table,
       n.nspname as from_schema,
       c.relname as from_name,
       con.conname as name,
       pg_get_constraintdef(con.oid) as definition,
       ${keyColumns('con.conkey', 'con.conrelid')} as columns,
       ${keyColumns('con.confkey', 'con.confrelid')} as ref_columns
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where con.contype = 'f' and con.confrelid = any($1::oid[])
order by con.confrelid, 2, 3`;

const viewDefinitionsSql = `
select c.oid::bigint as relid, pg_get_viewdef(c.oid, true) as definition
from pg_class c
where c.oid = any($1::oid[]) and c.relkind in ('v', 'm')`;

// Searches relation names, column names and their comments across all
// non-system schemas (or one schema). $1 = ILIKE pattern, $2 = schema or null,
// $3 = include columns.
const searchSql = `
with rel as (
  select c.oid, n.nspname, c.relname,
         case c.relkind when 'r' then 'table' when 'p' then 'partitioned' when 'v' then 'view'
                        when 'm' then 'matview' when 'f' then 'foreign' end as kind,
         case when c.reltuples < 0 then null else c.reltuples::bigint end as estimated_rows, -- -1 = never analyzed
         has_table_privilege(c.oid, 'SELECT') as can_select,
         obj_description(c.oid, 'pg_class') as comment
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r','p','v','m','f')
    and not c.relispartition
    and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
    and ($2::text is null or n.nspname = $2)
)
select 'relation' as match, nspname as schema, relname as relation, null::text as column,
       kind, estimated_rows, can_select, comment
from rel
where relname ilike $1 or comment ilike $1
union all
select 'column', r.nspname, r.relname, a.attname, format_type(a.atttypid, a.atttypmod),
       r.estimated_rows, has_column_privilege(r.oid, a.attnum, 'SELECT'), col_description(r.oid, a.attnum)
from rel r
join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
where $3 and (a.attname ilike $1 or col_description(r.oid, a.attnum) ilike $1)
order by 1 desc, 2, 3, 4
limit 501`;

// Plain words become a contains-match; a pattern with % or _ is used as given.
export function toIlikePattern(text) {
  const value = String(text || '').trim();
  if (!value) throw new ToolError('INVALID_INPUT', 'Search text is empty.');
  return /[%_]/.test(value) ? value : `%${value}%`;
}

export async function search(db, profile, text, schema, includeColumns = true) {
  return db.audited('search', { profile: profile ?? null, text, schema: schema || null, includeColumns }, () => searchImpl(db, profile, text, schema, includeColumns));
}

async function searchImpl(db, profile, text, schema, includeColumns) {
  const pattern = toIlikePattern(text);
  return db.withReadOnly(profile, async (client, name) => {
    const res = await client.query(searchSql, [pattern, schema || null, includeColumns]);
    const truncated = res.rows.length > 500;
    const rows = truncated ? res.rows.slice(0, 500) : res.rows;
    return {
      profile: name,
      pattern,
      relations: rows.filter(r => r.match === 'relation').map(({ match, column, ...r }) => r),
      columns: rows.filter(r => r.match === 'column').map(({ match, kind, ...r }) => ({ ...r, type: kind })),
      truncated,
    };
  });
}

export async function listSchemas(db, profile) {
  return db.audited('list_schemas', { profile: profile ?? null }, () => db.withReadOnly(profile, async (client, name) => {
    const res = await client.query(listSchemasSql);
    return { profile: name, schemas: res.rows, rowCount: res.rows.length };
  }));
}

export async function listTables(db, profile, schema, pattern) {
  return db.audited('list_tables', { profile: profile ?? null, schema, pattern: pattern || null }, () => db.withReadOnly(profile, async (client, name) => {
    const res = await client.query(listTablesSql, [schema, pattern || null]);
    return { profile: name, schema, tables: res.rows, rowCount: res.rows.length, truncated: res.rows.length === 1000 };
  }));
}

// ---------- many tables in a constant number of statements ----------

export const maxDescribeTables = 50;
export const maxProfileTables = 30;
export const defaultSampleRows = 20000;
export const maxSampleRows = 200000;

// Names come from the model. A name part may not contain quotes, semicolons,
// dots, colons, backslashes, whitespace or control characters; every name is
// also looked up in the catalog before it is used in generated SQL, and only
// the catalog's spelling is quoted into it.
const namePart = String.raw`[^\s"'.;:\\\u0000-\u001f\u007f]+`;
const tableRefPattern = new RegExp(`^(${namePart})\\.(${namePart})(?::(${namePart}))?$`, 'u');
const namePattern = new RegExp(`^${namePart}$`, 'u');
const nameRule = 'quotes, semicolons, dots, colons, backslashes and whitespace are not allowed in names';

// "schema.table", or "schema.table:column" when allowColumn is set.
export function parseTableRef(text, { allowColumn = false } = {}) {
  const m = tableRefPattern.exec(String(text ?? '').trim());
  if (!m || (m[3] !== undefined && !allowColumn)) {
    throw new ToolError('INVALID_INPUT', `Invalid table "${text}": use schema.table${allowColumn ? ' or schema.table:column' : ''}; ${nameRule}.`);
  }
  return m[3] === undefined ? { schema: m[1], table: m[2] } : { schema: m[1], table: m[2], column: m[3] };
}

export function checkName(text, what) {
  const value = String(text ?? '').trim();
  if (!namePattern.test(value)) throw new ToolError('INVALID_INPUT', `Invalid ${what} "${text}": ${nameRule}.`);
  return value;
}

// Quotes an identifier. Only applied to names read back from the catalog.
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

const relationName = r => `${r.schema}.${r.table}`;
const toNumber = v => (v === null || v === undefined ? null : Number(v));

function groupByRelid(rows) {
  const out = new Map();
  for (const { relid, ...row } of rows) {
    const key = String(relid);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

// Describes refs ([{ schema, table }]) with 5 catalog statements, 6 when one
// of them is a view or materialized view, however many refs there are.
// Returns one entry per ref, in order: the describe_table structure, or
// { relation, schema, table, error } when the relation does not exist.
async function describeRelations(client, name, refs) {
  let statements = 0;
  const run = async (sql, params) => {
    statements++;
    return (await client.query(sql, params)).rows;
  };
  const rels = await run(relationsByNameSql, [refs.map(r => r.schema), refs.map(r => r.table)]);
  const byOrd = new Map(rels.map(r => [Number(r.ord), r]));
  const oids = rels.filter(r => r.oid !== null && r.oid !== undefined).map(r => String(r.oid));
  let columns = new Map();
  let constraints = new Map();
  let indexes = new Map();
  let referencedBy = new Map();
  let views = new Map();
  if (oids.length) {
    columns = groupByRelid(await run(columnsSql, [oids]));
    constraints = groupByRelid(await run(constraintsSql, [oids]));
    indexes = groupByRelid(await run(indexesSql, [oids]));
    referencedBy = groupByRelid(await run(referencedBySql, [oids]));
    if (rels.some(r => r.relkind === 'v' || r.relkind === 'm')) {
      views = new Map((await run(viewDefinitionsSql, [oids])).map(r => [String(r.relid), r.definition]));
    }
  }
  const tables = refs.map((ref, i) => {
    const rel = byOrd.get(i + 1);
    if (!rel || rel.oid === null || rel.oid === undefined) {
      return { relation: relationName(ref), schema: ref.schema, table: ref.table, error: `Relation ${relationName(ref)} not found.` };
    }
    const key = String(rel.oid);
    const result = {
      profile: name,
      relation: relationName(ref),
      schema: ref.schema,
      table: ref.table,
      kind: relationKinds[rel.relkind] ?? rel.relkind,
      oid: Number(rel.oid),
      estimated_rows: toNumber(rel.estimated_rows),
      comment: rel.comment,
      columns: columns.get(key) ?? [],
      constraints: constraints.get(key) ?? [],
      indexes: indexes.get(key) ?? [],
      referencedBy: referencedBy.get(key) ?? [],
    };
    if (views.has(key)) result.viewDefinition = views.get(key);
    return result;
  });
  return { tables, statements };
}

export async function describeTable(db, profile, schema, table) {
  return db.audited('describe_table', { profile: profile ?? null, schema, table }, () => db.withReadOnly(profile, async (client, name) => {
    const [result] = (await describeRelations(client, name, [{ schema, table }])).tables;
    if (result.error) throw new ToolError('NOT_FOUND', result.error);
    return result;
  }));
}

const uniqueTrimmed = list => [...new Set(list.map(t => String(t ?? '').trim()))];

// describe_tables: every listed relation in one READ ONLY transaction with a
// constant number of catalog statements (see describeRelations). Invalid or
// unknown names are reported per table.
export async function describeTables(db, profile, tables) {
  const list = Array.isArray(tables) ? uniqueTrimmed(tables) : [];
  return db.audited('describe_tables', { profile: profile ?? null, tables: list }, () => {
    if (list.length < 1 || list.length > maxDescribeTables) throw new ToolError('INVALID_INPUT', `tables must list 1 to ${maxDescribeTables} relations as schema.table.`);
    return db.withReadOnly(profile, async (client, name) => {
      const parsed = list.map(text => {
        try {
          return parseTableRef(text);
        } catch (err) {
          return { input: text, error: err.message };
        }
      });
      const valid = parsed.filter(p => !p.error);
      const described = valid.length ? await describeRelations(client, name, valid) : { tables: [], statements: 0 };
      let next = 0;
      const results = parsed.map(p => (p.error ? { relation: p.input, error: p.error } : described.tables[next++]));
      const found = results.filter(r => !r.error).length;
      return { profile: name, tables: results, found, notFound: results.length - found, statements: described.statements };
    });
  }, r => ({ statements: r.statements, found: r.found, notFound: r.notFound }));
}

// Catalog facts profile_tables needs for every requested relation (and the
// parent), in one statement: columns with their base type and SELECT
// privilege, and outgoing single- or multi-column foreign keys.
const profileCatalogSql = `
select r.ord::int as ord, c.oid::bigint as oid, c.relkind, n.nspname as schema_name, c.relname as rel_name,
       case when c.reltuples < 0 then null else c.reltuples::bigint end as estimated_rows, -- -1 = never analyzed
       has_table_privilege(c.oid, 'SELECT') as can_select,
       (select coalesce(jsonb_agg(jsonb_build_object(
                 'name', a.attname,
                 'type', format_type(a.atttypid, a.atttypmod),
                 'baseType', case when t.typtype = 'd' then t.typbasetype else a.atttypid end,
                 'canSelect', has_column_privilege(c.oid, a.attnum, 'SELECT')) order by a.attnum), '[]'::jsonb)
        from pg_attribute a join pg_type t on t.oid = a.atttypid
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
       (select coalesce(jsonb_agg(jsonb_build_object(
                 'name', con.conname,
                 'refOid', con.confrelid::bigint,
                 'columns', ${keyColumns('con.conkey', 'con.conrelid')},
                 'refColumns', ${keyColumns('con.confkey', 'con.confrelid')}) order by con.conname), '[]'::jsonb)
        from pg_constraint con
        where con.conrelid = c.oid and con.contype = 'f') as foreign_keys
from unnest($1::text[], $2::text[]) with ordinality as r(schema, name, ord)
left join pg_namespace n on n.nspname = r.schema
left join pg_class c on c.relnamespace = n.oid and c.relname = r.name and c.relkind in ('r', 'p', 'v', 'm', 'f')
order by r.ord`;

// A column given as schema.table:column is compared with the parent key
// without a foreign key; the base types must match or share a family.
const typeFamilies = [new Set([20, 21, 23, 1700]), new Set([19, 25, 1042, 1043])];
const comparableTypes = (a, b) => Number(a) === Number(b) || typeFamilies.some(f => f.has(Number(a)) && f.has(Number(b)));

export const samplingNote = 'Column statistics are computed on a sample of at most sampleRows rows per table. '
  + 'A table, partitioned table or materialized view whose estimated rows exceed sampleRows is read with TABLESAMPLE SYSTEM '
  + '(random pages, percent sized to about 1.2 x sampleRows) plus LIMIT sampleRows (sample.method "tablesample"); '
  + 'any other relation, or one with unknown or smaller estimates, is read with a plain LIMIT sampleRows scan '
  + '(sample.method "limit": the first rows the scan returns, not random). fillRate = non-null share of the sample; '
  + 'distinctInSample = count(distinct value::text) within the sample, a lower bound for the whole table.';

function validateProfileArgs({ tables, parent, window, sampleRows }) {
  const list = Array.isArray(tables) ? uniqueTrimmed(tables) : [];
  if (list.length < 1 || list.length > maxProfileTables) throw new ToolError('INVALID_INPUT', `tables must list 1 to ${maxProfileTables} relations as schema.table.`);
  const refs = list.map(text => ({ input: text, ...parseTableRef(text, { allowColumn: true }) }));
  let parentRef = null;
  if (parent) {
    parentRef = { ...parseTableRef(parent.table), key: checkName(parent.key, 'parent key column') };
  } else if (refs.some(r => r.column !== undefined)) {
    throw new ToolError('INVALID_INPUT', 'schema.table:column names the fan-out column to the parent; give parent as well.');
  }
  let win = null;
  if (window) {
    if (!parentRef) throw new ToolError('INVALID_INPUT', 'window filters the parent table; give parent as well.');
    if (typeof window.from !== 'string' || typeof window.to !== 'string' || !window.from || !window.to) throw new ToolError('INVALID_INPUT', 'window needs from and to.');
    win = { column: checkName(window.column, 'window column'), from: window.from, to: window.to };
  }
  const rows = sampleRows ?? defaultSampleRows;
  if (!Number.isInteger(rows) || rows < 1 || rows > maxSampleRows) throw new ToolError('INVALID_INPUT', `sampleRows must be an integer from 1 to ${maxSampleRows}.`);
  return { refs, parentRef, win, rows };
}

function sampleSource(rel, readable, sampleRows) {
  const from = `${quoteIdent(rel.schema_name)}.${quoteIdent(rel.rel_name)}`;
  const cols = readable.map(c => quoteIdent(c.name)).join(', ');
  const estimated = toNumber(rel.estimated_rows);
  if (['r', 'p', 'm'].includes(rel.relkind) && estimated !== null && estimated > sampleRows) {
    const percent = Number(Math.min(100, Math.max(0.0001, (sampleRows / estimated) * 120)).toFixed(4));
    return { sql: `select ${cols} from ${from} tablesample system (${percent}) limit $1`, sample: { method: 'tablesample', percent } };
  }
  return { sql: `select ${cols} from ${from} limit $1`, sample: { method: 'limit' } };
}

// Finds the child column that points at the parent key: the given column, or
// the single-column foreign key to parent(key).
function fanOutColumn(rel, ref, parentRel, parentKey) {
  const byName = new Map(rel.columns.map(c => [c.name, c]));
  if (ref.column !== undefined) {
    const col = byName.get(ref.column);
    if (!col) return { error: `Column ${ref.column} not found in ${relationName(ref)}.` };
    if (!col.canSelect) return { error: `No SELECT privilege on ${relationName(ref)}.${ref.column}.` };
    if (!comparableTypes(col.baseType, parentKey.baseType)) return { error: `Column ${ref.column} (${col.type}) cannot be compared with the parent key (${parentKey.type}).` };
    return { column: col.name, via: 'given column' };
  }
  const fks = rel.foreign_keys.filter(fk => String(fk.refOid) === String(parentRel.oid) && fk.columns?.length === 1 && fk.refColumns?.[0] === parentKey.name);
  if (!fks.length) return { error: `No single-column foreign key from ${relationName(ref)} to the parent key; give the column as ${relationName(ref)}:column.` };
  if (fks.length > 1) return { error: `Several foreign keys to the parent key (${fks.map(fk => fk.columns[0]).join(', ')}); give one as ${relationName(ref)}:column.` };
  const col = byName.get(fks[0].columns[0]);
  if (!col?.canSelect) return { error: `No SELECT privilege on ${relationName(ref)}.${fks[0].columns[0]}.` };
  return { column: col.name, via: `foreign key ${fks[0].name}` };
}

const ratio = (a, b) => (b ? Number((a / b).toFixed(4)) : null);

// profile_tables: estimated rows, per-column fill rate and distinct count on a
// sample and, with a parent, fan-out over the parent rows in the window. All
// tables together take at most 3 statements in one READ ONLY transaction:
// 1 catalog lookup, 1 column-statistics statement (UNION ALL over the
// tables), and 1 fan-out statement (UNION ALL) when parent is given. Only
// counts and ratios are returned, never row values.
export async function profileTables(db, profile, { tables, parent, window, sampleRows, timeoutSeconds } = {}) {
  const details = {
    profile: profile ?? null, tables, parent: parent ?? undefined, window: window ?? undefined, sampleRows, timeoutSeconds,
  };
  return db.audited('profile_tables', details, () => {
    const { refs, parentRef, win, rows } = validateProfileArgs({ tables, parent, window, sampleRows });
    return db.withReadOnly(profile, async (client, name) => {
      let statements = 0;
      const lookups = parentRef ? [...refs, parentRef] : refs;
      statements++;
      const catalog = (await client.query(profileCatalogSql, [lookups.map(r => r.schema), lookups.map(r => r.table)])).rows;
      const byOrd = new Map(catalog.map(r => [Number(r.ord), r]));
      const found = i => {
        const rel = byOrd.get(i + 1);
        return rel && rel.oid !== null && rel.oid !== undefined ? rel : null;
      };

      let parentRel = null;
      let parentKey = null;
      let windowColumn = null;
      if (parentRef) {
        parentRel = found(refs.length);
        if (!parentRel) throw new ToolError('NOT_FOUND', `Parent ${relationName(parentRef)} not found (or not a table, view, materialized view or foreign table).`);
        const cols = new Map(parentRel.columns.map(c => [c.name, c]));
        parentKey = cols.get(parentRef.key);
        if (!parentKey) throw new ToolError('NOT_FOUND', `Parent key column ${parentRef.key} not found in ${relationName(parentRef)}.`);
        if (!parentKey.canSelect) throw new ToolError('PERMISSION_DENIED', `No SELECT privilege on ${relationName(parentRef)}.${parentRef.key}.`);
        if (win) {
          windowColumn = cols.get(win.column);
          if (!windowColumn) throw new ToolError('NOT_FOUND', `Window column ${win.column} not found in ${relationName(parentRef)}.`);
          if (!windowColumn.canSelect) throw new ToolError('PERMISSION_DENIED', `No SELECT privilege on ${relationName(parentRef)}.${win.column}.`);
        }
      }

      const entries = refs.map((ref, i) => {
        const rel = found(i);
        const relation = relationName(ref);
        if (!rel) return { relation, error: `Relation ${relation} not found (or not a table, view, materialized view or foreign table).` };
        const readable = rel.columns.filter(c => c.canSelect);
        if (!readable.length) return { relation, error: `No SELECT privilege on ${relation}.` };
        const entry = { relation, ref, rel, readable, source: sampleSource(rel, readable, rows) };
        if (parentRel) {
          entry.fanOut = String(rel.oid) === String(parentRel.oid) ? { skipped: 'this is the parent table' } : fanOutColumn(rel, ref, parentRel, parentKey);
        }
        return entry;
      });
      const measured = entries.filter(e => !e.error);

      const stats = new Map();
      if (measured.length) {
        const branches = measured.map((e, i) => {
          const cols = e.readable.map(c => quoteIdent(c.name));
          return `select ${i} as i, count(*) as sampled,
       array[${cols.map(c => `count(${c})`).join(', ')}]::bigint[] as filled,
       array[${cols.map(c => `count(distinct ${c}::text)`).join(', ')}]::bigint[] as distinct_values
from (${e.source.sql}) auspex_sample`;
        });
        statements++;
        const res = await db.guardedQuery(client, branches.join('\nunion all\n'), [rows]);
        for (const r of res.rows) stats.set(Number(r.i), r);
      }

      const fanOuts = new Map();
      const linked = measured.filter(e => e.fanOut?.column);
      if (parentRel && linked.length) {
        const key = quoteIdent(parentKey.name);
        const parentFrom = `${quoteIdent(parentRel.schema_name)}.${quoteIdent(parentRel.rel_name)}`;
        const filter = windowColumn ? ` and ${quoteIdent(windowColumn.name)} >= $2 and ${quoteIdent(windowColumn.name)} < $3` : '';
        const branches = linked.map((e, i) => {
          const fk = quoteIdent(e.fanOut.column);
          const childFrom = `${quoteIdent(e.rel.schema_name)}.${quoteIdent(e.rel.rel_name)}`;
          return `select ${i} as i, (select count(*) from auspex_parent) as parent_rows,
       count(*) as parents_with_children, coalesce(sum(n), 0) as child_rows, max(n) as max_per_parent
from (select ${fk} as k, count(*) as n from ${childFrom} where ${fk} in (select auspex_parent.k from auspex_parent) group by ${fk}) auspex_children`;
        });
        const sql = `with auspex_parent as (
  select distinct ${key} as k from ${parentFrom} where ${key} is not null${filter} limit $1
)
${branches.join('\nunion all\n')}`;
        statements++;
        const res = await db.guardedQuery(client, sql, win ? [rows, win.from, win.to] : [rows]);
        for (const r of res.rows) fanOuts.set(linked[Number(r.i)], r);
      }

      const results = entries.map(e => {
        if (e.error) return { relation: e.relation, error: e.error };
        const s = stats.get(measured.indexOf(e));
        const sampled = toNumber(s?.sampled) ?? 0;
        const out = {
          relation: e.relation,
          kind: relationKinds[e.rel.relkind] ?? e.rel.relkind,
          estimated_rows: toNumber(e.rel.estimated_rows),
          sample: { ...e.source.sample, rows: sampled },
          columns: e.readable.map((c, j) => ({
            column: c.name,
            type: c.type,
            fillRate: ratio(toNumber(s?.filled?.[j]) ?? 0, sampled),
            distinctInSample: toNumber(s?.distinct_values?.[j]),
          })),
        };
        const hidden = e.rel.columns.filter(c => !c.canSelect).map(c => c.name);
        if (hidden.length) out.columnsWithoutPrivilege = hidden;
        if (e.fanOut) {
          const f = fanOuts.get(e);
          if (!f) {
            out.fanOut = e.fanOut;
          } else {
            const parentRows = toNumber(f.parent_rows);
            const withChildren = toNumber(f.parents_with_children);
            const childRows = toNumber(f.child_rows);
            out.fanOut = {
              column: e.fanOut.column,
              via: e.fanOut.via,
              parentRows,
              parentRowsCapped: parentRows >= rows,
              parentsWithChildren: withChildren,
              childRows,
              avgPerParent: ratio(childRows, parentRows),
              avgPerParentWithChildren: ratio(childRows, withChildren),
              maxPerParent: toNumber(f.max_per_parent) ?? 0,
            };
          }
        }
        return out;
      });

      return {
        profile: name,
        sampleRows: rows,
        sampling: samplingNote,
        ...(parentRef ? {
          parent: {
            relation: relationName(parentRef),
            key: parentRef.key,
            ...(win ? { window: { ...win, rule: `${win.from} <= ${win.column} < ${win.to}` } } : {}),
            note: `Fan-out covers at most ${rows} distinct parent keys (parentRowsCapped tells when the cap was hit).`,
          },
        } : {}),
        statements,
        tables: results,
      };
    }, timeoutSeconds);
  }, r => ({ statements: r.statements }));
}

// ---------- relation_stats: neighbours ranked by statistics ----------

export const maxRelationStatsTables = 50;

// For each center relation, its foreign keys in both directions: instance =
// a table the center references, dependent = a table that references the
// center. A self-reference is listed in both roles. Constraints cloned onto
// partitions (conparentid <> 0) are left out; the parent's constraint stands
// for them. $3 limits the neighbours to one schema.
const relationStatsCatalogSql = `
select r.ord::int as ord, c.oid::bigint as oid, c.relkind,
       case when c.reltuples < 0 then null else c.reltuples::bigint end as est_rows, -- -1 = never analyzed
       has_table_privilege(c.oid, 'SELECT') as can_select,
       (select coalesce(jsonb_agg(jsonb_build_object(
                 'role', k.role,
                 'constraint', con.conname,
                 'schema', on_.nspname,
                 'table', oc.relname,
                 'relkind', oc.relkind,
                 'estRows', case when oc.reltuples < 0 then null else oc.reltuples::bigint end,
                 'canSelect', has_table_privilege(oc.oid, 'SELECT'),
                 'columns', ${keyColumns('con.conkey', 'con.conrelid')},
                 'refColumns', ${keyColumns('con.confkey', 'con.confrelid')}) order by k.role, on_.nspname, oc.relname, con.conname), '[]'::jsonb)
        from pg_constraint con
        cross join lateral (values ('instance'), ('dependent')) as k(role)
        join pg_class oc on oc.oid = case k.role when 'instance' then con.confrelid else con.conrelid end
        join pg_namespace on_ on on_.oid = oc.relnamespace
        where con.contype = 'f' and con.conparentid = 0
          and case k.role when 'instance' then con.conrelid else con.confrelid end = c.oid
          and ($3::text is null or on_.nspname = $3)) as edges
from unnest($1::text[], $2::text[]) with ordinality as r(schema, name, ord)
left join pg_namespace n on n.nspname = r.schema
left join pg_class c on c.relnamespace = n.oid and c.relname = r.name and c.relkind in ('r', 'p', 'v', 'm', 'f')
order by r.ord`;

// null_frac of the requested columns. pg_stats only shows columns the role
// may read (and hides tables whose row security applies to the role). A
// partitioned table only has statistics over its partitions (inherited).
const relationStatsNullFracSql = `
select r.ord::int as ord, s.null_frac
from unnest($1::text[], $2::text[], $3::text[], $4::boolean[]) with ordinality as r(schema, tbl, col, inh, ord)
left join pg_stats s on s.schemaname = r.schema and s.tablename = r.tbl and s.attname = r.col and s.inherited = r.inh
order by r.ord`;

export const relationStatsNote = 'Estimates from planner statistics only; no table is read. linkedRows = estimated rows of the referencing table '
  + '(the dependent table, or the center for an instance table) x (1 - null_frac of its foreign key column; for a multi-column key the '
  + 'largest null_frac, so an upper bound). linkedRows is null with stats "missing" when the referencing table was never analyzed '
  + '(reltuples < 0) or pg_stats has no row for a key column: pg_stats only shows columns the role may read, hides tables whose row '
  + 'security applies to the role, and a partitioned table has statistics only after ANALYZE on the parent (autovacuum does not analyze it). '
  + 'Relations without SELECT privilege are not listed, only counted in hidden.';

// Rows linking through one foreign key, from the referencing table's row
// estimate and the null_frac of its key columns; null when any is unknown.
export function linkedRowsEstimate(estRows, nullFracs) {
  if (estRows === null || estRows === undefined || !nullFracs.length || nullFracs.some(f => f === null || f === undefined)) {
    return { linkedRows: null, stats: 'missing' };
  }
  const worst = Math.min(1, Math.max(0, ...nullFracs.map(Number)));
  return { linkedRows: Math.round(Number(estRows) * (1 - worst)), stats: 'ok' };
}

// linkedRows desc, then the table's estimated rows desc (unknown last), then
// by name. Equal figures share a rank (1, 2, 2, 4).
export function rankNeighbours(items) {
  const desc = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);
  const sorted = [...items].sort((a, b) => desc(a.linkedRows, b.linkedRows) || desc(a.tableEstRows, b.tableEstRows)
    || a.relation.localeCompare(b.relation) || a.constraint.localeCompare(b.constraint));
  let rank = 0;
  return sorted.map((item, i) => {
    const prev = sorted[i - 1];
    if (!prev || prev.linkedRows !== item.linkedRows || prev.tableEstRows !== item.tableEstRows) rank = i + 1;
    return { ...item, rank };
  });
}

// relation_stats: for up to 50 centers, the instance and dependent tables
// ranked by estimated linked rows. At most 2 catalog statements in one READ
// ONLY transaction (relations and foreign keys, then pg_stats), however many
// centers and neighbours; field statements.
export async function relationStats(db, profile, tables, schema) {
  const list = Array.isArray(tables) ? uniqueTrimmed(tables) : [];
  return db.audited('relation_stats', { profile: profile ?? null, tables: list, schema: schema || null }, () => {
    if (list.length < 1 || list.length > maxRelationStatsTables) throw new ToolError('INVALID_INPUT', `tables must list 1 to ${maxRelationStatsTables} relations as schema.table.`);
    return db.withReadOnly(profile, async (client, name) => {
      const parsed = list.map(text => {
        try {
          return parseTableRef(text);
        } catch (err) {
          return { input: text, error: err.message };
        }
      });
      const valid = parsed.filter(p => !p.error);
      let statements = 0;
      let catalog = [];
      if (valid.length) {
        statements++;
        catalog = (await client.query(relationStatsCatalogSql, [valid.map(r => r.schema), valid.map(r => r.table), schema || null])).rows;
      }
      const byOrd = new Map(catalog.map(r => [Number(r.ord), r]));

      const centers = valid.map((ref, i) => {
        const rel = byOrd.get(i + 1);
        const relation = relationName(ref);
        if (!rel || rel.oid === null || rel.oid === undefined) return { relation, error: `Relation ${relation} not found (or not a table, view, materialized view or foreign table).` };
        if (!rel.can_select) return { relation, error: `No SELECT privilege on ${relation}; its relations are not shown.` };
        const hidden = { instance: 0, dependent: 0 };
        const edges = [];
        for (const e of rel.edges ?? []) {
          if (e.canSelect) edges.push(e);
          else hidden[e.role]++;
        }
        return { ref, rel, relation, hidden, edges };
      });

      // One null_frac lookup per referencing (table, column), shared by edges.
      const lookups = new Map();
      const lookup = (s, t, relkind, column) => {
        const key = JSON.stringify([s, t, column, relkind === 'p']);
        if (!lookups.has(key)) lookups.set(key, { schema: s, table: t, column, inherited: relkind === 'p', ord: lookups.size + 1 });
        return lookups.get(key);
      };
      for (const c of centers.filter(c => !c.error)) {
        for (const e of c.edges) {
          const [s, t, relkind] = e.role === 'instance' ? [c.ref.schema, c.ref.table, c.rel.relkind] : [e.schema, e.table, e.relkind];
          e.lookups = (e.columns ?? []).map(column => lookup(s, t, relkind, column));
        }
      }
      const nullFrac = new Map();
      if (lookups.size) {
        const req = [...lookups.values()];
        statements++;
        const res = await client.query(relationStatsNullFracSql, [req.map(r => r.schema), req.map(r => r.table), req.map(r => r.column), req.map(r => r.inherited)]);
        for (const r of res.rows) nullFrac.set(Number(r.ord), r.null_frac === null || r.null_frac === undefined ? null : Number(r.null_frac));
      }

      let next = 0;
      const results = parsed.map(p => {
        if (p.error) return { relation: p.input, error: p.error };
        const c = centers[next++];
        if (c.error) return c;
        const centerRows = toNumber(c.rel.est_rows);
        const items = role => rankNeighbours(c.edges.filter(e => e.role === role).map(e => {
          const tableEstRows = toNumber(e.estRows);
          return {
            relation: `${e.schema}.${e.table}`,
            schema: e.schema,
            table: e.table,
            constraint: e.constraint,
            columns: e.columns ?? [],
            refColumns: e.refColumns ?? [],
            ...linkedRowsEstimate(role === 'instance' ? centerRows : tableEstRows, e.lookups.map(l => nullFrac.get(l.ord) ?? null)),
            tableEstRows,
          };
        }));
        return {
          relation: c.relation,
          schema: c.ref.schema,
          table: c.ref.table,
          kind: relationKinds[c.rel.relkind] ?? c.rel.relkind,
          estRows: centerRows,
          instance: items('instance'),
          dependent: items('dependent'),
          hidden: c.hidden,
        };
      });
      const found = results.filter(r => !r.error).length;
      return { profile: name, ...(schema ? { schema } : {}), statements, note: relationStatsNote, tables: results, found, notFound: results.length - found };
    });
  }, r => ({ statements: r.statements, found: r.found, notFound: r.notFound }));
}
