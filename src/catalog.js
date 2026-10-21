import { ToolError } from './errors.js';

// Catalog queries used for browsing. They are fixed, parameterized SQL and run
// inside the same READ ONLY transaction wrapper as user queries.

// Row estimate of a relation (pg_class alias), null when unknown.
// - reltuples > 0: the planner's estimate, as PostgreSQL itself uses it.
// - reltuples is 0 or -1 but the statistics collector counts live rows
//   (inserts since the last vacuum or analyze): that count. A table analyzed
//   while empty and filled later would otherwise stay at 0.
// - reltuples is 0 and the relation was vacuumed or analyzed: 0 (empty).
// - otherwise unknown (null). PostgreSQL 14+ marks a never vacuumed or
//   analyzed relation with -1, but before 14 with 0, the same value as an
//   empty table: an unknown is safer than a false "empty".
// (After a statistics reset an empty table shows unknown until its next
// vacuum or analyze.)
export const estimatedRowsSql = alias => `case when ${alias}.reltuples > 0 then ${alias}.reltuples::bigint `
  + `when pg_stat_get_live_tuples(${alias}.oid) > 0 then pg_stat_get_live_tuples(${alias}.oid) `
  + `when ${alias}.reltuples = 0 and coalesce(pg_stat_get_last_analyze_time(${alias}.oid), pg_stat_get_last_autoanalyze_time(${alias}.oid), `
  + `pg_stat_get_last_vacuum_time(${alias}.oid), pg_stat_get_last_autovacuum_time(${alias}.oid)) is not null then 0 end`;

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
       ${estimatedRowsSql('c')} as estimated_rows,
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
       ${estimatedRowsSql('c')} as estimated_rows,
       obj_description(c.oid, 'pg_class') as comment,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end as partition_key,
       case when c.relkind = 'p' then (select count(*) from pg_inherits i where i.inhparent = c.oid) end as partitions,
       (select pn.nspname || '.' || pc.relname from pg_inherits i
          join pg_class pc on pc.oid = i.inhparent join pg_namespace pn on pn.oid = pc.relnamespace
        where c.relispartition and i.inhrelid = c.oid) as partition_of,
       case when c.relispartition then pg_get_expr(c.relpartbound, c.oid) end as partition_bound
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
       col_description(a.attrelid, a.attnum) as comment,
       case a.attidentity when 'a' then 'always' when 'd' then 'by default' end as identity,
       case a.attgenerated when 's' then 'stored' when 'v' then 'virtual' end as generated,
       (select sn.nspname || '.' || s.relname
        from pg_depend dep
        join pg_class s on s.oid = dep.objid and s.relkind = 'S'
        join pg_namespace sn on sn.oid = s.relnamespace
        where dep.classid = 'pg_class'::regclass and dep.refclassid = 'pg_class'::regclass
          and dep.refobjid = a.attrelid and dep.refobjsubid = a.attnum and dep.deptype in ('a', 'i')
        limit 1) as sequence -- owned by the column: serial (a) or identity (i)
from pg_attribute a
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped
order by a.attrelid, a.attnum`;

// Triggers defined by users (not the internal ones behind foreign keys).
// tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate,
// 64 instead of.
const triggersSql = `
select t.tgrelid::bigint as relid, t.tgname as name, t.tgtype::int as tgtype, t.tgenabled::text as enabled,
       fn.nspname || '.' || p.proname as function,
       t.tgconstraint <> 0 as constraint_trigger,
       pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
join pg_namespace fn on fn.oid = p.pronamespace
where t.tgrelid = any($1::oid[]) and not t.tgisinternal
order by t.tgrelid, t.tgname`;

const triggerEnabled = { O: 'enabled', D: 'disabled', R: 'replica only', A: 'always' };

export function triggerFromRow(row) {
  const type = Number(row.tgtype);
  const events = [[4, 'INSERT'], [16, 'UPDATE'], [8, 'DELETE'], [32, 'TRUNCATE']].filter(([bit]) => type & bit).map(([, e]) => e);
  const when = /\sWHEN \((.*)\) EXECUTE (?:FUNCTION|PROCEDURE) /s.exec(row.definition ?? '');
  return {
    name: row.name,
    timing: type & 64 ? 'INSTEAD OF' : type & 2 ? 'BEFORE' : 'AFTER',
    events,
    level: type & 1 ? 'ROW' : 'STATEMENT',
    enabled: triggerEnabled[row.enabled] ?? row.enabled,
    function: row.function,
    whenCondition: when ? when[1] : null,
    ...(row.constraint_trigger ? { constraintTrigger: true } : {}),
    definition: row.definition,
  };
}

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

// Views and materialized views among $1: definition, options (reloptions
// such as security_barrier=true, check_option=local) and, for a materialized
// view, whether it is populated.
const viewFactsSql = `
select c.oid::bigint as relid, c.relkind, pg_get_viewdef(c.oid, true) as definition,
       c.reloptions as options, c.relispopulated as populated
