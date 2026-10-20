<p><a href="../README.md">← Back to README</a></p>

# Tools

Every MCP tool, plus the details of choosing a database, CSV export, batch exploration, DDL, related tables, long queries and errors.

## 🧰 Tools

| Tool | What it does |
|---|---|
| 🗂️ `list_profiles` | Configured profiles (description, host, database, user, timeout limit, role check; never passwords), script roots and code roots (name and folder) |
| 🔐 `check_profile` | Checks that a profile's database role is read-only; a role that can write blocks the profile |
| 🔎 `search` | Tables, views, columns, functions and triggers whose name or comment contains a text (always a case-insensitive contains-match), across all schemas, in one statement; with estimated rows and privileges; optionally function source text too (`searchSource`) |
| 📁 `list_schemas` | Non-system schemas with owner, relation count, usage privilege, comment |
| 📋 `list_tables` | Tables/views in a schema with estimated rows, size, SELECT privilege, comment; optional ILIKE filter |
| 🧬 `describe_table` | Columns (with identity, generated and owned sequence), types, defaults, comments, constraints incl. checks, indexes, incoming FKs, triggers, row level security, partitioning, view definition; records the table in the schema memory and reports changes since the last time |
| 🧬 `describe_tables` | The same structure for up to 50 tables in one call, with 6 catalog statements (7 with a view) however many tables; compact one-line-per-item summary by default, `detail: "full"` for every definition; unknown names are reported per table; each table is recorded in the schema memory |
| 🧩 `describe_functions` | Up to 50 functions by `schema.name` (every overload) or by name pattern: signature, language, volatility, SECURITY DEFINER, owner, calling triggers and the `pg_get_functiondef` text (capped, `truncated` flag); 1 statement |
| 📏 `profile_tables` | Up to 30 tables in one call: estimated rows, per-column fill rate and distinct count on a sample, and fan-out over a parent table (optionally in a window and with `parentFilter` conditions); at most 3 statements; counts and ratios only, never row values |
| 🕸️ `relation_stats` | Up to 50 center tables in one call: their instance tables (referenced by foreign key) and dependent tables (referencing them), ranked by estimated linked rows from planner statistics; at most 2 statements; no table data is read |
| ▶️ `query` | One read-only statement, max `AUSPEX_MAX_ROWS` rows, `$1..$n` params, optional `timeoutSeconds` |
| 🧠 `explain` | Estimated plan by default; `analyze: true` runs `EXPLAIN (ANALYZE, BUFFERS)` read-only, under the timeout, rolled back |
| 📤 `export_csv` | Streams the result to a new UTF-8 CSV file (`<time>_<random>_<name>.csv`, never overwrites) within a row, size and total-time budget; returns only path, columns, row count, size and `stopReason` when a limit cut it short |
| 📝 `save_report` | Saves a read-only query as a versioned report draft in the library; with `root`, `folder` and `fileName` also as a new `.sql` file in a configured script root; optional `presets` (named parameter sets, see *Parameter presets*) |
| 🏁 `run_report` | Runs a report: plan + timings + masked preview, history, regenerated HTML; returns a compact summary; parameters from `params` or from a `preset` (not both) |
| ✅ `approve_report` | Moves a draft into `SELECT/` after the user approved it; optional `expectedHash` (the `sqlHash` from `save_report` / `run_report` of the version the user approved) refuses a draft that changed since then with `STALE_VERSION` |
| 📚 `list_reports` / 🎨 `render_reports` | Lists the library; re-renders every report HTML from stored JSON |
| 📨 `share_report` | Writes a copy of a report to send to someone: masked preview and figures only, no SQL, plan, parameters or history |
| 🧾 `save_execute_script` | Writes a change script into `EXECUTE/` for a human to run — never executed by Auspex; with `root`, `folder` and `fileName` also as a new file in a configured script root (for example a folder of saved SQL scripts) |
| 🧠 `table_knowledge` | What the schema memory knows about a table — key and used columns, relations, table notes, database-wide notes, recent changes, column importance scores, triggers with their summaries, unexplored neighbors — without touching the database |
| 📌 `remember` | Adds, confirms or archives a note: a rule the user stated, an observation backed by evidence, or an unconfirmed inference; `evidenceCode` adds up to 5 references into a configured code root (see Code meanings) |
| 🏷️ `score_columns` | Saves 1-5 importance scores per column of a described table in two layers: the agent's (roles, one-line reason, number of sources) and the user's (stated by the user; wins when present), one-line trigger summaries and the script files it read (path relative to the script root and sha256 only); local memory only, no database access |
| 🗃️ `scanned_files` | Lists the script files `score_columns` recorded (root, relative path, sha256, last read), so the next run reads only new or changed files |

