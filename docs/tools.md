<p><a href="../README.md">← Back to README</a></p>

# Tools

Every MCP tool, plus the details of choosing a database, CSV export, batch exploration, DDL, related tables, long queries and errors.

## 🧰 Tools

| Tool | What it does |
|---|---|
| 🗂️ `list_profiles` | Configured profiles (description, host, database, user, timeout limit, role check; never passwords), script roots and code roots (name and folder), and the enabled tool groups (`toolGroups`) |
| 🔐 `check_profile` | Checks that a profile's database role is read-only; a role that can write blocks the profile |
| 🔎 `search` | Tables, views, columns, functions and triggers whose name or comment contains a text (always a case-insensitive contains-match), across all schemas, in one statement; with estimated rows and privileges; optionally function source text too (`searchSource`) |
| 📁 `list_schemas` | Non-system schemas with owner, relation count, usage privilege, comment |
| 📋 `list_tables` | Tables, views, materialized views and foreign tables in a schema (field `kind`) with estimated rows, size, SELECT privilege, comment; optional ILIKE filter |
| 🧬 `describe_table` | Columns (with identity, generated and owned sequence), types, defaults, comments, constraints incl. checks, indexes, incoming FKs, triggers, row level security, partitioning, the views that read it (`usedByViews`) and for a view its definition, options, sources and called functions; records the table in the schema memory and reports changes since the last time |
| 🧬 `describe_tables` | The same structure for up to 50 tables in one call, with 7 catalog statements (8 with a view) however many tables; compact one-line-per-item summary by default, `detail: "full"` for every definition; unknown names are reported per table; each table is recorded in the schema memory |
| 🧩 `describe_functions` | Up to 50 functions by `schema.name` (every overload) or by name pattern: signature, language, volatility, SECURITY DEFINER, owner, calling triggers and the `pg_get_functiondef` text (capped, `truncated` flag); 1 statement; records each function in the schema memory and reports changes since the last time |
| 🧾 `list_functions` | Inventory of functions, procedures and aggregates in one schema or all (optional name filter): signature, return type, kind, language, volatility, no definitions; 1 statement; extension functions only with `includeExtensions`; recorded in the schema memory as seen |
| 📏 `profile_tables` | Up to 30 tables in one call: estimated rows, per-column fill rate and distinct count on a sample, and fan-out over a parent table (optionally in a window and with `parentFilter` conditions); at most 3 statements; counts and ratios only, never row values |
| 🕸️ `relation_stats` | Up to 50 center tables in one call: their instance tables (referenced by foreign key) and dependent tables (referencing them), ranked by estimated linked rows from planner statistics; at most 2 statements; no table data is read |
| ▶️ `query` | One read-only statement, max `AUSPEX_MAX_ROWS` rows, `$1..$n` params, optional `timeoutSeconds` |
| 🧠 `explain` | Estimated plan by default; `analyze: true` runs `EXPLAIN (ANALYZE, BUFFERS)` read-only, under the timeout, rolled back |
| 📤 `export_csv` | Streams the result to a new UTF-8 CSV file (`<time>_<random>_<name>.csv`, never overwrites) within a row, size and total-time budget; returns only path, columns, row count, size and `stopReason` when a limit cut it short |
| 📝 `save_report` | Saves a read-only query as a versioned report draft in the library; with `root`, `folder` and `fileName` also as a new `.sql` file in a configured script root; optional `presets` (named parameter sets, see *Parameter presets*) |
| 🏁 `run_report` | Runs a report: plan + timings + masked preview, history, regenerated HTML; returns a compact summary; parameters from `params` or from a `preset` (not both); optional `stage` (`approved` / `draft`) picks the copy when both exist and `version` pins its SQL version |
| ✅ `approve_report` | Moves a draft into `SELECT/` after the user approved it; optional `expectedHash` (the `sqlHash` from `save_report` / `run_report` of the version the user approved) refuses a draft that changed since then with `STALE_VERSION` |
| 📚 `list_reports` / 🎨 `render_reports` | Lists the library, one entry per stage copy with its `activeVersion` (the SQL version that copy runs, for `run_report` `version`); re-renders every report HTML from stored JSON |
| 📨 `share_report` | Writes a copy of a report to send to someone: masked preview and figures only, no SQL, plan, parameters or history |
| 🧾 `save_execute_script` | Writes a change script into `EXECUTE/` for a human to run — never executed by Auspex; with `root`, `folder` and `fileName` also as a new file in a configured script root (for example a folder of saved SQL scripts) |
| 🧠 `table_knowledge` | What the schema memory knows about a table — key and used columns, relations, table notes, database-wide notes, recent changes, column importance scores, triggers with their summaries, unexplored neighbors — without touching the database |
| 🧩 `function_knowledge` | What the schema memory knows about one function name — overloads, listed-only or described state, capture times, definition availability and length, calling triggers, callers and inferred calls/touches, recent changes — without touching the database; the source only on request for one overload, capped |
| 📖 `table_profile` | The prose profile of one table (what it is for, what it does, where it is used, what it depends on, what to watch out for): `get` returns it with its sources, version, author, owner and freshness, a pending proposal and the tables it cannot live without (with evidence); `save` stores the agent's draft, written from memory only. A profile the user wrote, confirmed or accepted is never overwritten: the agent's text becomes a proposal. Local memory only, no database access |
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
Finite `float4` / `float8` values (and arrays of them) stay numbers, but `NaN`,
`Infinity` and `-Infinity` arrive as those texts instead of `null`, also inside
arrays. `interval` and `interval[]` cells are PostgreSQL's own text whatever
`IntervalStyle` the connection inherits. This applies to `query`, report
previews and `export_csv`.

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
has 1 table or 30: `describe_tables` sends 7 catalog statements (8 when a view
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
definition, with its sources (`viewSources`, `schema.table(columns)`) and called
functions (`viewFunctions`) as one line each, and for any relation the views
that read it (`usedByViews`) as one line; `rowLevelSecurity`, `partitioning` and `partitionOf` only when
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
  comes from the same 7 statements (8 with a view), one of them for triggers.
  `describe_tables` returns these fields with `detail: "full"`; its default
  summary keeps only trigger names, timing and events.
- Views and materialized views: one statement over all described relations
  reads their dependencies from `pg_rewrite` and `pg_depend`, and one more
  (only when a view or materialized view is listed) their definition and
  options. Every described relation gets `usedByViews` (the views and
  materialized views that read it: `{ schema, table, kind }`); a view or
  materialized view also gets:

  ```jsonc
  {
    "viewDefinition": "SELECT ...",             // pg_get_viewdef(oid, true)
    "viewOptions": { "securityBarrier": false, "checkOption": null },  // null | "local" | "cascaded"
    "populated": true,                           // materialized views only
    "viewSources": [                             // sorted by schema, table
      { "schema": "example", "table": "orders", "kind": "table", "columns": ["order_id", "status_code"] }
    ],
    "viewFunctions": [
      { "schema": "example", "name": "order_total", "arguments": "p_order_id bigint", "volatility": "stable" }
    ]
  }
  ```

  Sources and functions are what PostgreSQL recorded for the view's rewrite
  rule (the view itself is left out); built-in objects are not recorded
  there. `changesSinceLast` reports `view definition changed` and
  `view sources changed` (added or removed source relations).
- `describe_functions` reads functions, procedures and aggregates by
  `schema.name` (all overloads) or by a name pattern (at most 50, `truncated`):
  `arguments`, `returns`, `kind`, `language`, `volatility`, `securityDefiner`,
  `strict`, `parallel`, `config` (`SET` options such as `search_path`),
  `owner`, `canExecute`, `comment`, `returnsTrigger`, `usedByTriggers` and
  `definition` (`pg_get_functiondef`, cut at `maxChars`, default 20000, with
  `definitionLength` and `truncated`; null for aggregates). One statement.
  `returnsTrigger` is true when the return type is `trigger`
  (`prorettype = 'trigger'::regtype`). `usedByTriggers` lists the
  non-internal triggers that call the overload (clones of a partitioned
  table's trigger on its partitions are left out), decoded from
  `pg_trigger.tgtype`:

  ```jsonc
  { "table": "example.orders",      // tableKey: a dot or double quote in a name is quoted
    "schema": "example", "tableName": "orders", "trigger": "orders_audit",
    "timing": "before",             // "before" | "after" | "instead"
    "events": ["insert", "update"], // any of insert, update, delete, truncate
    "level": "row" }                // "row" | "statement"
  ```
  Each function name is recorded in the schema memory with all its overloads
  (definition kept up to 200000 characters whatever `maxChars` was, see
  docs/schema-memory.md); the answer's `memory.functions` has one entry per
  name: `{ function: "example.order_total", recorded: "first time" | "updated",
  lastDescribedAt?, changesSinceLast: [...] }`. `changesSinceLast` is empty
  the first time; later it lists `overload (...) added` / `removed`,
  `definition of (...) changed` and `properties of (...) changed: volatility,
  securityDefiner, strict, parallel, config, owner`. When a pattern result is
  cut at its limit, overloads missing from the last name are not reported as
  removed.
- `list_functions` is the inventory: `schema` (optional, default every
  non-system schema), `pattern` (optional, a contains-match on the name like
  `describe_functions`), `limit` (default 500, at most 2000; `truncated`) and
  `includeExtensions` (default false: functions that belong to an installed
  extension are left out). Per overload: `schema`, `name`, `arguments`,
  `returns`, `kind`, `language`, `volatility`, `returnsTrigger` and
  `usedByTriggers` (as in `describe_functions`); no definitions. One
  statement. The overloads are recorded in the schema memory as seen: a new
  function gets a record without definitions, a known one gains the overloads
  it did not have (`listedOnly`), and a listed-only overload takes the new
  `returnsTrigger` and `usedByTriggers`; a described overload and every
  definition are never changed. The answer's `memory` is
  `{ functionsAdded, overloadsAdded, overloadsRefreshed? }`.
- `function_knowledge` answers from the schema memory only, for one
  function name already recorded by `describe_functions` or `list_functions`
  (`schema` and `name` as stored, no quoting; names are matched exactly). It
  opens no connection and issues no catalog query; a name not in memory
  returns `{ known: false, hint }` and nothing is refreshed on its own. Use
  `describe_functions` to refresh, then ask again.

  ```jsonc
  { "function": "example.order_total", "known": true, "source": "schema memory",
    "note": "Cached from earlier describe_functions / list_functions calls ...",
    "state": "described",            // or "listed-only": inventory facts, no definition
    "firstSeen": "...", "lastSeen": "...", "describedAt": "..." | null,
    "overloadCount": 2,
    "overloads": [{ "arguments": "p_order_id bigint", "returns": "numeric", "kind": "function",
                    "language": "plpgsql", "volatility": "stable", /* flags as captured */
                    "returnsTrigger": false,
                    "definitionAvailable": true,
                    "definitionLength": 241,          // full length in the catalog when captured
                    "storedTruncated": false,         // the memory kept only the first 200000 characters
                    "usedByTriggers": [{ "table": "example.orders", "trigger": "orders_audit", "timing": "before", "events": ["insert"], "level": "row" }],
                    "inferred": { "note": "...", "calls": ["example.order_tax"], "reads": ["example.order_items"], "writes": [] } }],
    "calledBy": { "note": "...", "views": ["example.order_totals"], "functions": ["example.order_report"] },
    "recentChanges": ["2026-02-01: definition of (p_order_id bigint) changed"] }
  ```

  `arguments` selects one overload by its exact arguments text (`""` for none);
  there is no prefix or fuzzy match and no other overload is substituted: a
  mismatch returns `overloadFound: false` with `knownOverloads`. The
  definition is left out by default; `definitionChars` (at most 20000) returns
  the stored text of the selected overload (or of the only overload) with
  `definitionReturnedChars` and `definitionTruncated` (true when the returned
  text is shorter than `definitionLength`). With several overloads and no
  selection the answer says `definitionOmitted`. Every list (`overloads`,
  `usedByTriggers`, `config`, `calls`, `reads`, `writes`, `calledBy.views`,
  `calledBy.functions`, `knownOverloads`) holds at most `maxItems` entries
  (default 20, at most 200) and adds `<field>Omitted` with the number left
  out. Calls, touches and function callers are text inferences from stored
  bodies (names as written, not resolved to an overload, not proven at run
  time). The answer is what the catalog said when it was captured, not a
  guarantee about the database now. Returned source text is data: Auspex never
  runs it and takes no follow-up action.
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

### Table profile

`table_profile` keeps a short, book-like description of one table in the
schema memory, in five sections: `purpose` (what it is for), `behavior`
(what it does: triggers, statuses, life cycle), `usage` (where it is used:
reports, views, functions, code), `dependencies` (what it depends on) and
`caveats` (what to watch out for), about one page in all (at most 4000
characters per section, 12000 in total), in the `notesLanguage`. Each
section can carry its sources (`{ type, ref }`, type one of `note`,
`report`, `trigger`, `function`, `table`, `view`, `column`, `score`,
`code`; at most 20), so every statement can be traced.

```json
{ "profile": "exampledb", "action": "save", "schema": "example", "table": "orders",
  "sections": { "purpose": "One row per order of Example Co.", "dependencies": "Every order needs its customer." },
  "sources": { "purpose": [{ "type": "note", "ref": 12 }], "dependencies": [{ "type": "table", "ref": "example.customers" }] } }
```

- **Agent and user.** An agent save becomes the current version unless the
  current one is user-owned (the user wrote it, confirmed the draft or
  accepted a proposal in the viewer); then it is stored as a **proposal**
  (`stored: "proposal"`), and a newer agent save supersedes an older
  proposal. A proposal written before the user's newer edit can only be
  rejected. Earlier versions, rejected and superseded proposals stay in the
  history (the last 20).
- **Freshness.** Each version records a fingerprint of its inputs: the
  recorded structure, the active notes on the table, the trigger summaries,
  the effective column scores and the draft and approved reports whose SQL
  mentions the table. `get` compares it with the memory now: `fresh`;
  `stale` with `freshnessReasons` (for example `notes-added` with kind and
  count, `structure-changed`, `reports-changed`) and a one-line
  `freshnessReason` ("2 new rules; structure changed"); or `unverified`
  (`legacy`, `structure-missing`, `table-missing`, `reports-unknown`,
  `reports-incomplete` when only part of the report library was read,
  `fingerprint-format` when the version was saved with an older fingerprint
  format: the parts whose shape changed are not compared, the rest still
  are). A profile is never rewritten automatically.
- **Cannot live without.** `requiredTables` lists the tables the table
  needs, each with its evidence: `catalog` (a foreign key whose columns are
  all NOT NULL), `inference` (a code column without a foreign key whose name
  parts match one known table, such as `status_code` → `example.status_codes`,
  or a table the trigger function reads, from its stored body) and `user`
  (marked in the viewer). Foreign keys with a nullable column are
  `optionalReferences`.
- **No database call.** Both actions work on local files only; `table_knowledge`
  carries a short `tableProfile` section (version, owner, freshness, pending
  proposal, the user's required tables).

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

### Structured results

A successful call returns its result as JSON text in the first content block
(unchanged, for clients that only read text) and, when the result is an
object (every tool today), the same JSON as `structuredContent`. Both are
built from one serialization, so they hold exactly the same values; `_meta`
keeps the `correlationId`.

`query`, `explain` and `table_knowledge` also advertise an `outputSchema` in
`tools/list` (`src/outputSchemas.js`), and the MCP SDK checks every success
against it before replying:

| Tool | Always present | Optional |
|---|---|---|
| `query` | `profile`, `columns` (names), `rows` (arrays in column order), `rowCount`, `truncated` | `notes`, `repair`, `memoryError`, `memoryErrorCode`, `partialCommit` |
| `explain` | `profile`, `analyzed`, `plan` (text) | `notes`, `unexploredNeighbors`, `repair`, `memoryError`, `memoryErrorCode`, `partialCommit` |
| `table_knowledge` | `relation`, `known` | `hint` (not in memory), the record fields (`explored`, `kind`, `columnCount`, `keyColumns`, `relations`, `notes`, `recentChanges`, `columnScores`, `triggers`, ...), `databaseNotes`, `unexploredNeighbors` |

The schemas are open: fields they name are typed, and a field added later is
allowed, so a client validating against an older schema keeps working. Cells
are strings, numbers, booleans or null, as described in *Exact values*:
numeric, bigint, date/time and json values stay PostgreSQL's text and are
never turned into JavaScript numbers. The other tools return
`structuredContent` without a schema; their fields are the ones documented for
each tool. No tool has behaviour annotations yet. The structured copy doubles
the size of a reply; `maxRows`, `AUSPEX_MAX_CELL_CHARS` and the other limits
bound both copies.

### Cancellation

When a client cancels a `tools/call` (`notifications/cancelled`) or the
connection closes, the MCP SDK aborts the request's signal and Auspex stops
the call's work:

- Not started yet, or waiting for a pooled connection: it stops at once,
  costs no query budget, and a connection that arrives later is closed unused.
- A running statement is cancelled on the server with a PostgreSQL
  CancelRequest for that call's own backend (its process ID and secret key,
  over a new socket, as node-postgres sends it): no SQL runs and no other
  backend can be reached. A multi-statement call starts no further statement.
  If the server has not stopped the statement 2 s later, the connection is
  dropped. A connection that saw a cancellation is never reused.
- `export_csv` stops fetching and waiting for the disk and removes the file it
  created; no partial file is kept.
- `run_report` cancelled during the database phase saves no run and no HTML.
  Once the run is saved it stays saved; only the schema-memory step after it
  is skipped. The same holds for the memory step of the other tools.
- Library and memory changes that are already written are never undone.

The call is audited once with `errorCode: "CANCELLED"` (one entry with the
tool name and `ms: 0` when it was cancelled before its handler started). The
scheduler and scripts have no request signal and are not affected.

### Errors

A failed tool call returns `isError: true` with the readable message as the
first text block (unchanged), followed by a machine-readable envelope, both as
`structuredContent` and as a second text block with the same JSON:

```json
{ "error": { "code": "QUERY_BUDGET_EXCEEDED", "retryable": true, "retryAfterSeconds": 42,
             "budgetScope": "process", "correlationId": "5f0c…" } }
```

For `query`, `explain` and `table_knowledge` (the tools with an
`outputSchema`) the envelope is only in the second text block: SDK clients
check any `structuredContent` against the tool's schema, errors included, so
an error envelope there would be rejected. Read `JSON.parse(content[1].text).error`
for those tools.

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
| `CANCELLED` | The client cancelled the request (see *Cancellation*); the SDK sends no reply, so this code is mainly seen in the audit log | no |
| `INVALID_INPUT` | Invalid arguments, names or option values, including MCP schema validation | no |
| `TOOL_DISABLED` | The tool's group is not in `enabledToolGroups` (docs/configuration.md, Tool groups); nothing ran. Not audited, like other refusals inside the MCP SDK | no (after a restart with the group) |
| `PROFILE_INVALID` | Missing or unknown profile | no |
| `NOT_FOUND` | Report, note, relation or column not found | no |
| `PRECONDITION_FAILED` | An earlier step is missing (for example run the current SQL version before approving or sharing) | no |
| `STALE_VERSION` | Approve or revoke named the SQL hash of a version the report no longer stands for (a new version was saved after it was reviewed), or `run_report` was given a `version` the chosen copy is not at; reload and review again | no |
| `PERMISSION_DENIED` | No privilege on the object (42501) | no |
| `CONNECTION_FAILED` | Could not connect or authenticate (08xxx, 28xxx, 57P01-57P03, 53300, network errors, a connection dropped mid-query); authentication failures are not retryable | network/server only |
| `DISK_ERROR` | A local file could not be written or read (ENOSPC, EEXIST, EACCES, ...) | no |
| `DATABASE_ERROR` | Any other PostgreSQL error; see `sqlState` (serialization failure and deadlock are retryable) | 40001/40P01 only |
| `INTERNAL` | Anything else | no |

**Stored, with repair:** a schema-memory change whose own file was written
does not fail when a step after it fails (graph rebuild, changelog,
scanned-files bookkeeping). The result is the normal one plus a `repair` field
(`remember`, `score_columns`, the `memory` field of `describe_table(s)`,
`describe_functions`, `list_functions`, `explain`; `memoryRepair` in
`run_report` and `relation_stats`), and the audit log gets the repair codes
(in the tool's entry, or a `memory_repair` entry with the same correlation
ID). `remember` adds `repairNote`: the note is stored, do not add it again.
See docs/schema-memory.md, *Committed changes and repair*.

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