from pg_class c
where c.oid = any($1::oid[]) and c.relkind in ('v', 'm')`;

// View dependencies of the relations in $1, from the rewrite rules of views
// and materialized views (pg_rewrite) and their recorded dependencies
// (pg_depend), in one statement:
// - 'source': what a view or materialized view in $1 reads: relations (with
//   the columns it uses, from refobjsubid) and functions it calls; the view
//   itself is left out.
// - 'used_by': the views and materialized views that read a relation in $1.
// Only the SELECT rule (ev_type '1', "_RETURN") counts: the targets of
// DO INSTEAD INSERT / UPDATE / DELETE rules on a view are not its sources.
const viewDependenciesSql = `
select 'source' as dep, r.ev_class::bigint as relid,
       case when d.refclassid = 'pg_class'::regclass then 'relation' else 'function' end as ref_type,
       coalesce(rn.nspname, pn.nspname) as ref_schema,
       coalesce(rc.relname, p.proname) as ref_name,
       rc.relkind::text as ref_relkind,
       case when d.refobjsubid > 0 then a.attname end as ref_column,
       case when p.oid is not null then pg_get_function_identity_arguments(p.oid) end as ref_arguments,
       case p.provolatile when 'i' then 'immutable' when 's' then 'stable' when 'v' then 'volatile' end as ref_volatility
from pg_rewrite r
join pg_class vc on vc.oid = r.ev_class and vc.relkind in ('v', 'm')
join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid
                and d.refclassid in ('pg_class'::regclass, 'pg_proc'::regclass)
                and not (d.refclassid = 'pg_class'::regclass and d.refobjid = r.ev_class)
left join pg_class rc on d.refclassid = 'pg_class'::regclass and rc.oid = d.refobjid
left join pg_namespace rn on rn.oid = rc.relnamespace
left join pg_attribute a on rc.oid is not null and a.attrelid = rc.oid and a.attnum = d.refobjsubid
left join pg_proc p on d.refclassid = 'pg_proc'::regclass and p.oid = d.refobjid
left join pg_namespace pn on pn.oid = p.pronamespace
where r.ev_class = any($1::oid[]) and r.ev_type = '1'
  and (rc.oid is null or rc.relkind in ('r', 'p', 'v', 'm', 'f'))
  and (rc.oid is not null or p.oid is not null)
union all
select distinct 'used_by', d.refobjid::bigint, 'relation', vn.nspname, vc.relname, vc.relkind::text, null, null, null
from pg_depend d
join pg_rewrite r on r.oid = d.objid
join pg_class vc on vc.oid = r.ev_class and vc.relkind in ('v', 'm')
join pg_namespace vn on vn.oid = vc.relnamespace
where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
  and d.refobjid = any($1::oid[]) and r.ev_class <> d.refobjid and r.ev_type = '1'
order by 1, 2, 4, 5, 7`;

// Searches relation names (tables, views, ...), column names, function names
// and trigger names, and their comments, across all non-system schemas (or
// one schema). $1 = ILIKE pattern, $2 = schema or null, $3 = include columns,
// $4 = include functions and triggers, $5 = also match function source text.
// The source text is only matched, never returned. Relations come first, so
// the row limit drops columns before anything else.
const searchSql = `
with rel as (
  select c.oid, n.nspname, c.relname,
         case c.relkind when 'r' then 'table' when 'p' then 'partitioned' when 'v' then 'view'
                        when 'm' then 'matview' when 'f' then 'foreign' end as kind,
         ${estimatedRowsSql('c')} as estimated_rows,
         has_table_privilege(c.oid, 'SELECT') as can_select,
         obj_description(c.oid, 'pg_class') as comment
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r','p','v','m','f')
    and not c.relispartition
    and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
    and ($2::text is null or n.nspname = $2)
),
fn as (
  select p.oid, n.nspname, p.proname, p.prosrc, obj_description(p.oid, 'pg_proc') as comment,
         case p.prokind when 'f' then 'function' when 'p' then 'procedure' when 'a' then 'aggregate' when 'w' then 'window' end as kind
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where $4 and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
    and ($2::text is null or n.nspname = $2)
)
select 'relation' as match, 0 as prio, nspname as schema, relname as relation, null::text as column,
       kind, estimated_rows, can_select, comment, null::text as matched_in
from rel
where relname ilike $1 or comment ilike $1
union all
select 'function', 1, f.nspname, f.proname, pg_get_function_identity_arguments(f.oid), f.kind,
       null::bigint, has_function_privilege(f.oid, 'EXECUTE'), f.comment,
       case when f.proname ilike $1 then 'name' when f.comment ilike $1 then 'comment' else 'source' end
from fn f
where f.proname ilike $1 or f.comment ilike $1 or ($5 and f.prosrc ilike $1)
union all
select 'trigger', 2, n.nspname, c.relname, t.tgname, null::text,
       null::bigint, null::boolean, fn.nspname || '.' || p.proname, null::text
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
join pg_namespace fn on fn.oid = p.pronamespace
where $4 and not t.tgisinternal and t.tgname ilike $1
  and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
  and ($2::text is null or n.nspname = $2)
union all
select 'column', 3, r.nspname, r.relname, a.attname, format_type(a.atttypid, a.atttypmod),
       r.estimated_rows, has_column_privilege(r.oid, a.attnum, 'SELECT'), col_description(r.oid, a.attnum), null::text
