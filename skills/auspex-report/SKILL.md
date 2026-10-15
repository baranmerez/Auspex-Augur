---
name: auspex-report
description: "Build a combined analysis report through the read-only Auspex MCP server: clarify period, filters and output in one round, apply remembered business rules, resolve status codes from lookup tables, guard against join fan-out, duplicates, NULLs and cancelled rows, then save, run and hand over the report from the Auspex report library. Use when the user asks for a report, summary, totals or a grouped list from database tables. TR: rapor, sipariş raporu, fatura raporu, bölge/personel bazında toplam, gruplama, hasarlı/sorunlu barkod, rapor kütüphanesi, Auspex."
---

# Auspex report

Goal: a correct, reusable report in the library with one round of questions
and the fewest statements. Correctness first: a wrong total is worse than a
late one.

## Hard rules

1. **Profile named by the user** in this conversation; otherwise
   `list_profiles` and ask. Never guess.
2. **Memory first.** `table_knowledge` on the tables you know by name before
   any database call. Rules in `databaseNotes` and table notes are applied as
   defaults and shown to the user; never ask for them again.
3. **One question round, at most 3 questions,** in one message, each with a
   proposed default. Never ask what memory, the request or the catalog
   already answers.
4. **Never invent a business rule or a code meaning.** Status codes are read
   from lookup tables and confirmed by the user before they filter a report.
5. **Grain before join.** Every 1:N child is pre-aggregated to the parent key
   before it is joined (see [correctness-checks.md](references/correctness-checks.md)).
6. **Plan before run.** `explain` (estimated, no analyze) before the first
   run. A query that needs more than the default timeout, or EXPLAIN ANALYZE
   on a large table: tell the user the table, estimated rows and reason first.
7. **Approval is the user's.** `approve_report` only after the user
   explicitly approved this report in this conversation.
8. **No personal values** in answers or notes; masked previews only.

## Workflow

1. **Profile, memory, parse.** Profile check. `table_knowledge` on named
   tables. Split the request into: period and date column, filters, grain
   (one row per what), output columns, grouping, sums/counts, joined sources,
   special states to check (for example damaged or problem barcodes).
2. **Questions (one message, max 3).** Only for gaps; use
   [question-templates.md](references/question-templates.md):
   - period, filter and which date column defines it;
   - tables or codes the user already knows;
   - output columns, grouping and sums.
   List the remembered rules you will apply as defaults, for example
   "order reports: durumid > 50, cancelled excluded (memory rule)".
3. **Locate.** `search` for missing tables; one `describe_tables` for all
   involved tables; `relation_stats` (when available) or foreign keys for
   join paths. Follow the auspex-explore skill for unknown areas.
4. **Resolve codes.** For each ambiguous state (for example "damaged" vs
   "delivery problem"), find the lookup table, read its code list with one
   small query, propose the codes and confirm them with the user. Save the
   confirmed mapping with `remember kind=rule`.
5. **Measure risk.** One `profile_tables` call with `parent` = the report's
   driving table and `window` = the period: fan-out of every child, fill rate
   of join and filter columns.
6. **Write SQL.** CTE per source, children aggregated to the parent key,
   explicit column list, filters from step 2, NULL handling stated,
   cancelled rows excluded per rule. Checklist:
   [correctness-checks.md](references/correctness-checks.md).
7. **Explain.** `explain` without analyze. Check for sequential scans on
   large tables and row estimates that explode after a join. Narrow by
   indexed columns before running.
8. **Save and run.** `save_report` with db = profile, schema = main schema,
   a category (ask once if unclear, default `General`), a kebab-case name,
   title and description stating the definitions. Then `run_report`.
9. **Hand over.** Summary: row count, totals, timings, warnings, the HTML
   path, rules and codes applied, assumptions. Ask for approval; iterate
   with new SQL versions via `save_report`.
10. **After approval:** `approve_report`. Mention `unexploredNeighbors` and
    ask before exploring them.

## Reconcile before handing over

- Total of the report = total of the driving table for the same filters
  (one aggregate query, or `profile_tables` figures).
- Row count of the report = distinct parent keys at the report grain.
- A mismatch is reported, not hidden; fix the SQL and save a new version.

For deeper review use the postgres-performance-doctor (slow plan),
sql-data-reconciliation (totals do not match) or sql-query-reviewer skills.

## Answer shape

Result (figures with definitions), Rules and codes applied, Assumptions,
Report (category/name, version, HTML path), Statements used, Next
(approval, open questions).
