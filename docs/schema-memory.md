<p><a href="../README.md">← Back to README</a></p>

# Schema memory

What Auspex remembers about your tables: notes, relations, column importance and code meanings.

## 🧠 Schema memory

Auspex remembers what it learned about each database in local JSON files
(`~/.auspex/memory/<profile>/`, override with `AUSPEX_MEMORY_DIR`). It grows
with the work and never crawls the catalog on its own:

- **`describe_table`** records the full structure of a table (columns, keys,
  indexes, incoming foreign keys). The next time the same table is described,
  the answer lists what changed: added, dropped, renamed or retyped columns,
  constraints and indexes. Row estimates and comments are not changes. Only the
  system catalog is read, never table data.
- **Plans teach it too:** tables and columns used by `run_report` and `explain`
  are recorded as "seen", with the columns they actually used.
- **Relations** have three levels: `fk` (declared), `used` (joined in an
  approved report) and `suggested` (a column named like another table's
  primary key; unconfirmed until you say so).
- **Notes** are `rule` (stated by the user), `observation` (a finding with
  evidence: the SQL and aggregate figures, dated, never row values) and
  `inference` (the model's interpretation, shown as unconfirmed). Notes on a
  table come back with `table_knowledge`, `describe_table`, `explain` and
  `run_report`, and with `query` when its SQL names the table as
  `schema.table`; database-wide notes come back with `table_knowledge`. They are
  archived with a reason, never deleted.
- **Triggers:** `describe_table` and `describe_tables` also record each
  trigger (name, timing, events, level, enabled, function, WHEN condition,
  `CREATE TRIGGER` definition, constraint trigger); added, dropped, changed
  and enabled/disabled triggers show up in `changesSinceLast`. Records
  written before triggers were stored report no trigger change the first
  time. The trigger records hold no function source; `describe_functions`
  stores function bodies (up to 200000 characters) in the function records,
  see *Function records*.
- **Views:** for a view or materialized view, `describe_table` and
  `describe_tables` also record its definition (cut at 200000 characters,
  with `viewDefinitionLength` and `viewDefinitionTruncated`; the change check
  `viewHash` covers the full text), `viewOptions`, `populated` (materialized
  views), `viewSources` (relations it reads, with the columns used) and
  `viewFunctions` (functions it calls). Every described relation records
  `usedByViews`. A changed definition or a changed set of sources shows up in
  `changesSinceLast`. Records written before these fields existed load as
  before and report no sources change the first time.
- **Functions:** `describe_functions` records every function name it read
  under `functions/`, with all overloads, and reports `changesSinceLast` per
  name; `list_functions` records an inventory of names and signatures as
  seen. See *Function records* below.
- **Exploring further:** after a report, `run_report` and `table_knowledge`
  list neighbors that were never described. The server instructions tell the
  model to ask you before looking at them, and then to read their structure
  only.

```
memory/<profile>/
├── tables/<schema>/<table>.json   structure, used columns, change history
├── functions/<schema>/<name>.json every overload of one function name, change history
├── notes.json                     rules, observations, inferences
├── changelog.jsonl                explored tables, notes and schema changes
├── scanned-files.json             script files read for column scores (relative path, sha256, lastReadAt)
└── graph.json                     derived view for the viewer (rebuilt on every change)
```

`graph.json` is `{ profile, generatedAt, summary, nodes, edges, functions,
notes, changelog }`. Nodes and edges, with the optional fields `relation_stats` adds
(absent until it has measured them, so older readers are unaffected):

```
node: { id: "schema.table", schema, table, file?, state: "explored" | "seen" | "unexplored",
        describedAt: "ISO time" | null,  // last describe of the table record; null when never described
        kind, estimatedRows, columnCount, changes, notes,
        estRows?: number | null,        // relation_stats row estimate; null = no estimate (see docs/tools.md, Row estimates)
        scoredAt?: "ISO time",          // score_columns, see Column importance
        columnScores?: { [column]: { score: 1-5 | null, scoreBy?: "user" | "agent",   // effective score
                                     agent?: { score, roles, reason, sources, at, history },
                                     user?: { score, roles?, at, history } | { cleared: true, at, history } } },
        triggers?: [{ name, timing, events, level, enabled, function, when, definition, constraintTrigger,
                      summary?, summaryAt?, summaryStale? }],
        viewSources?: ["schema.table", ...],   // views and materialized views: relations they read
        viewFunctions?: ["schema.name", ...] }  // views and materialized views: functions they call
edge: { level: "fk" | "used" | "suggested" | "view", from: "schema.table", to: "schema.table",
        columns: [...], refColumns: [...], // from(columns) references to(refColumns);
                                           // view: from reads to, columns = the source columns used, refColumns = []
        linkedRows?: number | null,      // rows of `from` with the key set; null = stats missing
        estimated?: true,                // linkedRows comes from planner statistics
        statsAt?: "ISO time" }           // when relation_stats measured it (latest wins)
```

A `view` edge goes from a view or materialized view to each of its sources
that is a node; sources that are not in the memory get no node of their own.

`functions` has one light entry per function record (no definitions):

```
function: { id: "schema.name", schema, name, file: "functions/<schema>/<name>.json",
            state: "explored" | "seen",           // seen: only listed by list_functions
            overloads: number, kinds: ["function", ...], language,
            role: "trigger" | "procedure" | "aggregate" | "window" | "function",
                                                  // trigger when an overload returns trigger, else the
                                                  // first of procedure, aggregate, window an overload is
            timings: ["after", "before", "instead"],  // sorted, from usedByTriggers (empty when unknown)
            triggerTables: ["schema.table", ...],     // sorted tableKey ids of the tables whose triggers call it
            flags: { volatile, securityDefiner, definerWithoutSearchPath },  // true when any overload has it
            usedByTriggers: number,               // distinct calling triggers over all overloads
            calledBy: { views: ["schema.table", ...],    // views whose viewFunctions name it
                        functions: ["schema.name", ...] }, // other stored functions whose body calls
                                                           // schema.name( or, in the same schema, name(
            touches: { reads: [...], writes: [...] },      // union over the overloads (inferred)
            changes: number }                     // history entries
```

`definerWithoutSearchPath` is true for a `SECURITY DEFINER` overload without
a `search_path=` entry in its `config`.

`file` is only set for tables with a record (`explored` or `seen`). The table
records keep the measurement (`estRows`, `estRowsAt`, and for centers
`relationStats`), so describing a table again does not drop it. A describe of
the source or target table that is newer than the measurement wins, though: a
measured foreign key that the source no longer declares, or that the target
no longer lists as referencing it, is not shown as an `fk` edge, and its
figures are left out with it (they come back if the key does).

`id`, `from` and `to` are `schema.table`. A schema or table name that contains
a dot or a double quote is written quoted, as PostgreSQL's `quote_ident` does
(`example."orders.history"`, `"example.orders".history`), so two such tables
never share an id; every other name keeps the plain form. The viewer builds
ids the same way. Approved-join pairs (`used` edges) cannot tell dotted names
apart, because the plan text they come from has no quotes.

### Function records

`functions/<schema>/<name>.json` holds every overload of one function name:

```jsonc
{
  "schema": "example", "name": "order_total",
  "firstSeen": "...", "lastSeen": "...", "describedAt": "...",   // describedAt null: only listed
  "overloads": [{
    "arguments": "p_order_id bigint", "returns": "numeric",
    "kind": "function", "language": "plpgsql", "volatility": "stable",
    "securityDefiner": false, "strict": false, "parallel": "unsafe",
    "config": ["search_path=example"], "owner": "report_reader", "canExecute": true, "comment": null,
    "returnsTrigger": false,
    "usedByTriggers": [{ "table": "example.orders", "schema": "example", "tableName": "orders", "trigger": "orders_audit",
                         "timing": "after", "events": ["insert", "update"], "level": "row" }],
    "definition": "CREATE OR REPLACE FUNCTION ...",   // cut at 200000 characters; null for aggregates
    "definitionLength": 2345, "truncated": false,
    "definitionHash": "16 hex characters (sha256 of the stored text)",
    "touches": { "inferred": true, "reads": ["example.order_items"], "writes": [] },  // null for other languages
    "calls": [{ "schema": "example", "name": "order_tax" }, { "schema": null, "name": "round" }],  // functions the body calls, as written
    "callsVersion": 2
  }],
  "history": [{ "at": "...", "changes": [{ "change": "definition-changed", "arguments": "p_order_id bigint" }] }]
}
```

- Change kinds: `overload-added`, `overload-removed`, `definition-changed`
  and `flags-changed` (with `fields`: any of `volatility`, `securityDefiner`,
  `strict`, `parallel`, `config`, `owner`). The history keeps the last 50
  entries, like tables.
- An overload only listed by `list_functions` has `listedOnly: true`,
  `definition: null` and only the inventory fields (`arguments`, `returns`,
  `kind`, `language`, `volatility`, `returnsTrigger`, `usedByTriggers`). A
  later `list_functions` refreshes only `returnsTrigger` and `usedByTriggers`
  of listed-only overloads and never changes a described overload or a
  definition; a later `describe_functions` replaces
  the listed overload with the full one (reported as `overload-added` when the
  function was described before).
- Records written before trigger timing was stored have `usedByTriggers`
  entries with only `table` and `trigger`, and no `returnsTrigger`: they load
  as before; the graph then takes `role` from the return type text
  (`trigger`), `triggerTables` from the stored `table` and leaves `timings`
  empty until the function is described or listed again.
- `calls` lists the functions the body calls as written (comments and
  literals skipped; `schema` null when unqualified; CTE declarations such as
  `WITH order_total(total) AS (...)` are not calls). `callsVersion` names the
  scanner rules that produced it. The graph's `calledBy.functions` is built
  from it, so a rebuild of `graph.json` reads no function bodies; a record
  written before `calls` existed, or by an older scanner (`callsVersion`
  missing or lower), gets them computed from its stored definition, without
  a database call. The MCP server writes them back once; the viewer, the
  desktop app and the scheduler only compute them in memory and never write
  function records. Calls stored by a newer scanner version are kept as they
  are.
- `touches` is a textual inference from the body, not a catalog fact
  (PostgreSQL records no dependencies for function bodies), and only for
  `sql` and `plpgsql`: comments, string literals and nested dollar-quoted
  strings are skipped; `FROM` / `JOIN` targets (and `USING` in `MERGE` /
  `DELETE`) are reads; `INSERT INTO`, `UPDATE`, `DELETE FROM`, `MERGE INTO`
  and `TRUNCATE` targets are writes. An unqualified name gets the function's
  schema (`pg_*` names `pg_catalog`). CTE names, parameters (also `OUT` and
  `RETURNS TABLE` columns), declared and loop variables, temporary tables
  created in the body and `NEW` / `OLD` are dropped. Dynamic SQL (`EXECUTE` of
  a string) is not seen. Sorted, deduplicated, at most 50 each.

### Column importance

Which columns of a table matter is decided by people and the agent, not
computed. The `auspex-columns` skill (prompt `columns`) reads the SQL that
uses a table - the report library and the script files in a configured
script root the user confirms - attributes every column use to its table
(aliases and CTEs resolved), and saves with `score_columns`. Each column
has two layers:

- `agent` (`by: "agent"`, the default): `score` 1-5, `roles` (any of `key`,
  `join`, `filter`, `display`, `aggregate`, `sort/group`), `reason` (one
  line, at most 200 characters, in the `notesLanguage`) and `sources`
  (distinct reports and scripts; versions of one report count once).
- `user` (`by: "user"`): a score the user stated in the conversation, with
  optional `roles`. The user's usage note ("mostly in WHERE, sometimes in
  SELECT") is saved as an ordinary column rule with `remember`, so it shows on
  the Rules tab and can be archived. `clearUser: true` removes the user score.

The effective score is the user score when present, otherwise the agent
score. An agent rescan updates only the agent layer, so both stay visible
("user 5, agent 2"). Each layer keeps its previous 5 states as history
(newest first, a removal included); columns and layers not listed keep their
score.

### Code meanings

What a column means is often visible only in the application that writes
or shows it. The `auspex-code` skill (prompt `code`) has the agent read the
source code in a configured **code root** with its own file tools - ORM
mappings, computations, UI labels, permission flags, validation messages and
enum names - and save one sentence per column with `remember` as an
inference with `evidenceCode`:

```json
{ "action": "add", "kind": "inference", "schema": "example", "table": "orders", "column": "amount",
  "text": "Appears to be the order total: net amount plus tax and shipping.",
  "evidenceCode": [{ "root": "example_app", "path": "src/Orders/Order.cs", "line": 42, "symbol": "Order.Amount" }] }
```

- `evidenceCode` is accepted with `kind` `inference` or `observation` (not
  `rule`) and only on `action=add`; at most 5 references.
- `root` must be a configured code root name (see Configuration). `path` is
  relative to it: absolute, drive (`C:\...`), drive-relative and UNC paths
  and `.`/`..` segments are rejected; `\` becomes `/`. `line` (optional) is an
  integer from 1 to 10000000; `symbol` (optional) is one line of at most 120
  characters. Unknown keys are rejected.
- Only the references are stored on the note (`evidenceCode` in
  `notes.json`, `graph.json` and `table_knowledge`); Auspex never reads or
  writes code files and never stores code text. The audit entry of `remember`
  stays as before: no note text and no evidence.
- Such a note is a code inference until the user agrees and the agent
  confirms it (`action=confirm`, which keeps the references). The viewer shows
  a *from code* badge (TR *koddan*) next to the kind on the Rules tab and in
  the table page's column rows, and the references as
  `root:path:line · symbol` text in the evidence (no links, nothing opens a
  file). In the table page's Summary, a column chip's tooltip adds the meaning
  of a confirmed note read from code.

| Score | Meaning (relative within the table) |
|---|---|
| 5 core | most reports revolve around it: main join key, period filter, primary display field |
| 4 frequent | used regularly in many reports |
| 3 topical | appears in the reports of one topic |
| 2 rare | one report, or only in an old version |
| 1 unused | appears in no SQL |

A column used only on application screens and in no report or script scores
low; after a scan the skill asks once which such columns matter and saves the
answers as user scores.

- Optional `triggers`: one-line summary per trigger of what its function does
  (the source is never stored). A summary is marked `summaryStale` when the
  trigger definition changes; a change of only the function body is not
  detected, so ask the agent to re-read the functions when they changed.
- Optional `scannedFiles`: `root` (a configured script root name), path
  relative to it and sha256 of each script file read. `scanned_files` lists
  them, so later runs skip unchanged files. Each root keeps at most 20000
  entries; the ones read longest ago are pruned first. Files outside a
  configured root are not recorded. Script files are never copied, saved as
  reports or modified.

The table must be described first and every column and trigger must exist in
its recorded structure; otherwise the whole call is rejected and nothing is
saved. `table_knowledge` returns per column the effective `score` and
`scoreBy`, both layers and `noteIds` (active notes on that column, such as the
user's usage rule). The viewer write path for user scores is not part of this
release.

```json
{ "profile": "example", "schema": "example", "table": "orders",
  "columns": [
    { "name": "order_id", "score": 5, "roles": ["key", "join"], "reason": "Joined to example.order_items in every report.", "sources": 7 },
    { "name": "created_at", "by": "user", "score": 5, "roles": ["filter"] }
  ],
  "triggers": [{ "name": "orders_check", "summary": "Rejects rows whose status_code is not in example.status_codes." }],
  "scannedFiles": [{ "root": "scripts", "path": "example/reports/orders_by_day.sql", "sha256": "<64 hex>" }] }
```