from rel r
join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
where $3 and (a.attname ilike $1 or col_description(r.oid, a.attnum) ilike $1)
order by 2, 3, 4, 5
limit 501`;

// Always a contains-match: a leading and trailing % are added when missing;
// % and _ inside the text keep their ILIKE meaning.
export function toIlikePattern(text) {
  const value = String(text || '').trim();
  if (!value) throw new ToolError('INVALID_INPUT', 'Search text is empty.');
  return `${value.startsWith('%') ? '' : '%'}${value}${value.endsWith('%') ? '' : '%'}`;
}

export async function search(db, profile, text, schema, includeColumns = true, { includeRoutines = true, searchSource = false } = {}) {
  const details = { profile: profile ?? null, text, schema: schema || null, includeColumns, includeRoutines, searchSource };
  return db.audited('search', details, () => searchImpl(db, profile, text, schema, includeColumns, includeRoutines, searchSource));
}

async function searchImpl(db, profile, text, schema, includeColumns, includeRoutines, searchSource) {
  const pattern = toIlikePattern(text);
  if (searchSource && !includeRoutines) throw new ToolError('INVALID_INPUT', 'searchSource needs includeRoutines.');
  return db.withReadOnly(profile, async (client, name) => {
    const res = await client.query(searchSql, [pattern, schema || null, includeColumns, includeRoutines, searchSource]);
    const truncated = res.rows.length > 500;
    const rows = truncated ? res.rows.slice(0, 500) : res.rows;
    const of = match => rows.filter(r => r.match === match);
    return {
      profile: name,
      pattern,
      relations: of('relation').map(({ match, prio, column, matched_in, ...r }) => r),
      columns: of('column').map(({ match, prio, kind, matched_in, ...r }) => ({ ...r, type: kind })),
      ...(includeRoutines ? {
        functions: of('function').map(r => ({
          schema: r.schema, function: r.relation, arguments: r.column, kind: r.kind, canExecute: r.can_select, comment: r.comment, matchedIn: r.matched_in,
        })),
        triggers: of('trigger').map(r => ({ schema: r.schema, relation: r.relation, trigger: r.column, function: r.comment })),
      } : {}),
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

// Column fields that are only shown when set.
function columnFromRow(row) {
  const out = { ...row };
  for (const key of ['identity', 'generated', 'sequence']) if (out[key] === null || out[key] === undefined) delete out[key];
  return out;
}

const textOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const optionTrue = v => ['true', 'on', 'yes', '1'].includes(String(v ?? '').toLowerCase());

// Rows of viewDependenciesSql grouped by the described oid: sources (one
// entry per relation with its sorted, distinct columns), functions and
// usedBy, each sorted by schema and name.
export function viewDependenciesFromRows(rows) {
  const sources = new Map();
  const functions = new Map();
  const usedBy = new Map();
  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, new Map());
    return map.get(key);
  };
  for (const r of rows) {
    const key = String(r.relid);
    if (r.dep === 'used_by') {
      bucket(usedBy, key).set(`${r.ref_schema}\n${r.ref_name}`, { schema: r.ref_schema, table: r.ref_name, kind: relationKinds[r.ref_relkind] ?? r.ref_relkind });
    } else if (r.ref_type === 'function') {
      bucket(functions, key).set(`${r.ref_schema}\n${r.ref_name}\n${r.ref_arguments ?? ''}`, {
        schema: r.ref_schema, name: r.ref_name, arguments: r.ref_arguments ?? '', volatility: r.ref_volatility ?? null,
      });
    } else {
      const map = bucket(sources, key);
      const id = `${r.ref_schema}\n${r.ref_name}`;
      if (!map.has(id)) map.set(id, { schema: r.ref_schema, table: r.ref_name, kind: relationKinds[r.ref_relkind] ?? r.ref_relkind, columns: new Set() });
      if (r.ref_column !== null && r.ref_column !== undefined) map.get(id).columns.add(r.ref_column);
    }
  }
  const sorted = (map, second) => new Map([...map].map(([key, items]) => [key, [...items.values()]
    .sort((a, b) => textOrder(a.schema, b.schema) || textOrder(a[second], b[second]) || textOrder(a.arguments ?? '', b.arguments ?? ''))]));
  const withColumns = new Map([...sorted(sources, 'table')].map(([key, list]) => [key, list.map(s => ({ ...s, columns: [...s.columns].sort(textOrder) }))]));
  return { sources: withColumns, functions: sorted(functions, 'name'), usedBy: sorted(usedBy, 'table') };
}

// The view fields of a describe result: definition, options, populated
// (materialized views only), sources and called functions.
export function viewFieldsFromRow(row, dependencies, key) {
  const options = new Map((row.options ?? []).map(o => {
    const at = String(o).indexOf('=');
    return at < 0 ? [String(o), 'true'] : [String(o).slice(0, at), String(o).slice(at + 1)];
  }));
  const checkOption = options.has('check_option') ? String(options.get('check_option')).toLowerCase() : null;
  return {
    viewDefinition: row.definition,
    viewOptions: { securityBarrier: optionTrue(options.get('security_barrier')), checkOption },
    ...(row.relkind === 'm' ? { populated: !!row.populated } : {}),
    viewSources: dependencies.sources.get(key) ?? [],
    viewFunctions: dependencies.functions.get(key) ?? [],
  };
}

// Describes refs ([{ schema, table }]) with 7 catalog statements, 8 when one
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
  let triggers = new Map();
  let views = new Map();
  let dependencies = { sources: new Map(), functions: new Map(), usedBy: new Map() };
  if (oids.length) {
    columns = groupByRelid(await run(columnsSql, [oids]));
    constraints = groupByRelid(await run(constraintsSql, [oids]));
    indexes = groupByRelid(await run(indexesSql, [oids]));
    referencedBy = groupByRelid(await run(referencedBySql, [oids]));
    triggers = groupByRelid(await run(triggersSql, [oids]));
    dependencies = viewDependenciesFromRows(await run(viewDependenciesSql, [oids]));
    if (rels.some(r => r.relkind === 'v' || r.relkind === 'm')) {
      views = new Map((await run(viewFactsSql, [oids])).map(r => [String(r.relid), r]));
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
      columns: (columns.get(key) ?? []).map(columnFromRow),
      constraints: constraints.get(key) ?? [],
      indexes: indexes.get(key) ?? [],
      referencedBy: referencedBy.get(key) ?? [],
      triggers: (triggers.get(key) ?? []).map(triggerFromRow),
      rowLevelSecurity: { enabled: !!rel.rls_enabled, forced: !!rel.rls_forced },
    };
    if (rel.partition_key) result.partitioning = { key: rel.partition_key, partitions: toNumber(rel.partitions) ?? 0 };
    if (rel.partition_of) result.partitionOf = { parent: rel.partition_of, bound: rel.partition_bound ?? null };
    if (views.has(key)) Object.assign(result, viewFieldsFromRow(views.get(key), dependencies, key));
    result.usedByViews = dependencies.usedBy.get(key) ?? [];
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

// ---------- describe_tables detail "summary" ----------

export const describeDetails = ['summary', 'full'];
export const summaryReferencedBy = 10;
const shortDefaultChars = 30;
const summaryLineChars = 120;

export const describeSummaryNote = 'detail "summary": each column as "name type [not null] [PK] [FK -> schema.table(column)] [identity] [generated] '
  + '[default <value> | has default] [no SELECT]" (a default longer than 30 characters is only flagged); constraints other than single-column '
  + 'foreign keys as "name definition"; indexes as "name [unique] [method] (columns)"; triggers as "name TIMING EVENTS"; each line cut at '
  + `${summaryLineChars} characters; referencedBy as the count of incoming foreign keys and the first ${summaryReferencedBy} by table name `
  + '(relation_stats ranks them); for a view or materialized view the relations it reads with their columns (viewSources) and the '
  + 'functions it calls (viewFunctions), and for any relation the views that read it (usedByViews), one line each. '
  + 'Column comments, full definitions and view definitions (viewDefinitionOmitted) are left out: '
  + 'use detail "full" for them. The schema memory is recorded from the full catalog data either way.';

const clip = text => (text.length > summaryLineChars ? `${text.slice(0, summaryLineChars - 3)}...` : text);

function indexLine({ name, definition }) {
  const m = /^CREATE (UNIQUE )?INDEX .*? USING (\S+) (.*)$/s.exec(definition ?? '');
  if (!m) return clip(`${name} ${definition ?? ''}`.trim());
  return clip(`${name}${m[1] ? ' unique' : ''}${m[2] === 'btree' ? '' : ` ${m[2]}`} ${m[3]}`);
}

// A compact view of one describeRelations entry for describe_tables: one line
// per column, constraint, index and trigger, and incoming foreign keys as a
// count and the first few referencing tables. The input is not changed.
export function summarizeDescribedTable(t) {
  const primaryKey = new Set(t.constraints.filter(c => c.type === 'primary key').flatMap(c => c.columns ?? []));
  const singleFks = t.constraints.filter(c => c.type === 'foreign key' && c.columns?.length === 1);
  const columns = t.columns.map(c => {
    const parts = [c.column, c.type];
    if (c.not_null) parts.push('not null');
    if (primaryKey.has(c.column)) parts.push('PK');
    for (const fk of singleFks.filter(f => f.columns[0] === c.column)) parts.push(`FK -> ${fk.ref_schema}.${fk.ref_table}(${(fk.ref_columns ?? []).join(', ')})`);
    if (c.identity) parts.push('identity');
    if (c.generated) parts.push('generated');
    if (c.default !== null && c.default !== undefined && !c.generated) parts.push(c.default.length <= shortDefaultChars ? `default ${c.default}` : 'has default');
    if (c.can_select === false) parts.push('no SELECT');
    return parts.join(' ');
  });
  const out = {
    relation: t.relation,
    kind: t.kind,
    estRows: t.estimated_rows,
    comment: t.comment ?? null,
    columns,
    // Single-column foreign keys are on their column line; NOT NULL
    // constraints (contype n, PostgreSQL 18) are in the column's nullability.
    constraints: t.constraints.filter(c => !singleFks.includes(c) && c.type !== 'n').map(c => clip(`${c.name} ${c.definition}`)),
    indexes: t.indexes.map(indexLine),
    triggers: t.triggers.map(tr => `${tr.name} ${tr.timing} ${tr.events.join(' OR ')}`),
    referencedBy: {
      count: t.referencedBy.length,
      tables: t.referencedBy.slice(0, summaryReferencedBy).map(r => `${r.from_table}(${(r.columns ?? []).join(', ')})`),
    },
  };
  if (t.rowLevelSecurity?.enabled || t.rowLevelSecurity?.forced) out.rowLevelSecurity = t.rowLevelSecurity;
  if (t.partitioning) out.partitioning = t.partitioning;
  if (t.partitionOf) out.partitionOf = t.partitionOf;
  if (t.viewDefinition !== undefined) {
    out.viewDefinitionOmitted = true;
    if (t.populated === false) out.populated = false;
    if (t.viewSources?.length) out.viewSources = clip(t.viewSources.map(v => `${v.schema}.${v.table}${v.columns.length ? `(${v.columns.join(', ')})` : ''}`).join(', '));
    if (t.viewFunctions?.length) out.viewFunctions = clip(t.viewFunctions.map(f => `${f.schema}.${f.name}(${f.arguments})`).join(', '));
  }
  if (t.usedByViews?.length) out.usedByViews = clip(t.usedByViews.map(v => `${v.schema}.${v.table}`).join(', '));
  return out;
}

// ---------- describe_functions ----------

export const maxDescribeFunctions = 50;
export const defaultDefinitionChars = 20000;
export const maxDefinitionChars = 200000;
// The schema memory keeps each definition up to this many characters,
// whatever maxChars the call used (src/memory/store.js).
export const storedDefinitionChars = 20000;

// The first n characters (code points, like PostgreSQL's left()).
export function cutChars(text, n) {
  if (text === null || text === undefined) return text;
  const value = String(text);
  return value.length <= n ? value : Array.from(value).slice(0, n).join('');
}

// The triggers that call each function, aggregated once over pg_trigger
// (pg_trigger has no index on tgfoid, so a subquery per function would scan
// it again for every row) and joined on tgfoid as alias ut: schema, table
// name, trigger name and tgtype (decoded by functionTriggerFromRow).
// Internal triggers are left out, and so are the clones of a partitioned
// table's trigger on its partitions (they depend on the parent trigger in
// pg_depend; PostgreSQL 15+ no longer marks them internal).
const triggersByFunction = `
left join (select t.tgfoid,
                  jsonb_agg(jsonb_build_object('schema', tn.nspname, 'tableName', tc.relname, 'trigger', t.tgname, 'tgtype', t.tgtype::int)
                            order by tn.nspname, tc.relname, t.tgname) as used_by_triggers
           from pg_trigger t
           join pg_class tc on tc.oid = t.tgrelid
           join pg_namespace tn on tn.oid = tc.relnamespace
           where not t.tgisinternal
             and not exists (select 1 from pg_depend dp
                             where dp.classid = 'pg_trigger'::regclass and dp.objid = t.oid
                               and dp.refclassid = 'pg_trigger'::regclass)
           group by t.tgfoid) ut`;
const usedByTriggersColumn = `coalesce(ut.used_by_triggers, '[]'::jsonb) as used_by_triggers`;

// Identity of a table as the schema memory builds it (tableKey in
// src/memory/store.js): "schema.table", a part with a dot or double quote
// quoted like quote_ident.
const keyPart = name => (/[."]/.test(String(name)) ? `"${String(name).replace(/"/g, '""')}"` : String(name));
export const relationKey = (schema, table) => `${keyPart(schema)}.${keyPart(table)}`;

