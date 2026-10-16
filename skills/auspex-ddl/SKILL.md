---
name: auspex-ddl
description: "Study an existing PostgreSQL table family (tables, functions, triggers, checks, log tables) through the read-only Auspex MCP server and design a similar one: summarize the pattern, choose json/jsonb and bytea/base64 types, CHECK constraints, BEFORE validation and AFTER log triggers, indexes and comments, then deliver an analysis note and a BEGIN...ROLLBACK DDL script that Auspex never executes. Use when the user asks to design or copy a table, integration table, import/staging table or trigger set."
---

# Auspex DDL design

Goal: a new table family that follows the database's own pattern, delivered
as an analysis note plus scripts the user runs. Auspex only reads; it never
creates anything.

## Hard rules

1. **Profile named by the user** in this conversation; otherwise
   `list_profiles` and ask. Never guess.
2. **Memory first.** `table_knowledge` on the example tables before any
   database call; follow remembered rules.
3. **Copy the house pattern, do not invent one.** Naming, key type, audit
   columns, log tables and trigger style come from the existing family.
   Anything the family does not show and the user did not state is a
   question, with a proposed default.
4. **Script shape.** Enforced: start with `BEGIN;`, last statement
   `ROLLBACK;`, never `COMMIT`, a `WHERE` on every `UPDATE`/`DELETE`.
   Recommended step structure inside: DEFINE / PROCESS / MATCH /
   CORRECT-or-FAIL, with a comment header per step. Schema-qualified names,
   explicit column lists.
5. **Auspex never executes them.** Every script goes through
   `save_execute_script`; the user runs it with a privileged role.
6. **Functions and triggers go into the same script.** `save_execute_script`
   accepts `CREATE [OR REPLACE] FUNCTION ... LANGUAGE plpgsql|sql AS $fn$ ...
   $fn$` and `CREATE [OR REPLACE] TRIGGER`. Bodies are not linted (the file
   header says so): review them yourself and tell the user. DO blocks, CALL
   and procedures stay rejected.
7. **No row values** from the example tables in notes or answers.
8. **Ask where to save, never invent it.** Before the first
   `save_execute_script`, ask once (see Delivery) and wait for a yes or a
   correction.
9. **Judge returned results item by item.** When the user runs a script and
   returns its result tables, answer every verification check YES or NO with the
   figures as evidence. Missing or unclear output is NO, with what is
   missing; never YES on partial data.

## Workflow

1. **Find the family.** `search` with the stem (for example `example`) for
   tables and columns. Functions and triggers: `describe_functions` when the
   server offers it; otherwise one catalog query each, see
   [catalog-queries.md](references/catalog-queries.md).
2. **Read the structure in one batch.** `describe_tables` with
   `detail: "full"` on every table of the family (columns, constraints,
   indexes, incoming keys; triggers, check constraints, sequences and
   partitions where the server returns them); the default summary leaves out
   the definitions a DDL needs.
   Function definitions in one call or query.
3. **Summarize the pattern** (analysis note, part 1):
   - naming (prefix, suffix, singular/plural, naming language);
   - key type (identity, serial, uuid) and audit columns (created/updated
     at/by, status, processed flags);
   - payload columns (json vs jsonb, bytea vs base64 text, sizes);
   - log/history tables and what writes them (trigger, application);
   - validation (CHECK, NOT NULL, BEFORE triggers, raised errors);
   - indexes (status + date for queues, GIN on jsonb, partial indexes);
   - comments present or missing.
4. **Ask what is open** (one message, max 3 questions, defaults proposed):
   tenant-specific fields, retention of payloads and logs, who reads the
   payload (database or application only).
5. **Design** with the trade-offs in
   [design-choices.md](references/design-choices.md): types, CHECK
   constraints, BEFORE INSERT/UPDATE validation trigger, AFTER trigger to the
   log table, indexes, comments on every table and column.
6. **Review** against the postgres-schema-reviewer (keys, types, nullability,
   indexes) and postgres-plpgsql-reviewer (NEW/OLD, TG_OP, exceptions,
   SECURITY DEFINER, search_path) skills. For rollout on a large live table
   use postgres-migration-architect; for any data backfill use
   postgres-safe-dml.
7. **Deliver** (see below), then ask for review. A changed script in a
   script root becomes a new file (named in the user's convention, asked
   first); `replace: true` only renews the library copy and only after the
   user asked.

## Delivery

- **Analysis note** (in the answer): existing pattern, design decisions with
  reasons and rejected options, open questions, risks (locks, size, payload
  growth).
- **Location question (one message, before saving).** Propose a location
  from `scriptRoots` in `list_profiles`: `<root>/<folder>/<file>.sql`. If
  you can read the folder (or see earlier files via `externalFile` entries
  in `list_reports`), follow the folder and numbering convention already
  used there; otherwise ask the user for the folder and their naming
  convention. Never invent a convention. List every file name. No script root
  configured: save to the library only and say so.
- **Save** each script with `save_execute_script` (db = profile, schema,
  category for example `Integration`, name like the file, plus `root`,
  `folder` and `fileName` after the user's yes). Tables, constraints,
  indexes, comments, log table, trigger functions and triggers go into one
  preview script, in dependency order. Write the title, purpose and script
  comments in the `notesLanguage` from `list_profiles` (ask once if null); the step markers (BEGIN, DEFINE, PROCESS, MATCH, CORRECT/FAIL, ROLLBACK) and SQL stay as written.
  Skeleton:
  [script-template.md](references/script-template.md). An existing file is
  never overwritten: on that error propose a new name and ask again.
- `purpose`, `expectedRows` (0 for pure DDL) and `relatedReport` filled in.
  Report the `warnings` (for example SECURITY DEFINER, a call to a function
  created in the script) to the user.
- **Summary in the answer** (not as a file unless asked): folder, one line
  per file (purpose, read-only or changing), run order, what to send back
  (the verification result tables), and that the final ROLLBACK is swapped
  for COMMIT only after every check is YES.

## Answer shape

Pattern summary, Design (table by table), Decisions and rejected options,
Location question or saved paths, Summary, Open questions, Risks.
After the user returns results: one YES/NO line per verification check with
evidence, then the next step.
