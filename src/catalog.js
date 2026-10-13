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

const relationOidSql = `
select c.oid, c.relkind
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relname = $2`;

const columnsSql = `
select a.attname as column,
       format_type(a.atttypid, a.atttypmod) as type,
       a.attnotnull as not_null,
       pg_get_expr(d.adbin, d.adrelid) as default,
       has_column_privilege(a.attrelid, a.attnum, 'SELECT') as can_select,
       col_description(a.attrelid, a.attnum) as comment
from pg_attribute a
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
order by a.attnum`;

const constraintsSql = `
select conname as name,
       case contype when 'p' then 'primary key' when 'u' then 'unique' when 'f' then 'foreign key'
                    when 'c' then 'check' when 'x' then 'exclusion' else contype::text end as type,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = $1
order by contype, conname`;

const indexesSql = `
select i.relname as name, pg_get_indexdef(x.indexrelid) as definition
from pg_index x join pg_class i on i.oid = x.indexrelid
where x.indrelid = $1
order by i.relname`;

const referencedBySql = `
select n.nspname || '.' || c.relname as from_table,
       con.conname as name,
       pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where con.contype = 'f' and con.confrelid = $1
order by 1, 2`;

const viewDefinitionSql = 'select pg_get_viewdef($1::oid, true) as definition';

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
  if (!value) throw new Error('Search text is empty.');
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

export async function describeTable(db, profile, schema, table) {
  return db.audited('describe_table', { profile: profile ?? null, schema, table }, () => db.withReadOnly(profile, async (client, name) => {
    const rel = await client.query(relationOidSql, [schema, table]);
    if (!rel.rows.length) throw new Error(`Relation ${schema}.${table} not found.`);
    const { oid, relkind } = rel.rows[0];
    const [columns, constraints, indexes, referencedBy] = [
      await client.query(columnsSql, [oid]),
      await client.query(constraintsSql, [oid]),
      await client.query(indexesSql, [oid]),
      await client.query(referencedBySql, [oid]),
    ];
    const result = {
      profile: name,
      relation: `${schema}.${table}`,
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
      referencedBy: referencedBy.rows,
    };
    if (relkind === 'v' || relkind === 'm') {
      result.viewDefinition = (await client.query(viewDefinitionSql, [oid])).rows[0].definition;
    }
    return result;
  }));
}