// One used_by_triggers entry: tgtype bits 1 row, 2 before, 4 insert,
// 8 delete, 16 update, 32 truncate, 64 instead of. Entries without tgtype
// (older shape) keep only what they have.
export function functionTriggerFromRow(t) {
  if (t.tgtype === undefined || t.tgtype === null) return { ...t };
  const type = Number(t.tgtype);
  return {
    table: relationKey(t.schema, t.tableName),
    schema: t.schema,
    tableName: t.tableName,
    trigger: t.trigger,
    timing: type & 64 ? 'instead' : type & 2 ? 'before' : 'after',
    events: [[4, 'insert'], [16, 'update'], [8, 'delete'], [32, 'truncate']].filter(([bit]) => type & bit).map(([, e]) => e),
    level: type & 1 ? 'row' : 'statement',
  };
}

// Shared select list over pg_proc p / pg_namespace n. pg_get_functiondef does
// not accept aggregates; their definition is null. $1 = definition cap.
const functionColumns = `
       n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments,
       pg_get_function_result(p.oid) as returns,
       case p.prokind when 'f' then 'function' when 'p' then 'procedure' when 'a' then 'aggregate' when 'w' then 'window' end as kind,
       l.lanname as language,
       case p.provolatile when 'i' then 'immutable' when 's' then 'stable' when 'v' then 'volatile' end as volatility,
       p.prosecdef as security_definer, p.proisstrict as strict,
       case p.proparallel when 's' then 'safe' when 'r' then 'restricted' when 'u' then 'unsafe' end as parallel,
       p.proconfig as config,
       pg_get_userbyid(p.proowner) as owner,
       has_function_privilege(p.oid, 'EXECUTE') as can_execute,
       obj_description(p.oid, 'pg_proc') as comment,
       p.prorettype = 'trigger'::regtype as returns_trigger,
       left(d.definition, greatest($1::int, ${storedDefinitionChars})) as definition, length(d.definition) as definition_length`;
