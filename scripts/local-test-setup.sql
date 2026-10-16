-- Auspex local test setup (LOCAL PostgreSQL 16 only, never production)
-- Run in your SQL client connected as a superuser to the local "postgres" database.
-- Creates schema auspex_test with sample data and a read-only login role "Auspex".
-- Before running: replace CHANGE_ME_LOCAL_TEST_PASSWORD below.
-- Last statement is ROLLBACK; swap it to COMMIT after the MATCH results look right.

-- 1. BEGIN
BEGIN;

-- 2. DEFINE
-- Scope: local database only. Objects created:
--   role   "Auspex" (LOGIN, no superuser/createdb/createrole)
--   schema auspex_test: region (3 rows), worker (5 rows, FK -> region),
--          secret_note (1 row, NO grant to "Auspex"), v_worker_region (view)
-- Expected: "Auspex" can SELECT region, worker, v_worker_region; cannot SELECT secret_note;
--           cannot INSERT/UPDATE/DELETE anything.
DO $$
BEGIN
  IF current_database() <> 'postgres' OR inet_server_addr() IS NOT NULL AND host(inet_server_addr()) NOT IN ('127.0.0.1', '::1') THEN
    RAISE EXCEPTION 'Run this only on the local server, database postgres (got % on %).', current_database(), inet_server_addr();
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'Auspex') THEN
    RAISE EXCEPTION 'Role "Auspex" already exists; drop it first or skip this script.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auspex_test') THEN
    RAISE EXCEPTION 'Schema auspex_test already exists; drop it first or skip this script.';
  END IF;
END $$;

-- 3. PROCESS
CREATE ROLE "Auspex" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
  CONNECTION LIMIT 3 PASSWORD 'CHANGE_ME_LOCAL_TEST_PASSWORD';
ALTER ROLE "Auspex" SET default_transaction_read_only = on;
ALTER ROLE "Auspex" SET statement_timeout = '30s';
ALTER ROLE "Auspex" SET idle_in_transaction_session_timeout = '60s';

CREATE SCHEMA auspex_test;
COMMENT ON SCHEMA auspex_test IS 'Auspex MCP local test data';

CREATE TABLE auspex_test.region (
  id     integer PRIMARY KEY,
  name   text NOT NULL UNIQUE
);
COMMENT ON TABLE auspex_test.region IS 'Test regions';

CREATE TABLE auspex_test.worker (
  id         integer PRIMARY KEY,
  region_id  integer NOT NULL REFERENCES auspex_test.region (id),
  full_name  text NOT NULL,
  daily_wage numeric(12,2),
  started_on date NOT NULL,
  note       text
);
CREATE INDEX worker_region_idx ON auspex_test.worker (region_id);
COMMENT ON COLUMN auspex_test.worker.daily_wage IS 'Daily wage (TRY)';

CREATE TABLE auspex_test.secret_note (
  id   integer PRIMARY KEY,
  body text NOT NULL
);

CREATE VIEW auspex_test.v_worker_region AS
SELECT w.id, w.full_name, r.name AS region_name, w.daily_wage
FROM auspex_test.worker w
JOIN auspex_test.region r ON r.id = w.region_id;

INSERT INTO auspex_test.region (id, name) VALUES
  (1, 'Ege'), (2, 'Akdeniz'), (3, 'İç Anadolu');

INSERT INTO auspex_test.worker (id, region_id, full_name, daily_wage, started_on, note) VALUES
  (1, 1, 'Ayşe Yılmaz',  1250.00, '2026-01-05', 'ilk; kayıt'),
  (2, 1, 'Mehmet Kaya',  1100.50, '2026-02-10', 'tırnak "test"'),
  (3, 2, 'Zeynep Çelik', 1300.00, '2026-03-15', NULL),
  (4, 3, 'Ali Öztürk',    980.75, '2026-04-20', 'satır
sonu'),
  (5, 3, 'Fatma Şahin',  NULL,    '2026-05-25', 'ücret yok');

INSERT INTO auspex_test.secret_note (id, body) VALUES (1, '"Auspex" must never read this');

REVOKE ALL ON SCHEMA auspex_test FROM PUBLIC;
GRANT USAGE ON SCHEMA auspex_test TO "Auspex";
GRANT SELECT ON auspex_test.region, auspex_test.worker, auspex_test.v_worker_region TO "Auspex";
REVOKE TEMPORARY ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO "Auspex";

-- 4. MATCH
-- 4a. Row counts (expected: region 3, worker 5, secret_note 1)
SELECT 'region' AS tbl, count(*) AS actual, 3 AS expected FROM auspex_test.region
UNION ALL SELECT 'worker', count(*), 5 FROM auspex_test.worker
UNION ALL SELECT 'secret_note', count(*), 1 FROM auspex_test.secret_note;

-- 4b. Privileges of "Auspex" (expected column shown next to actual)
SELECT obj, priv, has_priv AS actual, expected
FROM (VALUES
  ('auspex_test.region',          'SELECT', has_table_privilege('Auspex', 'auspex_test.region', 'SELECT'),          true),
  ('auspex_test.worker',          'SELECT', has_table_privilege('Auspex', 'auspex_test.worker', 'SELECT'),          true),
  ('auspex_test.v_worker_region', 'SELECT', has_table_privilege('Auspex', 'auspex_test.v_worker_region', 'SELECT'), true),
  ('auspex_test.secret_note',     'SELECT', has_table_privilege('Auspex', 'auspex_test.secret_note', 'SELECT'),     false),
  ('auspex_test.worker',          'INSERT', has_table_privilege('Auspex', 'auspex_test.worker', 'INSERT'),          false),
  ('auspex_test.worker',          'UPDATE', has_table_privilege('Auspex', 'auspex_test.worker', 'UPDATE'),          false),
  ('auspex_test.worker',          'DELETE', has_table_privilege('Auspex', 'auspex_test.worker', 'DELETE'),          false),
  ('auspex_test',                 'CREATE', has_schema_privilege('Auspex', 'auspex_test', 'CREATE'),                false),
  ('postgres',                    'TEMP',   has_database_privilege('Auspex', 'postgres', 'TEMP'),                   false)
) AS t(obj, priv, has_priv, expected);

-- 4c. Role attributes (expected: all false, connlimit 3)
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit, rolconfig
FROM pg_roles WHERE rolname = 'Auspex';

-- 5. CORRECT or FAIL
DO $$
BEGIN
  IF (SELECT count(*) FROM auspex_test.worker) <> 5 OR (SELECT count(*) FROM auspex_test.region) <> 3 THEN
    RAISE EXCEPTION 'FAIL: unexpected row counts';
  END IF;
  IF has_table_privilege('Auspex', 'auspex_test.secret_note', 'SELECT')
     OR has_table_privilege('Auspex', 'auspex_test.worker', 'INSERT')
     OR has_schema_privilege('Auspex', 'auspex_test', 'CREATE')
     OR has_database_privilege('Auspex', 'postgres', 'TEMP') THEN
    RAISE EXCEPTION 'FAIL: "Auspex" has a privilege it must not have';
  END IF;
  IF NOT has_table_privilege('Auspex', 'auspex_test.worker', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: "Auspex" cannot SELECT auspex_test.worker';
  END IF;
  RAISE NOTICE 'OK: all checks passed';
END $$;

-- 6. ROLLBACK (swap to COMMIT after reviewing the MATCH results)
ROLLBACK;
