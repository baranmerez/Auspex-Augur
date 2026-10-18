---
name: auspex-columns
description: "Score how important each column of a PostgreSQL table is (1-5) by reading the SQL that uses it - the Auspex report library and the user's own script files - and save the scores with roles and a one-line reason in the Auspex schema memory through score_columns. No database queries are needed. Use when the user asks which columns matter, which columns reports use, which columns are unused, or wants column importance for a table."
---

# Auspex columns

Goal: for each target table, a 1-5 importance score per column that you
decide yourself from the SQL that reads the table, saved with
`score_columns` so `table_knowledge` (and the viewer) can show it later.
Auspex computes nothing: the score is your judgement, backed by where each
column appears.

## Hard rules

1. **Profile named by the user** in this conversation; otherwise
   `list_profiles`, show the profiles and ask. Never guess, never reuse one
   from another conversation. There is no default.
2. **Script location from the user.** Take the folders to read from
   `scriptRoots` in `list_profiles` and confirm with the user which root (and
   which folders inside it) hold SQL for this database. If there is no root or
   the user names another folder, ask for the exact path. Never assume a folder
   layout or naming convention.
3. **Read, never copy.** User script files are read only. Never save them as
   reports (`save_report`), never copy them into the library, never modify
   them. Only the file path relative to its root and its sha256 are recorded.
4. **Described tables only.** `score_columns` accepts a table only after
   `describe_table` / `describe_tables` recorded its structure, and every
   column name must exist in that structure. Check with `table_knowledge`
   first; describe missing tables in one `describe_tables` call (announce the
   statement count).
5. **No database queries for scoring.** Scores come from SQL text. If you need
   catalog facts, use memory first (`table_knowledge`) and keep any query to
   the minimum, announced to the user.
6. **Never invent business meaning.** A reason states where and how the
   column is used ("joined to example.customers in 6 reports, shown in all"),
   not what the business means by it.

## Workflow

1. **Profile and targets.** Profile check (rule 1). Ask which tables to
   score if the user did not say. `table_knowledge` on each: structure,
   existing `columnScores`, `unscoredColumns` and notes.
2. **Sources.**
   - Report library: `list_reports` for the profile, then read the current
     SQL of each report from the library folder (`libraryDir`). Several
     versions of one report (`_v2`, `v3` suffixes, the same report name in
     different stages) count as **one** report: use the latest version only.
   - Script files: list the `.sql` files in the confirmed folders. Call
     `scanned_files` and compute the sha256 of each file (your file tools or a
     shell, for example `sha256sum` or `Get-FileHash`); read only files that
     are new or whose sha256 changed. If you cannot compute a hash, read all
     files and leave `scannedFiles` out.
   - Keep read-only SQL (SELECT/WITH) as evidence of reading use. Change
     scripts (UPDATE/INSERT/DELETE) only tell you a column is written; do
     not count them as read use unless their WHERE or JOIN reads it.
3. **Attribute each column use.** Per statement: resolve table aliases
   (`from example.orders o` -> `o.order_id` is `example.orders.order_id`),
   CTEs and subqueries back to their base table, unqualified columns to the
   only table that has them (skip when ambiguous), and `select *` as display
   use of every column. Record the role from where it appears:

   | Where | Role |
   |---|---|
   | primary/unique key of the table | `key` |
   | `JOIN ... ON`, `USING`, join in WHERE | `join` |
   | `WHERE`, `HAVING` (not a join) | `filter` |
   | `SELECT` list | `display` |
   | inside `sum`/`count`/`avg`/`min`/`max`/... | `aggregate` |
   | `GROUP BY`, `ORDER BY`, window `PARTITION BY`/`ORDER BY` | `sort/group` |

   Count `sources` per column: distinct reports plus distinct script files
   that use it (report versions once, rule in step 2).
4. **Decide the score, relative within the table.**
   - 5: the columns the reports revolve around - keys joined almost
     everywhere, the main display and filter fields.
   - 4: used in most sources or in several roles.
   - 3: used regularly in one role.
   - 2: used in one or two sources only.
   - 1: never used in any read SQL that was read.
   A column used on application screens but in no report or script gets a
   low score here; say so in the summary so the user can ask for a review.
   Write the reason as one sentence (at most 200 characters) in the
   `notesLanguage` from `list_profiles` (ask once if null).
5. **Save.** One `score_columns` call per table with every column you
   scored (unlisted columns keep their earlier score) and, on one of the
   calls, `scannedFiles` with `root`, the path relative to that root and the
   sha256 of each file you read. A rejected call saves nothing: fix the input
   (for example describe the table again if a column was renamed) and retry
   once.
6. **Report to the user.** Per table: the top columns (score, roles,
   sources), how many columns scored 1 (unused), how many files and reports
   were read and how many were skipped as unchanged. Offer to review any
   column the user knows is used elsewhere (application screens, exports).

## Answer shape

Short: profile, tables scored, sources read (reports, files, skipped),
top columns per table with roles, unused column count, columns that need the
user's review, statements used (usually 0).