const functionFrom = `
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
cross join lateral (select case when p.prokind <> 'a' then pg_get_functiondef(p.oid) end as definition) d`;

// Every overload of each requested schema.name; a name without a match gives
// one row with schema null. $2 schemas, $3 names.
const functionsByNameSql = `
select r.ord::int as ord, f.*, ${usedByTriggersColumn}
from unnest($2::text[], $3::text[]) with ordinality as r(schema, name, ord)
left join lateral (select p.oid as proc_oid, ${functionColumns} ${functionFrom}
                   where n.nspname = r.schema and p.proname = r.name) f on true
${triggersByFunction} on ut.tgfoid = f.proc_oid
order by r.ord, f.arguments`;

// Functions whose name matches an ILIKE pattern ($2), in one schema ($3) or
// all non-system schemas; $4 = row limit.
const functionsByPatternSql = `
select ${functionColumns}, ${usedByTriggersColumn} ${functionFrom}
${triggersByFunction} on ut.tgfoid = p.oid
where p.proname ilike $2 and ($3::text is null or n.nspname = $3)
  and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
order by n.nspname, p.proname, 3
limit $4`;

// memoryDefinition (not enumerable, so never in the tool output): the
// definition cut at storedDefinitionChars for the schema memory.
function functionFromRow(row, cap) {
  const length = toNumber(row.definition_length);
  const out = {
    function: `${row.schema}.${row.name}(${row.arguments ?? ''})`,
    schema: row.schema,
    name: row.name,
    arguments: row.arguments,
    returns: row.returns,
    kind: row.kind,
    language: row.language,
    volatility: row.volatility,
    securityDefiner: !!row.security_definer,
    strict: !!row.strict,
    parallel: row.parallel,
    config: row.config ?? [],
    owner: row.owner,
    canExecute: !!row.can_execute,
    comment: row.comment ?? null,
    usedByTriggers: (row.used_by_triggers ?? []).map(functionTriggerFromRow),
    returnsTrigger: !!row.returns_trigger,
    definition: cutChars(row.definition ?? null, cap),
    definitionLength: length,
    truncated: length !== null && length > cap,
  };
  Object.defineProperty(out, 'memoryDefinition', { value: cutChars(row.definition ?? null, storedDefinitionChars), enumerable: false });
  return out;
}

