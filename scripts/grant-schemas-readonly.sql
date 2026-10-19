-- Grant read-only access on schemas to the "Auspex" login role
-- Fill in 2. DEFINE: the schema list (or leave it empty for every non-system
-- schema). Run as a superuser or as the owner of the tables.
-- Grants CONNECT on this database, SELECT on existing relations and default
-- SELECT for relations that the current owners create later. Last statement
-- is ROLLBACK.
-- CREATE on a schema that comes only from PUBLIC (for example the PostgreSQL
-- 14-and-older default on schema public, or a GRANT ... TO PUBLIC) is reported
-- as a warning, not a failure: Auspex runs every query in a READ ONLY
-- transaction. Revoking it from PUBLIC is a decision for the DBA, since other
-- roles may rely on it. CREATE granted to "Auspex" itself is a failure.

-- 1. BEGIN
BEGIN;

-- 2. DEFINE
-- The only place to edit: one row per schema, e.g. ('example').
-- Leave the table empty (delete the INSERT) to target every non-system schema.
CREATE TEMP TABLE requested_schema (schema_name name PRIMARY KEY) ON COMMIT DROP;
INSERT INTO requested_schema (schema_name) VALUES ('example');

CREATE TEMP TABLE grant_target ON COMMIT DROP AS
SELECT n.nspname AS schema_name
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  AND (NOT EXISTS (SELECT 1 FROM requested_schema)
       OR n.nspname IN (SELECT schema_name FROM requested_schema));

-- 2a. Requested schemas that do not exist (expected: 0 rows)
SELECT r.schema_name AS missing_schema
FROM requested_schema r
WHERE r.schema_name NOT IN (SELECT schema_name FROM grant_target);

-- 2b. Target schemas, relation counts and owners (owners get default privileges)
SELECT g.schema_name, pg_get_userbyid(c.relowner) AS owner, count(c.oid) AS relations
FROM grant_target g
JOIN pg_namespace n ON n.nspname = g.schema_name
LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f')
GROUP BY 1, 2 ORDER BY 1, 2;

-- 3. PROCESS
DO $$
DECLARE
  s record;
  o record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'Auspex') THEN
    RAISE EXCEPTION 'FAIL: role "Auspex" does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM requested_schema r WHERE r.schema_name NOT IN (SELECT schema_name FROM grant_target)) THEN
    RAISE EXCEPTION 'FAIL: requested schema(s) not found (names are case-sensitive): %. Existing schemas: %',
      (SELECT string_agg(r.schema_name, ', ') FROM requested_schema r WHERE r.schema_name NOT IN (SELECT schema_name FROM grant_target)),
      (SELECT string_agg(nspname, ', ' ORDER BY nspname) FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM grant_target) THEN
    RAISE EXCEPTION 'FAIL: no target schemas';
  END IF;
  -- Also when the role already existed for another database on this server.
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'Auspex');
  FOR s IN SELECT schema_name FROM grant_target LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s.schema_name, 'Auspex');
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', s.schema_name, 'Auspex');
    FOR o IN
      SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = s.schema_name AND c.relkind IN ('r','p','v','m','f')
    LOOP
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON TABLES TO %I', o.owner, s.schema_name, 'Auspex');
    END LOOP;
  END LOOP;
END $$;

-- 4. MATCH
-- 4a. Per schema (expected: readable = total, writable = 0, usage true; can_create
--     false, or true only where create_from_public is true: see the warning in 5)
SELECT g.schema_name,
       count(c.oid) AS total,
       count(c.oid) FILTER (WHERE has_table_privilege('Auspex', c.oid, 'SELECT')) AS readable,
       count(c.oid) FILTER (WHERE has_table_privilege('Auspex', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')) AS writable,
       has_schema_privilege('Auspex', g.schema_name, 'USAGE') AS usage,
       has_schema_privilege('Auspex', g.schema_name, 'CREATE') AS can_create,
       EXISTS (SELECT 1 FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'CREATE') AS create_from_public
FROM grant_target g
JOIN pg_namespace n ON n.nspname = g.schema_name
LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f')
GROUP BY g.schema_name, n.nspacl, n.nspowner ORDER BY 1;

-- 4b. Default privileges recorded for "Auspex" (expected: one row per schema and owner)
SELECT n.nspname AS schema_name, pg_get_userbyid(d.defaclrole) AS for_owner, d.defaclacl::text AS acl
FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname IN (SELECT schema_name FROM grant_target) AND d.defaclacl::text LIKE '%Auspex%'
ORDER BY 1, 2;

-- 4c. Database privileges (expected: connect true, create false)
SELECT has_database_privilege('Auspex', current_database(), 'CONNECT') AS can_connect,
       has_database_privilege('Auspex', current_database(), 'CREATE') AS can_create_schema;

-- 5. CORRECT or FAIL
DO $$
DECLARE warn text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM grant_target g JOIN pg_namespace n ON n.nspname = g.schema_name
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f')
    WHERE NOT has_table_privilege('Auspex', c.oid, 'SELECT')
       OR has_table_privilege('Auspex', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')) THEN
    RAISE EXCEPTION 'FAIL: a relation is not readable or is writable by "Auspex"';
  END IF;
  IF EXISTS (SELECT 1 FROM grant_target g WHERE NOT has_schema_privilege('Auspex', g.schema_name, 'USAGE')) THEN
    RAISE EXCEPTION 'FAIL: "Auspex" has no USAGE on a target schema';
  END IF;
  IF NOT has_database_privilege('Auspex', current_database(), 'CONNECT')
     OR has_database_privilege('Auspex', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'FAIL: database privilege mismatch for "Auspex" (expected CONNECT without CREATE)';
  END IF;
  -- CREATE granted to "Auspex" itself, or CREATE that does not come from PUBLIC
  -- (then through a role "Auspex" belongs to).
  IF EXISTS (
    SELECT 1 FROM grant_target g JOIN pg_namespace n ON n.nspname = g.schema_name
    WHERE EXISTS (SELECT 1 FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                  WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'Auspex') AND a.privilege_type = 'CREATE')
       OR (has_schema_privilege('Auspex', n.oid, 'CREATE')
           AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                           WHERE a.grantee = 0 AND a.privilege_type = 'CREATE'))) THEN
    RAISE EXCEPTION 'FAIL: "Auspex" was granted CREATE on a schema';
  END IF;
  SELECT string_agg(g.schema_name, ', ' ORDER BY g.schema_name) INTO warn
  FROM grant_target g WHERE has_schema_privilege('Auspex', g.schema_name, 'CREATE');
  IF warn IS NOT NULL THEN
    RAISE NOTICE 'WARNING: CREATE through PUBLIC on: % (blocked by the READ ONLY transaction; REVOKE CREATE ON SCHEMA ... FROM PUBLIC is a DBA decision)', warn;
  END IF;
  RAISE NOTICE 'OK: all checks passed';
END $$;

-- 6. ROLLBACK (swap to COMMIT after reviewing the MATCH results)
ROLLBACK;
