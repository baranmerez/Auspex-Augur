# Catalog queries for functions and triggers

Use these only when the server has no tool for functions or triggers
(`describe_functions`, triggers in `describe_tables`). Each is one `query`
call with the name stem as `$1` (for example `%example%`); three statements
cover the whole family. They read the system catalog only and pass the
Auspex SQL guard as written.

## 1. Functions by name or body

```sql
SELECT n.nspname AS schema_name, p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       pg_get_function_result(p.oid) AS returns,
       l.lanname AS language, p.prokind AS kind,
       p.prosecdef AS security_definer, p.provolatile AS volatility,
       p.proname ILIKE $1 AS name_match
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (p.proname ILIKE $1 OR p.prosrc ILIKE $1)
ORDER BY 1, 2
```

`name_match = false` rows mention the stem only in their body (for example a
generic logger that writes to the family's tables).

## 2. Function definitions

```sql
SELECT p.oid::regprocedure AS function_signature, pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND p.prokind IN ('f', 'p')
  AND (p.proname ILIKE $1 OR p.prosrc ILIKE $1)
ORDER BY 1
```

Definitions can be long; when more than about 10 functions match, list them
with query 1 first and fetch definitions only for the ones the design copies.

## 3. Triggers on the family

```sql
SELECT c.relnamespace::regnamespace AS schema_name, c.relname AS table_name,
       t.tgname AS trigger_name, t.tgfoid::regproc AS function_name,
       t.tgenabled AS enabled, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND (c.relname ILIKE $1 OR p.proname ILIKE $1 OR t.tgname ILIKE $1)
ORDER BY 1, 2, 3
```

`enabled`: `O` = fires normally, `D` = disabled, `R` / `A` = replica /
always. A disabled trigger in the example is a question for the user, not a
pattern to copy.

## What to note from them

- BEFORE vs AFTER, ROW vs STATEMENT, which events, WHEN conditions.
- How validation fails (RAISE EXCEPTION with which ERRCODE and message).
- What the log trigger writes (full row as json, changed columns, user,
  time) and into which table.
- SECURITY DEFINER and a fixed `search_path` on functions.