### Choosing the database

There is no default profile. Every tool except `list_profiles` requires an
explicit `profile`, and a call without one is rejected with the list of known
profiles. The server instructions tell the model to ask the user which
database to use unless the user named one in the current conversation, and to
confirm before switching. The code guarantees the explicit choice; asking the
user is model behavior.

### Exact values

`numeric`, date and time values and their arrays come back as PostgreSQL's
text, never as rounded JavaScript numbers or shifted dates. `json` and `jsonb`
cells (and the elements of `json[]` / `jsonb[]`) are PostgreSQL's own JSON
text, so `9007199254740993` and `1234567890.123456789` keep every digit; a
JSON scalar such as `null` or `"x"` arrives as that JSON text, not as SQL NULL.
This applies to `query`, report previews and `export_csv`.

### CSV for spreadsheets

`export_csv` writes exact values by default (`mode: "raw"`), which is right
for scripts and other tools. When a person will open the file in a
spreadsheet, use `mode: "spreadsheet"`: text cells that start with `=`, `+`,
`-`, `@`, a tab or a carriage return get a leading apostrophe so they are
shown as text instead of being run as a formula. Number, date, time, boolean
and uuid columns are never changed, so a real `-5` stays a number. Columns of
any other type count as text, and column names get the same treatment. The
viewer's Operations CSV download applies the same rule to every text cell
(SQL, errors, profile, parameters); its JSON download stays exact. The rule
follows the common CSV-injection guidance; it is covered by tests on the
written file and the viewer download, not yet checked by opening the files in
Excel, LibreOffice or Google Sheets. It is a mitigation, not a guarantee:
spreadsheet behavior differs per application and the apostrophe can be lost
when a file is saved and reopened (see the OWASP CSV Injection page).

### CSV export budget

