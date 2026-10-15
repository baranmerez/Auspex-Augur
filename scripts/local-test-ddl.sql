-- Auspex local test setup, part 2: DDL objects (LOCAL PostgreSQL 16 only, never production)
-- Run in DBeaver connected as a superuser to the local "postgres" database, AFTER
-- scripts/local-test-setup.sql was committed. CI runs both scripts in that order.
-- Adds the objects the catalog tools describe (triggers, functions, checks,
-- identity/serial/generated columns, partitioning, row level security) and
-- runs ANALYZE so planner statistics exist for relation_stats.
-- Last statement is ROLLBACK; swap it to COMMIT after the MATCH results look right.

-- 1. BEGIN
BEGIN;

-- 2. DEFINE
-- Scope: local database only, schema auspex_test. Objects created:
--   import_job        4 rows: identity id, serial batch_no, FK region_id (1 of 4 NULL),
--                     CHECK on status, jsonb payload, base64 text, generated column,
--                     BEFORE INSERT OR UPDATE trigger with a WHEN condition, table comment
--   import_log        partitioned by range (logged_on), 2 partitions, FK -> import_job, 3 rows
--   import_secret     FK -> import_job, row level security enabled, NO grant to "Auspex", 1 row
--   functions         import_job_before_validate() (trigger), import_job_count(integer) (sql)
-- Grants: "Auspex" can SELECT import_job and import_log (not the partitions, not import_secret).
-- ANALYZE: import_job, import_log (statistics only, no data change).
DO $$
BEGIN
  IF current_database() <> 'postgres' OR inet_server_addr() IS NOT NULL AND host(inet_server_addr()) NOT IN ('127.0.0.1', '::1') THEN
    RAISE EXCEPTION 'Run this only on the local server, database postgres (got % on %).', current_database(), inet_server_addr();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auspex_test') THEN
    RAISE EXCEPTION 'Schema auspex_test is missing; run scripts/local-test-setup.sql first.';
  END IF;
  IF to_regclass('auspex_test.import_job') IS NOT NULL THEN
    RAISE EXCEPTION 'auspex_test.import_job already exists; this script was applied already.';
  END IF;
END $$;