// describe_functions: functions, procedures and aggregates by schema.name
// (every overload) or by a name pattern, with signature, properties and the
// pg_get_functiondef text capped at maxChars. 1 catalog statement.
export async function describeFunctions(db, profile, { functions, pattern, schema, maxChars } = {}) {
  const list = Array.isArray(functions) ? uniqueTrimmed(functions) : [];
  const details = { profile: profile ?? null, functions: list.length ? list : undefined, pattern: pattern || undefined, schema: schema || undefined };
  return db.audited('describe_functions', details, () => {
    if (!list.length === !pattern) throw new ToolError('INVALID_INPUT', 'Give either functions (schema.name) or pattern.');
    if (list.length > maxDescribeFunctions) throw new ToolError('INVALID_INPUT', `functions must list 1 to ${maxDescribeFunctions} names as schema.name.`);
    const cap = maxChars ?? defaultDefinitionChars;
    if (!Number.isInteger(cap) || cap < 1 || cap > maxDefinitionChars) throw new ToolError('INVALID_INPUT', `maxChars must be an integer from 1 to ${maxDefinitionChars}.`);
    const parsed = list.map(text => {
      try {
        const { schema: s, table: name } = parseTableRef(text);
        return { schema: s, name };
      } catch {
        return { input: text, error: `Invalid function "${text}": use schema.name; ${nameRule}.` };
      }
    });
    return db.withReadOnly(profile, async (client, name) => {
      if (pattern) {
        const res = await client.query(functionsByPatternSql, [cap, toIlikePattern(pattern), schema || null, maxDescribeFunctions + 1]);
        const truncated = res.rows.length > maxDescribeFunctions;
        const rows = truncated ? res.rows.slice(0, maxDescribeFunctions) : res.rows;
        return { profile: name, pattern: toIlikePattern(pattern), statements: 1, functions: rows.map(r => functionFromRow(r, cap)), found: rows.length, truncated };
      }
      const valid = parsed.filter(p => !p.error);
      let rows = [];
      if (valid.length) rows = (await client.query(functionsByNameSql, [cap, valid.map(v => v.schema), valid.map(v => v.name)])).rows;
      const byOrd = new Map();
      for (const r of rows) {
        const ord = Number(r.ord);
        if (!byOrd.has(ord)) byOrd.set(ord, []);
        if (r.name !== null && r.name !== undefined) byOrd.get(ord).push(functionFromRow(r, cap));
      }
      let next = 0;
      const out = parsed.flatMap(p => {
        if (p.error) return [{ function: p.input, error: p.error }];
        const found = byOrd.get(++next) ?? [];
        return found.length ? found : [{ function: `${p.schema}.${p.name}`, error: `Function ${p.schema}.${p.name} not found.` }];
      });
      const found = out.filter(f => !f.error).length;
      return { profile: name, statements: valid.length ? 1 : 0, functions: out, found, notFound: out.length - found };
    });
  }, r => ({ statements: r.statements, found: r.found }));
}

// ---------- list_functions ----------

export const defaultListFunctions = 500;
export const maxListFunctions = 2000;

