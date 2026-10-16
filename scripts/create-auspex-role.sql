-- Create the read-only "Auspex" login role on a real server (test or production)
-- Run in your SQL client as a superuser (or a role with CREATEROLE), connected to the
-- database Auspex will read. Then run grant-schemas-readonly.sql in the same database.
-- Before running: replace CHANGE_ME_STRONG_PASSWORD (also put it in pgpass, never in chat).
-- Does NOT revoke TEMP from PUBLIC: the application may rely on it; Auspex cannot
-- create temp tables anyway because every call runs in a READ ONLY transaction.
-- Last statement is ROLLBACK; swap it to COMMIT after reviewing the MATCH results.

-- 1. BEGIN
BEGIN;

-- 2. DEFINE
-- Scope: one new role "Auspex" (cluster-wide) + CONNECT on the current database.
-- Expected: role does not exist yet; password_encryption is scram-sha-256.
SELECT current_database() AS target_database,
       inet_server_addr() AS server_addr,
       current_setting('server_version') AS server_version,
       current_setting('password_encryption') AS password_encryption,  -- expected: scram-sha-256
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'Auspex') AS role_exists;  -- expected: false

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'Auspex') THEN
    RAISE EXCEPTION 'Role "Auspex" already exists on this server; skip this script and run only grant-schemas-readonly.sql.';
  END IF;
  IF current_setting('password_encryption') <> 'scram-sha-256' THEN
    RAISE EXCEPTION 'password_encryption is %, expected scram-sha-256.', current_setting('password_encryption');
  END IF;
END $$;

-- 3. PROCESS
CREATE ROLE "Auspex" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 3 PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
ALTER ROLE "Auspex" SET default_transaction_read_only = on;
ALTER ROLE "Auspex" SET statement_timeout = '30s';
ALTER ROLE "Auspex" SET idle_in_transaction_session_timeout = '60s';
COMMENT ON ROLE "Auspex" IS 'Read-only role for the Auspex MCP server (AI-assisted data analysis). No write privileges.';

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'Auspex');
END $$;

-- 4. MATCH
-- 4a. Role attributes (expected: login true, every other flag false, connlimit 3, 3 config entries)
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication,
       rolbypassrls, rolconnlimit, rolconfig
FROM pg_roles WHERE rolname = 'Auspex';

-- 4b. Password stored as SCRAM (expected: SCRAM-SHA-256$)
SELECT left(rolpassword, 14) AS hash_prefix FROM pg_authid WHERE rolname = 'Auspex';

-- 4c. Database privileges (expected: connect true, create false)
SELECT has_database_privilege('Auspex', current_database(), 'CONNECT') AS can_connect,
       has_database_privilege('Auspex', current_database(), 'CREATE') AS can_create_schema;

-- 4d. Role memberships (expected: 0 rows; a membership could pass on other privileges)
SELECT r.rolname AS member_of
FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'Auspex');

-- 4e. Tables already writable by PUBLIC (Auspex inherits PUBLIC grants; expected: 0 rows)
SELECT n.nspname AS schema_name, c.relname AS relation, string_agg(DISTINCT p.privilege_type, ', ') AS public_privileges
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) p
WHERE p.grantee = 0 AND p.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  AND c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 50;

-- 5. CORRECT or FAIL
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'Auspex';
  IF NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'FAIL: unexpected role attributes for "Auspex"';
  END IF;
  IF has_database_privilege('Auspex', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'FAIL: "Auspex" can create schemas in this database';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN
    RAISE EXCEPTION 'FAIL: "Auspex" is a member of another role';
  END IF;
  RAISE NOTICE 'OK: role checks passed (review 4e separately: PUBLIC write grants apply to "Auspex" too)';
END $$;

-- 6. ROLLBACK (swap to COMMIT after reviewing the MATCH results)
ROLLBACK;
