# Script skeleton (recommended step structure)

Enforced for every script: `BEGIN;` first, `ROLLBACK;` last, never
`COMMIT`, no DML without WHERE. Recommended: the DEFINE / PROCESS / MATCH /
CORRECT or FAIL steps below, with a comment header per step.
Schema-qualified names and explicit column lists. `save_execute_script` accepts `CREATE [OR REPLACE] FUNCTION`
with `LANGUAGE plpgsql` or `sql` and one dollar-quoted body, and
`CREATE TRIGGER`; it rejects procedures, DO blocks, CALL, MERGE and psql
backslash commands. Function bodies are not linted: review them.

## Preview script: tables, trigger functions and triggers

```sql
BEGIN;

-- =====================================================================
-- DEFINE: scope and expectations
--   New objects: <schema>.<name>_import, <schema>.<name>_import_log
--   Expected: both tables absent before, present after; 0 data rows.
-- =====================================================================
SELECT 'DEFINE: objects that already exist (expect 0 rows)' AS check_name,
       c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = '<schema>'
  AND c.relname IN ('<name>_import', '<name>_import_log');

-- =====================================================================
-- PROCESS: DDL
-- =====================================================================
CREATE TABLE <schema>.<name>_import (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_no   text        NOT NULL,
  payload       jsonb       NOT NULL,
  file_base64   text,
  status        smallint    NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  CONSTRAINT <name>_import_external_no_uq UNIQUE (external_no),
  CONSTRAINT <name>_import_payload_chk CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT <name>_import_status_chk CHECK (status IN (<allowed codes>))
);
COMMENT ON TABLE <schema>.<name>_import IS '<purpose, source system>';
COMMENT ON COLUMN <schema>.<name>_import.status IS '<allowed values and meaning>';
-- log table, indexes, remaining comments ...

CREATE OR REPLACE FUNCTION <schema>.<name>_import_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = <schema>, pg_temp
AS $fn$
BEGIN
  -- validation; RAISE EXCEPTION with an ERRCODE the application knows
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

CREATE TRIGGER <name>_import_before_write_trg
BEFORE INSERT OR UPDATE ON <schema>.<name>_import
FOR EACH ROW EXECUTE FUNCTION <schema>.<name>_import_before_write();
-- AFTER trigger to the log table in the same way ...

-- =====================================================================
-- MATCH: verification
-- =====================================================================
SELECT 'MATCH: tables created (expect 2)' AS check_name, count(*) AS actual
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = '<schema>'
  AND c.relname IN ('<name>_import', '<name>_import_log');

SELECT 'MATCH: constraints' AS check_name, conrelid::regclass AS table_name,
       conname, contype
FROM pg_constraint
WHERE conrelid IN ('<schema>.<name>_import'::regclass, '<schema>.<name>_import_log'::regclass)
ORDER BY 2, 3;

SELECT 'MATCH: indexes' AS check_name, tablename, indexname
FROM pg_indexes
WHERE schemaname = '<schema>' AND tablename IN ('<name>_import', '<name>_import_log')
ORDER BY 2, 3;

-- =====================================================================
-- CORRECT or FAIL: compare expected vs actual above. Any mismatch:
-- stop and keep the ROLLBACK below.
-- =====================================================================

ROLLBACK;
```

## Trigger checks in the same script

MATCH also lists the functions and triggers from `pg_trigger` / `pg_proc`
and runs the validation cases that must fail or pass, each in its own
`SAVEPOINT` / `ROLLBACK TO SAVEPOINT` pair (these statements run the
trigger bodies; `save_execute_script` warns when a script calls a function
it created):

```sql
SAVEPOINT bad_payload;
-- expect: error from the BEFORE trigger with SQLSTATE <code>
INSERT INTO <schema>.<name>_import (external_no, payload) VALUES ('T-1', '[]');
ROLLBACK TO SAVEPOINT bad_payload;
```

A statement that raises an error aborts the rest of a plain script run;
tell the user to run such checks one by one, or to read the expected error
and continue from the next SAVEPOINT. State the run order of the files in
the summary of the answer.