// Every overload in one schema ($1) or all non-system schemas, optionally
// whose name matches an ILIKE pattern ($2); without definitions. Functions
// that belong to an extension are left out unless $4. $3 = row limit.
const listFunctionsSql = `
select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments,
       pg_get_function_result(p.oid) as returns,
       case p.prokind when 'f' then 'function' when 'p' then 'procedure' when 'a' then 'aggregate' when 'w' then 'window' end as kind,
       l.lanname as language,
       case p.provolatile when 'i' then 'immutable' when 's' then 'stable' when 'v' then 'volatile' end as volatility,
       p.prorettype = 'trigger'::regtype as returns_trigger,
       ${usedByTriggersColumn}
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
${triggersByFunction} on ut.tgfoid = p.oid
where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
  and ($1::text is null or n.nspname = $1)
  and ($2::text is null or p.proname ilike $2)
  and ($4 or not exists (select 1 from pg_depend e
                         where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e'))
order by 1, 2, 3
limit $3`;

// list_functions: an inventory of functions, procedures and aggregates
// (signature, return type, kind, language, volatility, returnsTrigger and
// the triggers that call each overload), one statement.
export async function listFunctions(db, profile, { schema, pattern, limit, includeExtensions = false } = {}) {
  const details = { profile: profile ?? null, schema: schema || undefined, pattern: pattern || undefined, limit: limit ?? undefined, includeExtensions: includeExtensions || undefined };
  return db.audited('list_functions', details, () => {
    const max = limit ?? defaultListFunctions;
    if (!Number.isInteger(max) || max < 1 || max > maxListFunctions) throw new ToolError('INVALID_INPUT', `limit must be an integer from 1 to ${maxListFunctions}.`);
    const ilike = pattern ? toIlikePattern(pattern) : null;
    return db.withReadOnly(profile, async (client, name) => {
      const res = await client.query(listFunctionsSql, [schema || null, ilike, max + 1, !!includeExtensions]);
      const truncated = res.rows.length > max;
      const rows = (truncated ? res.rows.slice(0, max) : res.rows).map(r => ({
        schema: r.schema, name: r.name, arguments: r.arguments ?? '', returns: r.returns, kind: r.kind, language: r.language, volatility: r.volatility,
        returnsTrigger: !!r.returns_trigger, usedByTriggers: (r.used_by_triggers ?? []).map(functionTriggerFromRow),
      }));
      return { profile: name, ...(ilike ? { pattern: ilike } : {}), statements: 1, functions: rows, rowCount: rows.length, truncated };
    });
  }, r => ({ statements: r.statements, rowCount: r.rowCount }));
}