Each `export_csv` call has a row cap, a size cap and a total time cap
(`AUSPEX_EXPORT_MAX_ROWS`, `_BYTES`, `_MS`). The size cap counts every byte
written: byte order mark, header line, quoting and CRLF. If the header alone
does not fit, the call fails and no file is kept. The time budget starts once
the read-only transaction is open and ends when the file is closed; it covers
every FETCH, every write (including waits for a slow disk) and closing the
file. Near the deadline each FETCH runs with `statement_timeout` lowered to
the remaining time (never above the call's own timeout), so PostgreSQL cancels
it at the deadline and the connection goes back to the pool clean. Hitting a
cap ends the file at the last complete row with `stopReason` `rows`, `bytes`
or `time`; a time stop before the first batch arrived fails without a file.

Tolerance: a FETCH the server does not cancel is given 2 s past the deadline,
then its connection is dropped (never reused); closing the file is given up to
2 s past the deadline, after which the call fails and removes the file it
created. So a call returns within about `AUSPEX_EXPORT_MAX_MS` + 4 s in the
worst case, usually within milliseconds of the deadline.

### Exploring many tables

Exploring N tables one by one costs N round trips (a `describe_table` and a
measuring query per table), all of them in the audit log. `describe_tables`
and `profile_tables` take a list instead and use a constant number of
statements in one READ ONLY transaction with one audit entry, whether the list
has 1 table or 30: `describe_tables` sends 6 catalog statements (7 when a view
or materialized view is listed); `profile_tables` sends 1 catalog lookup, 1
column-statistics statement for all tables (`UNION ALL`) and, with `parent`,
1 fan-out statement, so at most 3 (field `statements`). Column statistics are
taken on a sample of `sampleRows` rows per table (default 20000, max 200000):
`TABLESAMPLE SYSTEM` plus `LIMIT` when the estimate is larger and the table is
big enough to sample about 10 pages (a small table could otherwise come back
empty), otherwise a plain `LIMIT` scan. Fan-out uses the child's single-column foreign key to
`parent.key`, or a column given as `schema.table:column`. The parent rows can
be narrowed by `window` (`from <= column < to`) and by `parentFilter`, up to 5
conditions `{ column, op, value | values }` with `op` one of `=`, `<>`, `>`,
`>=`, `<`, `<=` (one `value`), `in`, `not in` (`values`, 1 to 100) or
`is null`, `is not null` (neither), e.g.
`[{ "column": "status_code", "op": "in", "values": [1, 2] }]`. All conditions are
ANDed; each column must exist in the parent table (otherwise
`INVALID_INPUT`), and every value is a bound parameter, never SQL text. The
fan-out stays one statement. Table and column
names are checked against the catalog, quoted, and the generated SQL passes the
same guard as user queries; there is no free SQL. The server instructions tell
the model to prefer these two tools over per-table loops.

`describe_tables` answers with `detail: "summary"` by default, because the
full structure of a dozen real tables can run to well over 100k characters.
Per table the summary has `estRows`, `comment`, one line per column
(`name type [not null] [PK] [FK -> schema.table(column)] [identity]
[generated] [default <value> | has default] [no SELECT]`; defaults longer
than 30 characters are only flagged), one line per constraint other than
single-column foreign keys (`name definition`), per index (`name [unique]
[method] (columns)`) and per trigger (`name TIMING EVENTS`), each line cut at
120 characters, `referencedBy: { count, tables }` with the first 10 incoming
foreign keys by table name, and `viewDefinitionOmitted` instead of a view's
definition; `rowLevelSecurity`, `partitioning` and `partitionOf` only when
set. The field `note` repeats this format. `detail: "full"` returns exactly
the earlier answer (column comments, check, index and trigger definitions,
view definitions). Both modes send the same statements and record the schema
memory from the full catalog data. On the test fixtures the summary is 59 %
(10 plain tables) to 79 % (a table with checks, indexes, a trigger and 12
incoming foreign keys, plus a view) smaller than the full answer.

### Reading table DDL, triggers and functions

For integration work (for example "show the import table for one customer and
every function and trigger around it, then design the same for another customer")
the catalog tools return the structure needed to rebuild it:

- `describe_table` / `describe_tables` per table: columns with `identity`
  (`always` / `by default`), `generated` (`stored`) and the owned `sequence`
  (serial or identity) when set; for a generated column `default` holds its
  expression. Constraints include check definitions. `triggers` lists user
  triggers (internal foreign key triggers are left out) with `timing`,
  `events`, `level`, `enabled` (`enabled`, `disabled`, `replica only`,
  `always`), `function`, `whenCondition` and the full `definition`
  (`pg_get_triggerdef`). `rowLevelSecurity` is `{ enabled, forced }`; a
  partitioned table has `partitioning: { key, partitions }`, a partition
  `partitionOf: { parent, bound }`. The table comment is `comment`. All of it
  comes from the same 6 statements (7 with a view), one of them for triggers.
  `describe_tables` returns these fields with `detail: "full"`; its default
  summary keeps only trigger names, timing and events.
- `describe_functions` reads functions, procedures and aggregates by
  `schema.name` (all overloads) or by a name pattern (at most 50, `truncated`):
  `arguments`, `returns`, `kind`, `language`, `volatility`, `securityDefiner`,
  `strict`, `parallel`, `config` (`SET` options such as `search_path`),
  `owner`, `canExecute`, `comment`, `usedByTriggers` and `definition`
  (`pg_get_functiondef`, cut at `maxChars`, default 20000, with
  `definitionLength` and `truncated`; null for aggregates). One statement.
- `search` also matches function names and comments and trigger names
  (`includeRoutines`, default true), and with `searchSource: true` the source
  text of functions (`matchedIn: "source"`; the text itself is not returned).
  Still one statement and at most 500 matches, relations first.

Only the system catalog is read (no table data, no server files).

### Ranking related tables

`relation_stats` answers "which neighbours of this table matter most" without
reading any table. For each center table it lists:

- **instance** tables: tables the center references by foreign key (for
  example `sales.orders -> sales.order_status`);
- **dependent** tables: tables that reference the center (for example
  `sales.order_lines -> sales.orders`).

Each list is sorted by `linkedRows`, then by the table's estimated rows
(`tableEstRows`), then by name; equal figures share a `rank`. An item is
`{ relation, constraint, columns, refColumns, linkedRows, stats, tableEstRows,
rank, explored }`; `columns` are the referencing side's key columns.

`linkedRows` estimates the rows that link through the key, from statistics
only: the referencing table's row estimate (the dependent table, or the center
for an instance table; see *Row estimates* below) times `1 - null_frac` of its key column in `pg_stats`.
For a multi-column key the largest `null_frac` is used, so it is an upper
bound. When the referencing table has no row estimate or
`pg_stats` has no row for a key column, `linkedRows` is `null` and `stats` is
`"missing"`; it is never reported as 0. `pg_stats` only shows columns the role
may read and hides tables whose row security applies to the role, so missing
statistics can also mean missing privileges. A partitioned table has
statistics only after `ANALYZE` on the parent (autovacuum does not analyze
partitioned parents). Relations without SELECT privilege are not listed, only
counted in `hidden` (`{ instance, dependent }`); a center without SELECT
privilege is reported with an error. Foreign keys cloned onto partitions are
left out (the parent's key stands for them). `schema` limits the neighbours to
one schema.

All centers take at most 2 statements in one READ ONLY transaction (the
relations with their foreign keys, then `pg_stats`), with one audit entry
(field `statements`). The result is recorded in the schema memory: centers and
neighbours are recorded as seen (never as explored), with their row estimates,
and the edges in `graph.json` carry the linked-row figures (see below).

### Row estimates

`estimated_rows` (and `estRows`) never read a table. It is the planner's
`reltuples` when that is above 0. When `reltuples` is 0 or unknown it is the
live row count of the statistics collector (rows inserted since the last
vacuum or analyze), so a table analyzed while empty and filled later is not
shown as empty. It is 0 only for a relation that was vacuumed or analyzed and
has no live rows, and `null` (unknown) otherwise. This matters before
PostgreSQL 14, which marks a never-analyzed table with `reltuples = 0`
instead of `-1`. The live row count and the vacuum/analyze times are kept
per server, so on a standby, after a statistics reset or with
`track_counts = off` an empty table also shows `null`: `null` means "no
estimate", never "empty". An estimate above 0 can still be out of date until the next
analyze; use `profile_tables` or `count(*)` when the exact figure matters.

### Large tables and long queries

`query`, `explain`, `export_csv` and `profile_tables` accept `timeoutSeconds`. Without it the
default (30 s) applies; with it the value may not exceed the global or
per-profile ceiling, and a larger value is rejected before connecting. The
server instructions tell the model to prefer estimated row counts over
`count(*)`, check plans with `explain` first, and tell the user before running
anything longer than the default.

### Errors

A failed tool call returns `isError: true` with the readable message as the
first text block (unchanged), followed by a machine-readable envelope, both as
`structuredContent` and as a second text block with the same JSON:

```json
{ "error": { "code": "QUERY_BUDGET_EXCEEDED", "retryable": true, "retryAfterSeconds": 42,
             "budgetScope": "process", "correlationId": "5f0c…" } }
```

Decide from `code` and `retryable`, never from the English text. The envelope
holds no message text, SQL, parameters, row values or connection details;
`sqlState` is the PostgreSQL SQLSTATE when the database raised the error.

| Code | Meaning | Retryable |
|---|---|---|
| `QUERY_BUDGET_EXCEEDED` | Query budget of the profile used up; `retryAfterSeconds` says when the next slot frees. The budget is per profile and per Auspex process (`budgetScope: "process"`), not a database-wide limit | yes, once, after the wait; better batch the work |
| `LOCK_BUSY` | Another Auspex process is writing the report library or schema memory | yes, after a moment |
| `ROLE_REJECTED` | The profile's database role is not read-only | no |
| `SQL_REJECTED` | The SQL guard, or the READ ONLY transaction (SQLSTATE 25006), refused the statement | no |
| `TIMEOUT` | Statement timeout (57014), idle-in-transaction timeout (25P03) or export time limit; lock timeout (55P03) is retryable | lock timeout only |
| `INVALID_INPUT` | Invalid arguments, names or option values, including MCP schema validation | no |
| `PROFILE_INVALID` | Missing or unknown profile | no |
| `NOT_FOUND` | Report, note, relation or column not found | no |
| `PRECONDITION_FAILED` | An earlier step is missing (for example run the current SQL version before approving or sharing) | no |
| `STALE_VERSION` | Approve or revoke named the SQL hash of a version the report no longer stands for (a new version was saved after it was reviewed); reload and review again | no |
| `PERMISSION_DENIED` | No privilege on the object (42501) | no |
| `CONNECTION_FAILED` | Could not connect or authenticate (08xxx, 28xxx, 57P01-57P03, 53300, network errors, a connection dropped mid-query); authentication failures are not retryable | network/server only |
| `DISK_ERROR` | A local file could not be written or read (ENOSPC, EEXIST, EACCES, ...) | no |
| `DATABASE_ERROR` | Any other PostgreSQL error; see `sqlState` (serialization failure and deadlock are retryable) | 40001/40P01 only |
| `INTERNAL` | Anything else | no |

Auspex itself never retries. Every tool call gets a `correlationId` (a random
UUID), returned in `_meta.correlationId` of both successful and failed results
and in the error envelope. The audit log entries written by that call carry the
same `correlationId` (including the first-use `role_check`), and failed entries
also `errorCode` and `sqlState`, so a result can be matched to its audit entry
without double counting. `run_report` writes exactly one `run_report` entry per call (a first-use
`role_check` shares its `correlationId`),
covering refusals before the database and failures after the query; its
database part is the `phases.database` field of that entry (docs/safety.md).
Calls rejected by the MCP SDK's schema validation get
the envelope too but are not audited (the handler never ran).