-- 3. PROCESS
CREATE TABLE auspex_test.import_job (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_no           serial NOT NULL,
  region_id          integer REFERENCES auspex_test.region (id),
  status             text NOT NULL DEFAULT 'new' CONSTRAINT import_job_status_check CHECK (status IN ('new', 'valid', 'error')),
  payload            jsonb NOT NULL,
  payload_b64        text,
  payload_b64_length integer GENERATED ALWAYS AS (length(payload_b64)) STORED,
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auspex_test.import_job IS 'Test import staging with a before-validate trigger';

CREATE FUNCTION auspex_test.import_job_before_validate() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF jsonb_typeof(NEW.payload) <> 'object' THEN
    NEW.status := 'error';
  ELSE
    NEW.status := 'valid';
  END IF;
  RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION auspex_test.import_job_before_validate() IS 'Validates the payload before insert or update';

CREATE TRIGGER import_job_validate
  BEFORE INSERT OR UPDATE OF payload ON auspex_test.import_job
  FOR EACH ROW WHEN (NEW.payload IS NOT NULL)
  EXECUTE FUNCTION auspex_test.import_job_before_validate();

CREATE FUNCTION auspex_test.import_job_count(p_region integer) RETURNS bigint
  LANGUAGE sql STABLE AS $fn$ SELECT count(*) FROM auspex_test.import_job WHERE region_id = p_region $fn$;

CREATE TABLE auspex_test.import_log (
  job_id    bigint NOT NULL REFERENCES auspex_test.import_job (id),
  logged_on date NOT NULL,
  message   text
) PARTITION BY RANGE (logged_on);
CREATE TABLE auspex_test.import_log_2026_01 PARTITION OF auspex_test.import_log FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE auspex_test.import_log_2026_02 PARTITION OF auspex_test.import_log FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

CREATE TABLE auspex_test.import_secret (
  job_id bigint NOT NULL REFERENCES auspex_test.import_job (id),
  token  text
);
ALTER TABLE auspex_test.import_secret ENABLE ROW LEVEL SECURITY;

INSERT INTO auspex_test.import_job (region_id, payload, payload_b64) VALUES
  (1,    '{"firma": "Arosia", "satır": 1}', 'eyJhIjoxfQ=='),
  (1,    '{"firma": "Arosia", "satır": 2}', NULL),
  (2,    '[1, 2]',                          NULL),
  (NULL, '{"firma": "Diğer"}',              'e30=');
INSERT INTO auspex_test.import_log (job_id, logged_on, message) VALUES
  (1, '2026-01-10', 'ok'), (2, '2026-01-11', 'ok'), (3, '2026-02-01', 'hata');
INSERT INTO auspex_test.import_secret (job_id, token) VALUES (1, 'never read by "Auspex"');

GRANT SELECT ON auspex_test.import_job, auspex_test.import_log TO "Auspex";

-- Only the new tables: region and worker stay never analyzed, which other tests rely on
-- (profile_tables would switch worker to TABLESAMPLE once it has an estimate).
ANALYZE auspex_test.import_job, auspex_test.import_log;

-- 4. MATCH
-- 4a. Row counts (expected: import_job 4, import_log 3, import_secret 1; status set by the trigger)
SELECT 'import_job' AS tbl, count(*) AS actual, 4 AS expected FROM auspex_test.import_job
UNION ALL SELECT 'import_log', count(*), 3 FROM auspex_test.import_log
UNION ALL SELECT 'import_secret', count(*), 1 FROM auspex_test.import_secret
UNION ALL SELECT 'import_job status=error', count(*), 1 FROM auspex_test.import_job WHERE status = 'error';

-- 4b. Privileges of "Auspex"
SELECT obj, has_priv AS actual, expected
FROM (VALUES
  ('auspex_test.import_job SELECT',    has_table_privilege('Auspex', 'auspex_test.import_job', 'SELECT'),    true),
  ('auspex_test.import_log SELECT',    has_table_privilege('Auspex', 'auspex_test.import_log', 'SELECT'),    true),
  ('auspex_test.import_secret SELECT', has_table_privilege('Auspex', 'auspex_test.import_secret', 'SELECT'), false),
  ('auspex_test.import_job INSERT',    has_table_privilege('Auspex', 'auspex_test.import_job', 'INSERT'),    false)
) AS t(obj, has_priv, expected);

-- 4c. Statistics (expected: reltuples 4 and null_frac 0.25 for import_job.region_id)
SELECT c.relname, c.reltuples, s.attname, s.null_frac
FROM pg_class c
LEFT JOIN pg_stats s ON s.schemaname = 'auspex_test' AND s.tablename = c.relname AND s.attname = 'region_id' AND NOT s.inherited
WHERE c.oid = 'auspex_test.import_job'::regclass;

-- 5. CORRECT or FAIL
DO $$
BEGIN
  IF (SELECT count(*) FROM auspex_test.import_job) <> 4 OR (SELECT count(*) FROM auspex_test.import_log) <> 3 THEN
    RAISE EXCEPTION 'FAIL: unexpected row counts';
  END IF;
  IF has_table_privilege('Auspex', 'auspex_test.import_secret', 'SELECT')
     OR has_table_privilege('Auspex', 'auspex_test.import_job', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL: "Auspex" has a privilege it must not have';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'import_job_validate' AND tgrelid = 'auspex_test.import_job'::regclass) THEN
    RAISE EXCEPTION 'FAIL: trigger import_job_validate missing';
  END IF;
  RAISE NOTICE 'OK: all checks passed';
END $$;

-- 6. ROLLBACK (swap to COMMIT after reviewing the MATCH results)
ROLLBACK;