// Catalog facts profile_tables needs for every requested relation (and the
// parent), in one statement: columns with their base type and SELECT
// privilege, outgoing single- or multi-column foreign keys, and for a table or
// materialized view its size in pages (from the file size, not statistics).
const profileCatalogSql = `
select r.ord::int as ord, c.oid::bigint as oid, c.relkind, n.nspname as schema_name, c.relname as rel_name,
       ${estimatedRowsSql('c')} as estimated_rows,
       case when c.relkind in ('r', 'm') and has_table_privilege(c.oid, 'SELECT') then pg_relation_size(c.oid) / current_setting('block_size')::bigint end as pages,
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
  + '(random pages, percent sized to about 1.2 x sampleRows) plus LIMIT sampleRows (sample.method "tablesample"), '
  + 'unless that would pick fewer than about 10 pages of a table or materialized view (a small table could come back empty); '
  + 'any other relation, or one with unknown or smaller estimates, is read with a plain LIMIT sampleRows scan '
  + '(sample.method "limit": the first rows the scan returns, not random). fillRate = non-null share of the sample; '
  + 'distinctInSample = count(distinct value::text) within the sample, a lower bound for the whole table.';

export const maxParentFilters = 5;
export const maxParentFilterValues = 100;
export const parentFilterOps = ['=', '<>', '>', '>=', '<', '<=', 'in', 'not in', 'is null', 'is not null'];
const isFilterValue = v => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

// One parentFilter item: the column is checked like every name (and later
// against the parent's catalog columns), op against a fixed list, and the
// value count against op. Values are only ever bound as parameters.
function parentFilterFrom(f, i) {
  const at = `parentFilter[${i}]`;
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new ToolError('INVALID_INPUT', `${at} must be an object with column and op.`);
  const column = checkName(f.column, `${at} column`);
  const op = typeof f.op === 'string' ? f.op.trim().toLowerCase().replace(/\s+/g, ' ') : f.op;
  if (!parentFilterOps.includes(op)) throw new ToolError('INVALID_INPUT', `${at} op "${f.op}" is not one of ${parentFilterOps.join(', ')}.`);
  const hasValue = f.value !== undefined;
  const hasValues = f.values !== undefined;
  if (op === 'is null' || op === 'is not null') {
    if (hasValue || hasValues) throw new ToolError('INVALID_INPUT', `${at} op ${op} takes no value or values.`);
    return { column, op };
  }
  if (op === 'in' || op === 'not in') {
    if (hasValue || !Array.isArray(f.values) || f.values.length < 1 || f.values.length > maxParentFilterValues || !f.values.every(isFilterValue)) {
      throw new ToolError('INVALID_INPUT', `${at} op ${op} needs values: 1 to ${maxParentFilterValues} strings, numbers or booleans (and no value).`);
    }
    return { column, op, values: f.values };
  }
  if (hasValues || !isFilterValue(f.value)) throw new ToolError('INVALID_INPUT', `${at} op ${op} needs one value: a string, number or boolean (and no values).`);
  return { column, op, value: f.value };
}

// SQL for one validated filter on a quoted catalog column; bind() adds a
// parameter and returns its placeholder. No input text reaches the SQL.
function parentFilterSql(f, column, bind) {
  if (f.op === 'is null' || f.op === 'is not null') return `${column} ${f.op}`;
  if (f.op === 'in') return `${column} = any(${bind(f.values)})`;
  if (f.op === 'not in') return `${column} <> all(${bind(f.values)})`;
  return `${column} ${f.op} ${bind(f.value)}`;
}

function validateProfileArgs({ tables, parent, window, parentFilter, sampleRows }) {
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
  let filters = [];
  if (parentFilter !== undefined && parentFilter !== null) {
    if (!parentRef) throw new ToolError('INVALID_INPUT', 'parentFilter filters the parent table; give parent as well.');
    if (!Array.isArray(parentFilter) || parentFilter.length < 1 || parentFilter.length > maxParentFilters) {
      throw new ToolError('INVALID_INPUT', `parentFilter must list 1 to ${maxParentFilters} conditions.`);
    }
    filters = parentFilter.map(parentFilterFrom);
  }
  const rows = sampleRows ?? defaultSampleRows;
  if (!Number.isInteger(rows) || rows < 1 || rows > maxSampleRows) throw new ToolError('INVALID_INPUT', `sampleRows must be an integer from 1 to ${maxSampleRows}.`);
  return { refs, parentRef, win, filters, rows };
}

// TABLESAMPLE SYSTEM picks whole pages at random: below about this many
// expected pages a small table can come back with no rows at all, so it is
// read with a plain LIMIT scan instead (which reads at most sampleRows rows).
const minSamplePages = 10;

function sampleSource(rel, readable, sampleRows) {
  const from = `${quoteIdent(rel.schema_name)}.${quoteIdent(rel.rel_name)}`;
  const cols = readable.map(c => quoteIdent(c.name)).join(', ');
  const estimated = toNumber(rel.estimated_rows);
  if (['r', 'p', 'm'].includes(rel.relkind) && estimated !== null && estimated > sampleRows) {
    const percent = Number(Math.min(100, Math.max(0.0001, (sampleRows / estimated) * 120)).toFixed(4));
    const pages = toNumber(rel.pages);
    const tooFewPages = pages !== null && (pages * percent) / 100 < minSamplePages;
    if (!tooFewPages) return { sql: `select ${cols} from ${from} tablesample system (${percent}) limit $1`, sample: { method: 'tablesample', percent } };
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
// sample and, with a parent, fan-out over the parent rows in the window and
// matching parentFilter (all conditions ANDed, values bound as parameters). All
// tables together take at most 3 statements in one READ ONLY transaction:
// 1 catalog lookup, 1 column-statistics statement (UNION ALL over the
// tables), and 1 fan-out statement (UNION ALL) when parent is given. Only
// counts and ratios are returned, never row values.
export async function profileTables(db, profile, { tables, parent, window, parentFilter, sampleRows, timeoutSeconds } = {}) {
  const details = {
    profile: profile ?? null, tables, parent: parent ?? undefined, window: window ?? undefined, parentFilter: parentFilter ?? undefined, sampleRows, timeoutSeconds,
  };
  return db.audited('profile_tables', details, () => {
    const { refs, parentRef, win, filters, rows } = validateProfileArgs({ tables, parent, window, parentFilter, sampleRows });
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
      let filterColumns = [];
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
        filterColumns = filters.map((f, i) => {
          const col = cols.get(f.column);
          if (!col) throw new ToolError('INVALID_INPUT', `parentFilter[${i}] column ${f.column} not found in ${relationName(parentRef)}.`);
          if (!col.canSelect) throw new ToolError('PERMISSION_DENIED', `No SELECT privilege on ${relationName(parentRef)}.${f.column}.`);
          return col;
        });
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
        // Window and parentFilter conditions, ANDed; every value is a parameter.
        const params = [rows];
        const bind = value => { params.push(value); return `$${params.length}`; };
        const conditions = [];
        if (windowColumn) {
          const column = quoteIdent(windowColumn.name);
          conditions.push(`${column} >= ${bind(win.from)}`, `${column} < ${bind(win.to)}`);
        }
        filters.forEach((f, i) => conditions.push(parentFilterSql(f, quoteIdent(filterColumns[i].name), bind)));
        const filter = conditions.map(c => ` and ${c}`).join('');
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
        const res = await db.guardedQuery(client, sql, params);
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
            ...(filters.length ? { parentFilter: filters } : {}),
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
       ${estimatedRowsSql('c')} as est_rows,
       has_table_privilege(c.oid, 'SELECT') as can_select,
       (select coalesce(jsonb_agg(jsonb_build_object(
                 'role', k.role,
                 'constraint', con.conname,
                 'schema', on_.nspname,
                 'table', oc.relname,
                 'relkind', oc.relkind,
                 'estRows', ${estimatedRowsSql('oc')},
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

export const relationStatsNote = 'Estimates from statistics only (reltuples, or the live row count when reltuples is 0 or unknown); no table is read. linkedRows = estimated rows of the referencing table '
  + '(the dependent table, or the center for an instance table) x (1 - null_frac of its foreign key column; for a multi-column key the '
  + 'largest null_frac, so an upper bound). linkedRows is null with stats "missing" when the referencing table has no row estimate (never vacuumed '
  + 'or analyzed) or pg_stats has no row for a key column: pg_stats only shows columns the role may read, hides tables whose row '
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
