// Checks, on a profile's first connection, that its database role really is
// read-only, instead of trusting the setup. Reads the catalog only.
//
// Blocking findings stop every call on that profile: the role could change
// data or the server outside what Auspex's READ ONLY transaction contains.
// Warnings are reported but do not block, because the READ ONLY transaction
// already neutralizes them (for example CREATE on a schema granted to PUBLIC).

export class RoleCheckError extends Error {
  constructor(profile, result) {
    super(`Profile "${profile}" is blocked: its database role is not read-only (${result.blocking.map(f => f.text).join('; ')}). Fix the role's privileges; Auspex will not run queries on it.`);
    this.code = 'ROLE_NOT_READ_ONLY';
    this.result = result;
  }
}

// Server roles whose members can write data or touch the server's files.
const dangerousMemberships = ['pg_write_all_data', 'pg_write_server_files', 'pg_read_server_files', 'pg_execute_server_program'];
const sampleLimit = 5;

export const roleCheckQueries = {
  role: `select rolname, rolsuper, rolbypassrls, rolreplication, rolcreaterole, rolcreatedb,
                current_setting('default_transaction_read_only') as default_read_only
           from pg_roles where rolname = current_user`,
  memberships: `select r.rolname from pg_roles r
                 where r.rolname = any($1::text[]) and pg_has_role(current_user, r.oid, 'MEMBER')
                 order by r.rolname`,
  // Tables, views and foreign tables the role can write to, in schemas it can
  // reach. Column-level INSERT/UPDATE grants count too.
  writable: `select n.nspname as schema, c.relname as name, count(*) over () as total
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relkind in ('r', 'p', 'v', 'f', 'm')
                and n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'
                and has_schema_privilege(n.oid, 'USAGE')
                and (has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
                     or has_any_column_privilege(c.oid, 'INSERT, UPDATE'))
              order by n.nspname, c.relname
              limit ${sampleLimit}`,
  createSchemas: `select nspname from pg_namespace
                   where nspname <> 'information_schema' and nspname not like 'pg\\_%'
                     and has_schema_privilege(oid, 'CREATE')
                   order by nspname`,
  database: `select has_database_privilege(current_database(), 'CREATE') as can_create`,
};

// Runs the checks with an open client (inside the READ ONLY transaction).
export async function runRoleCheck(client) {
  const role = (await client.query(roleCheckQueries.role)).rows[0];
  const memberships = (await client.query(roleCheckQueries.memberships, [dangerousMemberships])).rows.map(r => r.rolname);
  const writable = (await client.query(roleCheckQueries.writable)).rows;
  const createSchemas = (await client.query(roleCheckQueries.createSchemas)).rows.map(r => r.nspname);
  const database = (await client.query(roleCheckQueries.database)).rows[0];
  return evaluateRoleCheck({ role, memberships, writable, createSchemas, database });
}

// Turns catalog facts into { status, blocking, warnings }. Pure, for tests.
export function evaluateRoleCheck({ role, memberships = [], writable = [], createSchemas = [], database = {} }) {
  const blocking = [];
  const warnings = [];
  if (!role) {
    blocking.push({ code: 'role_not_found', text: 'the connected role was not found in pg_roles' });
  } else {
    if (role.rolsuper) blocking.push({ code: 'superuser', text: 'the role is a superuser' });
    if (role.rolbypassrls) blocking.push({ code: 'bypassrls', text: 'the role bypasses row-level security' });
    if (role.rolreplication) blocking.push({ code: 'replication', text: 'the role has REPLICATION' });
    if (role.rolcreaterole) blocking.push({ code: 'createrole', text: 'the role has CREATEROLE' });
    if (role.rolcreatedb) warnings.push({ code: 'createdb', text: 'the role has CREATEDB' });
    if (role.default_read_only !== 'on') warnings.push({ code: 'default_read_only_off', text: 'default_transaction_read_only is not on for the role' });
  }
  for (const m of memberships) blocking.push({ code: 'membership', text: `the role is a member of ${m}` });
  if (writable.length) {
    const total = Number(writable[0].total) || writable.length;
    const sample = writable.map(w => `${w.schema}.${w.name}`).join(', ');
    blocking.push({ code: 'writable_tables', text: `the role can write to ${total} table(s), e.g. ${sample}`, count: total });
  }
  if (createSchemas.length) warnings.push({ code: 'create_on_schema', text: `CREATE on schema(s) ${createSchemas.join(', ')}`, schemas: createSchemas });
  if (database.can_create) warnings.push({ code: 'create_on_database', text: 'CREATE on the database (new schemas)' });
  const status = blocking.length ? 'blocked' : warnings.length ? 'warning' : 'ok';
  return { status, role: role?.rolname ?? null, blocking, warnings };
}
