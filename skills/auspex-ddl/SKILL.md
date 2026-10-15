---
name: auspex-ddl
description: "Study an existing PostgreSQL table family (tables, functions, triggers, checks, log tables) through the read-only Auspex MCP server and design a similar one: summarize the pattern, choose json/jsonb and bytea/base64 types, CHECK constraints, BEFORE validation and AFTER log triggers, indexes and comments, then deliver an analysis note and a BEGIN...ROLLBACK DDL script that Auspex never executes. Use when the user asks to design or copy a table, integration table, import/staging table or trigger set. TR: DDL, tablo tasarımı, benzer tablo oluştur, entegrasyon tablosu, import tablosu, trigger, log tablosu, check constraint, json/base64 kolon, Auspex."
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
4. **Scripts follow the mandatory flow:** `BEGIN;` DEFINE / PROCESS / MATCH /
   CORRECT-or-FAIL, last statement `ROLLBACK;`. Never `COMMIT`. Comment
   header per step. Schema-qualified names, explicit column lists.
5. **Auspex never executes them.** The table script goes through
   `save_execute_script`; the user runs it with a privileged role.
6. **Function bodies are not accepted by `save_execute_script`** (CREATE
   FUNCTION / PROCEDURE and DO blocks are rejected because their bodies
   cannot be checked). Deliver trigger functions as a separate script in the
   answer and state the run order (see Delivery).
7. **No row values** from the example tables in notes or answers.

## Workflow

1. **Find the family.** `search` with the stem (for example `example_co`) for
   tables and columns. Functions and triggers: `describe_functions` when the
   server offers it; otherwise one catalog query each, see
   [catalog-queries.md](references/catalog-queries.md).
2. **Read the structure in one batch.** `describe_tables` on every table of
   the family (columns, constraints, indexes, incoming keys; triggers, check
   constraints, sequences and partitions where the server returns them).
   Function definitions in one call or query.
3. **Summarize the pattern** (analysis note, part 1):
   - naming (prefix, suffix, singular/plural, Turkish/English);
   - key type (identity, serial, uuid) and audit columns (created/updated
     at/by, status, processed flags);
   - payload columns (json vs jsonb, bytea vs base64 text, sizes);
   - log/history tables and what writes them (trigger, application);
   - validation (CHECK, NOT NULL, BEFORE triggers, raised errors);
   - indexes (status + date for queues, GIN on jsonb, partial indexes);
   - comments present or missing.
4. **Ask what is open** (one message, max 3 questions, defaults proposed):
   firm-specific fields, retention of payloads and logs, who reads the
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
7. **Deliver** (see below), then ask for review; change via
   `save_execute_script` with `replace: true` only after the user asked.

## Delivery

- **Analysis note** (in the answer): existing pattern, design decisions with
  reasons and rejected options, open questions, risks (locks, size, payload
  growth).
- **Script A, tables** via `save_execute_script` (db = profile, schema,
  category for example `Integration`, name `<firm>-tables`): CREATE TABLE,
  constraints, indexes, comments, log table. Skeleton:
  [script-template.md](references/script-template.md).
- **Script B, trigger functions and triggers** in the answer as a SQL block
  with the same flow (Auspex will not store it). It depends on script A.
- **Run order and dry run:** say that B needs A's tables, and that with
  ROLLBACK at the end of A, B cannot be dry-run on its own. Offer the
  options (run both in one session before a single ROLLBACK, or review and
  commit A first) and let the user choose; never choose for them.
- `purpose`, `expectedRows` (0 for pure DDL) and `relatedReport` filled in
  `save_execute_script`. Report its `warnings` to the user.

## Answer shape

Pattern summary, Design (table by table), Decisions and rejected options,
Script A path, Script B text, Run order, Open questions, Risks.
