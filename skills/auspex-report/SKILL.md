---
name: auspex-report
description: "Build a combined analysis report through the read-only Auspex MCP server: clarify period, filters and output in one round, apply remembered business rules, resolve status codes from their source, guard against join fan-out, duplicates, NULLs and rows in excluded states, then save, run and hand over the report from the Auspex report library. Use when the user asks for a report, summary, totals or a grouped list from database tables."
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
   defaults and shown to the user; never ask for them again. Also read
   `columnScores` and trigger `summary` when present: prefer score 4-5 columns
   for output and filters and treat score 1-2 or unused columns as low value;
   a trigger may rewrite or reject values, so read its summary (a
   `summaryStale` summary is a hint, not a fact). If a table has no scores, say
   so and offer the `auspex-columns` skill; never block a report on missing
   scores. Scores are advisory: rules from the user and remembered rules win.
3. **One question round, at most 3 questions,** in one message, each with a
   proposed default. Never ask what memory, the request or the catalog
   already answers.
4. **Never invent a business rule or a code meaning.** Status codes are read
   from their source (lookup table, enum type, CHECK constraint or column
   comment) and confirmed by the user before they filter a report.
5. **Grain before join.** Every 1:N child is pre-aggregated to the parent key
   before it is joined (see [correctness-checks.md](references/correctness-checks.md)).
6. **Plan before run.** `explain` (estimated, no analyze) before the first
   run. A query that needs more than the default timeout, or EXPLAIN ANALYZE
   on a large table: tell the user the table, estimated rows and reason first.
7. **Approval is the user's.** `approve_report` only after the user
   explicitly approved this report in this conversation. The user can also
   approve or revoke a report themselves in the viewer (browser or desktop
   app, *Approve* / *Revoke approval*); do not say approval is only possible
   through chat.
8. **No personal values** in answers or notes; masked previews only.

## Workflow

1. **Profile, memory, parse.** Profile check. `table_knowledge` on named
   tables (rule 2: column scores and trigger summaries). Split the request into: period and date column, filters, grain
   (one row per what), output columns, grouping, sums/counts, joined sources,
   special states to check (for example rows in an error or retry state).
2. **Questions (one message, max 3).** Only for gaps, in the priority order
   of [question-templates.md](references/question-templates.md):
   - period, filter and which date column defines it;
   - whether cancelled or deleted rows count (only when no rule is remembered);
   - tables or codes the user already knows;
   - output columns, grouping and sums.
   List the remembered rules you will apply as defaults, for example
   "reports on example.orders use status_code = 1 only (memory rule)".
   There is no default for cancelled or deleted rows: when a state or
   soft-delete column exists and no rule is remembered, this question is
   asked neutrally within the 3 (second after the date column), and the
   answer is saved with `remember kind=rule`.
3. **Locate.** `search` for missing tables; one `describe_tables` for all
   involved tables; `relation_stats` (when available) or foreign keys for
   join paths. Follow the auspex-explore skill for unknown areas.
4. **Resolve codes.** For each ambiguous state (for example "failed" vs
   "pending retry"), read the code list from its source (lookup table, enum
   type, CHECK constraint or column comment) with one small query, propose
   the codes and confirm them with the user. Save the confirmed mapping with
   `remember kind=rule`. For a code or status column without a foreign key,
   follow the code-column lookup step of the auspex-explore skill.
5. **Measure risk.** One `profile_tables` call with `parent` = the report's
   driving table and `window` = the period: fan-out of every child, fill rate
   of join and filter columns.
6. **Write SQL.** CTE per source, children aggregated to the parent key,
   explicit column list, filters from step 2, NULL handling stated,
   rows in excluded states removed per rule. Checklist:
   [correctness-checks.md](references/correctness-checks.md).
7. **Explain.** `explain` without analyze. Check for sequential scans on
   large tables and row estimates that explode after a join. Narrow by
   indexed columns before running.
8. **Save and run.** `save_report` with db = profile, schema = main schema,
   a category (ask once if unclear, default `General`; it may be a topic
   path of up to three levels joined by "/", so propose a topic/subtopic such
   as `Orders/Delivery` and ask the user if unsure), a kebab-case name,
   title and description stating the definitions. Then `run_report`.
   For a date-range report write `$1` start (inclusive) and `$2` end
   (exclusive), compared as `$1::date` / `$2::date` or against a date
   column (day boundaries follow the Auspex machine; a `timestamptz`
   comparison uses the database session time zone), and save with
   `dateRange: true` so the built-in presets (`last_month`, `this_year`, ...)
   work; prefer them over fixed dates. When the user repeats a parameter set,
   propose saving it as a custom preset (`save_report` `presets`, name in
   the `notesLanguage`) and run with `preset` instead of `params`.
   Write titles, descriptions and notes in the `notesLanguage` from `list_profiles` (ask once if null); SQL and identifiers stay as they are.
9. **Hand over.** Summary: row count, totals, timings, warnings, the HTML
   path, rules and codes applied, assumptions. Ask for approval; iterate
   with new SQL versions via `save_report`.
10. **After approval:** `approve_report` with `expectedHash` set to the
    `sqlHash` of the version you showed the user (from `save_report` or
    `run_report`); on `STALE_VERSION` show the new version and ask again.
    Mention `unexploredNeighbors` and ask before exploring them.

## Reconcile before handing over

- Total of the report = total of the driving table for the same filters
  (one aggregate query, or `profile_tables` figures).
- Row count of the report = distinct parent keys at the report grain.
- A mismatch is reported, not hidden; fix the SQL and save a new version.

For deeper review use the postgres-performance-doctor (slow plan),
sql-data-reconciliation (totals do not match) or sql-query-reviewer skills.

## Report query as a file

When the user wants the report SQL in their scripts folder, ask where (same
proposal as below: `<root>/<folder>/<file>.sql` in the user's own convention)
and pass `root`, `folder` and `fileName` to `save_report` after the yes.
It writes a new file each time, never overwriting one.

## Scheduled runs (only when the user asks)

Only an approved report can be scheduled; built-in presets only with
`dateRange: true`. Propose the `schedules.json` entry and let the user edit
the file and register the task with the printed command; never do either
yourself. Details: [scheduling.md](references/scheduling.md).

## Change scripts (only when the user asks for a fix)

A report never changes data. When the user asks for a data fix from its
findings, write it as `BEGIN ... ROLLBACK` (enforced, with no `COMMIT` and a
`WHERE` on every `UPDATE`/`DELETE`) in the recommended step structure
DEFINE, PROCESS, MATCH, CORRECT or FAIL, and save it with
`save_execute_script`.
Write its title, purpose and comments in the `notesLanguage` from `list_profiles` (ask once if null); step markers and SQL stay as written:

- **Ask where first, never invent it.** Propose a location from
  `scriptRoots` in `list_profiles`: `<root>/<folder>/<file>.sql`. If you
  can read the folder (or see earlier files via `externalFile` entries in
  `list_reports`), follow the folder and numbering convention already used
  there; otherwise ask the user for the folder and their naming convention.
  Never invent a convention. List every file name. Save with `root`,
  `folder` and `fileName` only after the user's yes. An existing file is
  never overwritten; on that error propose a new name.
- **Summary in the answer** (not as a file unless asked): one line per
  file, run order, which result tables to send back.
- **Judge returned results:** every verification check YES or NO with the figures
  as evidence; missing or unclear output is NO, with what is missing.

## Answer shape

Result (figures with definitions), Rules and codes applied, Assumptions,
Report (category/name, version, HTML path), Statements used, Next
(approval, open questions).
