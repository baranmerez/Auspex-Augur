# Auspex Augur — Handoff

Last updated: 2026-10-17 · Versions: MCP server 0.9.0, desktop app 0.1.0

Environment-specific details (servers, databases, schema lists, privilege
exceptions) are **not** in this file. They live in
`handoff/environment.local.md`, which is git-ignored.

Latest work: see [Report engine and exploration](#15-report-engine-and-exploration-2026-10-1517)
for the batch exploration tools, table roles, skills and viewer views.

---

## 1. What Auspex is

An MCP server that lets AI agents explore and analyze PostgreSQL databases
**read-only**. It is a general tool, not tied to one application, model or
client: the profiles file alone decides which databases it can reach, and any
MCP client (Claude Code, Codex, Cursor, VS Code, ...) can use it.

- The agent finds tables, reads their structure, runs SELECT and EXPLAIN
  (including ANALYZE), and writes large results to CSV.
- It can never write: INSERT/UPDATE/DELETE/DDL are denied by the database role
  and blocked again by four code layers.
- Every operation goes to an audit log, which the local viewer and the desktop
  app display.

## 2. Repository layout

```
auspex/
├── src/
│   ├── index.js        MCP server (stdio): tools, server instructions
│   ├── db.js           ReadOnlyDatabase: READ ONLY tx, cursor, timeouts, audit
│   ├── sqlGuard.js     SQL guard (single statement, forbidden keywords/functions)
│   ├── catalog.js      list_schemas / list_tables / describe_table(s) / describe_functions / profile_tables / relation_stats / search
│   ├── errors.js       Stable error codes for the tool error envelope
│   ├── skills.js       Loads skills/ as MCP prompts
│   ├── config.js       ~/.auspex, profiles.json, environment variables
│   ├── auditLog.js     Daily JSONL audit log
│   ├── fileLock.js     Cross-process lock for the library and the schema memory
│   ├── roleCheck.js    Read-only role check on the first call to each profile
│   ├── viewer.js       Local viewer server (127.0.0.1:4719)
│   ├── scheduleCli.js  Scheduled report runs: run-due, run, status, task-command
│   ├── schedule/       schedules.json validation and slots, runner, state/trend files, notifications
│   ├── viewer.html     Viewer UI (shared by browser and desktop app)
│   ├── reports/        Report library: library, plan summary, masking, HTML template
│   └── memory/         Schema memory: store (tables, notes, relations, view) and plan usage
├── desktop/            Tauri 2 desktop app (Rust)
├── skills/             Workflow skills auspex-explore / -report / -ddl (also served as MCP prompts)
├── scripts/            SQL: local test setup (+ DDL fixture), role creation, schema grants; installSkills.mjs
├── tests/              Unit tests (*.test.js) + local integration test
├── profiles.example.json
├── handoff/            This file (+ environment.local.md, git-ignored)
└── README.md           Technical reference
```

## 3. MCP tools

| Tool | Purpose |
|---|---|
| `list_profiles` | Configured profiles (description, host, database, user, timeout ceiling, query budget, role check; never passwords) |
| `check_profile` | Runs the read-only role check now |
| `search` | Search table/view/column names and comments, functions and triggers (optionally function source) across all schemas |
| `list_schemas`, `list_tables`, `describe_table` | Browse: schemas, tables (estimated rows, size, privilege), columns, FKs, indexes, view definitions |
| `describe_tables` | Up to 50 relations in 6 statements (7 with a view); `detail: "summary"` (default, compact) or `"full"`; includes triggers, checks, sequences, partitions, RLS |
| `describe_functions` | Up to 50 functions: signature, properties, triggers using them, definition (1 statement) |
| `profile_tables` | Up to 30 relations: fill rate, sample distinct counts, fan-out over a parent with `window` and `parentFilter` (at most 3 statements, no row values) |
| `relation_stats` | Instance (referenced) and dependent (referencing) tables of a center, ranked by estimated linked rows from planner statistics (at most 2 statements); enriches graph.json |
| `share_report` | Sanitized shareable copy; refused unless the last run matches the active SQL |
| `query` | One SELECT/WITH/VALUES/TABLE statement; max 500 rows; `$1..$n` params; `timeoutSeconds` |
| `explain` | Estimated plan; `analyze: true` for real timings and buffers |
| `export_csv` | Writes the result to CSV under `~/.auspex/exports`, returns only path and row count |
| `save_report`, `run_report`, `approve_report`, `list_reports`, `render_reports` | Report library: versioned drafts, read-only runs with plan summary and masked preview, approval after explicit user consent (`approve_report` takes an optional `expectedHash`; a changed draft is refused with `STALE_VERSION`) |
| `save_execute_script` | Writes a change script into `EXECUTE/`; never executed by Auspex |
| `table_knowledge` | Answers from the schema memory without database access |
| `remember` | Adds, confirms or archives a note (rule, observation, inference) |

`describe_table` also records the table in the schema memory and reports
changes since the last time; `run_report` and `explain` record the tables and
columns their plans used. The memory never crawls the catalog on its own.

Tool errors carry a structured envelope (`code`, `retryable`,
`retryAfterSeconds`, `sqlState`, `correlationId`) next to the readable text;
the correlation ID is also on every audit entry of that call. MCP prompts
`explore`, `report` and `ddl` serve the workflow skills.

**A profile is mandatory.** There is no default database. Every tool requires
a profile name, and the server instructions tell the model to ask the user which
database to use unless they named one in the current conversation.

## 4. Safety layers (outside in)

1. **Database role `"Auspex"`** — the real guarantee. Only `CONNECT`, `USAGE`,
   `SELECT`; `default_transaction_read_only = on`, `statement_timeout = 30s`,
   `CONNECTION LIMIT 3`; superuser, createdb, createrole, inherit, replication
   and bypassrls all off. In SQL always write it quoted: `"Auspex"`.
2. **SQL guard** (`sqlGuard.js`) — before connecting: single statement, first
   keyword SELECT/WITH/VALUES/TABLE; data-modifying CTEs, `SELECT INTO`,
   `FOR UPDATE` and side-effect functions (`set_config`,
   `pg_terminate_backend`, `pg_sleep`, `lo_*`, `dblink*`, `pg_read_*`,
   `nextval`, ...) are rejected, also when the name is quoted,
   schema-qualified or Unicode-escaped (lexical check; user-defined functions
   that call them are limited by the role's grants, not by the guard).
3. **READ ONLY transaction** — every call runs in `BEGIN ... READ ONLY` with
   `SET LOCAL statement_timeout / lock_timeout / idle_in_transaction...` and
   always ends with `ROLLBACK`.
4. **Cursor + extended protocol** — queries run as `DECLARE CURSOR FOR`; the
   server itself rejects stacked statements and data-modifying CTEs.
5. **Audit log** — in the database layer, so both MCP and script calls are
   recorded (`source: mcp | script`), rejected queries included.
6. **Role check** — on the first call to a profile the role is checked from
   the catalog; a role that could write (superuser, BYPASSRLS, REPLICATION,
   CREATEROLE, write-data/server-file role membership, any writable table)
   blocks the profile. Known privilege exceptions that only warn are listed
   in environment.local.md.
7. **Query budget** — at most `AUSPEX_MAX_QUERIES_PER_MINUTE` (default 60, per-profile override) database operations per profile per sliding minute in one process; more is refused before connecting and audited, so a script loop cannot flood a database.

Passwords are in no file of this project: they live in **pgpass**
(`%APPDATA%\postgresql\pgpass.conf`, line: `host:port:db:Auspex:password`).
If `profiles.json` contains a password, Auspex refuses to start.

## 5. File locations (`C:\Users\<user>\.auspex`)

```
.auspex\
├── profiles.json   Database profiles
├── logs\           YYYY-MM-DD.jsonl audit log (file name is the UTC day)
├── exports\        CSV exports
├── library\        Report library: _drafts\, SELECT\, EXECUTE\ by db\schema\category
├── memory\         Schema memory per profile: tables\, notes.json, changelog.jsonl, graph.json
├── schedules.json  Report schedules, edited by the user (optional)
├── schedule-state.json  Last scheduled result per schedule (written by scheduleCli.js)
├── scheduler.lock  Held while scheduleCli.js runs schedules (one run at a time)
├── trends\         Trend points per scheduled report: <profile>\<schema>\<category>\<name>.jsonl
└── analyses\       Optional: analysis output written by agents
```

**Why not AppData:** when the MCP client is an MSIX-packaged desktop app,
Windows redirects AppData writes of its child processes into a hidden
`AppData\Local\Packages\<package>\LocalCache\...` folder. Files there were
invisible in Explorer and unreadable for tools started outside the app. Old
copies remain in that hidden folder and are no longer used.

## 6. Setup (new machine)

```bash
cd <repo> && npm install
npm test
```

Register the stdio server `node <repo>/src/index.js` under the name `auspex`
in your MCP client. The README has ready-made snippets for Claude Code, Codex
CLI, Cursor and VS Code, plus the generic `mcpServers` JSON.

Then create `~/.auspex/profiles.json` (see `profiles.example.json`) and the
pgpass lines. Profile changes are picked up when the client session restarts.

## 7. Adding a database

1. On the server, in your SQL client as a superuser:
   `scripts/create-auspex-role.sql` (change the password; run with ROLLBACK
   first, check the verification results, then COMMIT).
2. In the same database: `scripts/grant-schemas-readonly.sql` — USAGE +
   SELECT + default privileges for `"Auspex"` only; no other role's
   privileges change. Do not open personal-data or identity schemas (e.g.
   user-account or identity schemas).
3. Add the pgpass line (line format `host:port:database:user:password`, see the README).
4. Add a `profiles.json` entry: `url` (no password), `description` (write
   "PRODUCTION" for production), optional `maxTimeoutSeconds`.
5. Start a new session and check with `list_profiles`.

Known pitfall: if a schema grants CREATE to PUBLIC, `"Auspex"` inherits it.
In practice the READ ONLY transaction still blocks writes, but the role layer
has a hole in that schema.

## 8. Viewer

- **Browser:** `npm run viewer` → http://127.0.0.1:4719
- **Desktop:** `desktop/src-tauri/target/release/auspex-augur.exe` (start it
  from Explorer). Tray menu: Open Auspex, Show log folder, Start with Windows,
  Quit. Closing the window minimizes to the tray.
- Header: database switcher (applies to every tab), EN/TR, theme, and a badge
  for unseen schema changes.
- Tabs: Overview (stat tiles, activity chart, by profile/tool/table, slowest
  operations, recent errors), Operations (sort, paging, details, copy,
  CSV/JSON download with error codes), Tables (accesses extracted from SQL),
  Reports (collapsible topic/subtopic tree with a filter box; report with question
  line, compact metrics strip, warnings badge with a remembered Performance
  details toggle, Approve/Revoke buttons beside the title, sticky tabs,
  Preview first; the preview table sorts, filters, shows a totals row and
  exports CSV;
  SQL highlighting; copy relayed to the viewer clipboard), Schema (Graph,
  ER diagram and Flow views, schema picker, notes inspector, change
  timeline), Profiles. Full window width with one page scroll.
- Schema roles: for the selected table, Reference/Instance tables (it points
  at them) and Dependent/Beslenen tables (they point at it), ranked by
  `linkedRows` then estimated rows, with a per-side top-N picker (5, 10, 25,
  50, All) in ER and Flow. The Graph is a 3D graph (2D fallback) with
  click-to-focus, directed Reference/Dependent layers and +1 depth; edges are
  blue/orange by role and shaded by rank. Flow shows tinted swimlanes
  Reference → Center → Dependent around a center card, with join-column
  labels, depth 2. Colors are theme tokens at the top of `viewer.html`
  (`--role-ref-*`, `--role-dep-*`, `--lane-*`); ready themes and a
  contrast-checked theme generator (custom themes saved, exported, imported).
- After viewer changes rebuild the desktop app (app closed) and run
  `render_reports` so library HTML uses the current template.
- The Schema tab reads `graph.json`, which the memory module rebuilds after
  every change, so the viewer and the Rust app contain no relation logic.
- Scheduled reports: badge with the last scheduled result in the list,
  schedule lines in the header and a trend chart (row count, up to four
  column totals) above the report, from `/api/reports` and the GET route
  `/api/reports/trend` (no parameter values). Not in the desktop app yet.
- Binds to 127.0.0.1 only, GET only except the two approval routes and
  `POST /api/memory/archive` (same Host, Origin, per-process token, JSON and
  4 KB checks, audited), foreign Host headers get 403; never connects to a
  database.
- Report approval: Reports tab *Approve* / *Revoke approval* (TR *Onayla* /
  *Onayı geri al*) with a confirm dialog. The browser viewer POSTs to its
  routes; the desktop app's `approve_report` / `revoke_report` Tauri commands
  run `node <auspexRoot>/src/stageCli.js` (no shell, 30 s timeout), audited
  with actor `desktop`. Shared logic: `src/reports/stageChange.js`. The
  desktop needs Node (PATH or `AUSPEX_NODE`) and `AUSPEX_ROOT` or
  `"auspexRoot"` in profiles.json.

Desktop build: Rust (MSVC toolchain), VS 2022 C++ Build Tools, WebView2;
`cd desktop && npm install && npm run build` (first build ~6 min;
`src-tauri/target` takes 1-4 GB, `cargo clean` removes it).

## 9. Tests

| Command | Scope | Last result |
|---|---|---|
| `npm test` | SQL guard, profiles, config, timeouts, explain, audit and errors (incl. MCP server end to end), reports, change-script lint, CSV export, file lock with child processes, schema memory, catalog batch tools, prompts, skills install, viewer roles, scheduled runs (no database) | 615 pass, 1 skipped (2026-10-18, Windows, Node 24) |
| `npm run test:local` | Local PG16 + `auspex_test` schema: writes rejected by the database, unprivileged table, CTE, stacked statements, timeout, connection drop, EXPLAIN ANALYZE, CSV budget cancellation, search, reports, memory, DDL catalog | 39 pass, 4 skipped (2026-10-18; DDL fixture not applied locally, CI runs them) |
| `cargo test` (in `desktop/src-tauri`) | Path validation and profile rules of the desktop API, report-stage argument validation, CLI result mapping, auspexRoot check, audit line for unknown outcomes | 12/12 (2026-10-17; needs an existing `desktop/dist` folder) |

Local test setup: `scripts/local-test-setup.sql`, then
`scripts/local-test-ddl.sql` (triggers, functions, checks for the DDL catalog
tests; swap its final ROLLBACK to COMMIT once), plus a `local` profile and a
pgpass line. The Turkish names in the test data are intentional: they check
UTF-8 handling.

CI: `.github/workflows/ci.yml` runs `npm test` on Ubuntu (Node 20/22/24) and
Windows (Node 22/24) and `npm run test:local` against a PostgreSQL 16 service
container (same setup script, run through the container socket with a random
password). The "Desktop build (Windows)" job runs `cargo test` and `npm run build` in
`desktop`. Changes go through a pull request and review; required checks run
in CI.

## 10. Client-side setup (outside this repo)

Agent definitions, client rules and local tooling are personal and live
outside the repository. The current setup is described in
`handoff/environment.local.md`.

## 11. Known limitations / open items

- **pgpass deprecation:** `pg` 8.x warns that pgpass support is removed in
  pg@9. Fix: add `pgpass` as an explicit dependency and supply the password
  through a `password` function. Awaiting approval.
- **CSV/JSON download in the desktop app** may not behave like in the browser
  under WebView2; a Rust "save as" dialog can be added if needed.
- **Profile validation:** the desktop app (Rust) reads the profiles file for
  display, and reads `auspexRoot` to locate the stage CLI
  (`src/stageCli.js`) for approve/revoke; `src/config.js` is the source of
  truth for validation.
- **Log file day is UTC:** in time zones ahead of UTC, entries written shortly
  after local midnight land in the previous day's file; the viewer filters by
  local day.
- **Catalog visibility:** PostgreSQL shows table names to everyone; tables in
  unprivileged schemas appear in search (`can_select = false`) but cannot be
  read.
- **Deliberate gaps from the review fixes:** change scripts are checked
  structurally only, never rehearsed against a database (`WHERE true` passes);
  spreadsheet-mode CSVs were not opened in Excel, LibreOffice or Sheets; some
  CSV error paths are tested with in-process fakes rather than child
  processes; database-wide notes come back only from `table_knowledge`, not
  with `query` / `run_report` responses.
- **File locks are same-host only:** a lock whose owner pid is alive on this
  host is not taken over by `staleMs` (#26); that age expiry applies only
  when the owner cannot be checked. Library or memory folders on a network
  filesystem shared between hosts are not supported. If the OS reuses a dead
  owner's pid, its lock (or a leftover `.takeover.*` marker) stays busy until
  the hard ceiling `maxHoldMs` (default 10 minutes) passes; after that it is
  reclaimed even though the pid looks alive. A live owner that really held a
  lock that long would lose it; guarded sections are short synchronous file
  work.
- **Personal data:** grant SELECT per schema; inventory personal-data columns
  during the first exploration, then revoke them or move them behind masked
  views. Report previews are masked by column name; the built-in name lists
  cover English and Turkish, other names go into a report's mask list.
- **Scheduled runs:** the desktop app (Rust API) does not show schedules
  or trends yet. Task Scheduler's restart-on-failure applies when a task
  cannot start, not on a non-zero exit code; the printed task therefore has
  a second daily trigger 30 minutes later, and `run-due` is a no-op for
  slots that already succeeded. Only the most recent due slot of a schedule
  is caught up, not every missed one. Totals in trend points come from the
  stored preview (kept only when it holds every row). No threshold alerts
  yet.

## 12. Next steps

1. Scenario tests on a test database: S1 combined report (for example
   `example.orders` by `customer_id` with `test.invoices` totals and
   `status_code` checks against `example.status_codes`) and S2 integration
   DDL (study a table family, deliver a BEGIN…ROLLBACK script).
2. Remaining roadmap items are tracked in issue #31.
3. pgpass deprecation fix; optional desktop file saving and installer.
4. Scheduled runs: threshold alerts on the trend points after about two
   weeks of data; schedules and trends in the desktop app.

## 13. History

The public repository starts from a single initial commit
(`feat(auspex): initial release of Auspex Augur`). Development before the
first release (MCP server, SQL guard, profiles file, audit log, viewer, Tauri
desktop app, English translation, client-agnostic docs) was squashed into it.

### Review fixes (2026-10-13, merged in #14)

The 13 GitHub issues from the external review were fixed one by one:
quoted/Unicode function names in the guard (#1), one profile URL policy for the
file and AUSPEX_DB_<NAME> with no password in user-info or query (#2), the
omitted timeout clamped to the profile ceiling (#3), a fail-closed change-script
lint (#4), metadata kept inside header comments (#5), approval bound to the
saved SQL revision with a stale-result notice (#6), no query execution for
previewRows 0 (#7), unique CSV names, owned-file cleanup and backpressure (#8),
a spreadsheet-safe CSV mode (#9), a cross-process lock with safe stale takeover
and Windows rename retries (#10), library and memory changes in the audit log
(#12), database-wide notes in table_knowledge (#13) and share_report for a
sanitized copy (#11).

## 14. Security review fixes (2026-10-15)

A security scan reported four low-severity findings. The inline psql lint
bypass was fixed first.

### Implemented fix

- `src/reports/library.js`: reject any backslash left after masking literals,
  quoted identifiers and comments. Inline or adjacent `\gexec` / `\i` commands
  can no longer pass EXECUTE-script lint before file creation or replacement.
- `src/sqlGuard.js`: recognize non-ASCII dollar-quote tags and their identifier
  boundaries, so valid quoted text remains accepted by the stricter check.
- `tests/reports.test.js` and `tests/sqlGuard.test.js`: cover LF/CRLF/CR, inline
  commands, quoted/comment controls, non-ASCII tags, identifier boundaries and
  rejection before creating or overwriting an EXECUTE file.

The original and alternate lint triggers are rejected, while benign controls
pass.

### Remaining findings

1. Done in #27 (PR #32): spreadsheet-mode headers and Operations CSV text
   cells are neutralized; raw export is unchanged.
2. Open: the conditional POSIX artifact-permission finding, to be weighed
   against supported Linux/macOS deployments and local-user access. No
   Windows ACL exposure was established.

Keep each remediation scoped to its finding and regression evidence.

## 15. Report engine and exploration (2026-10-15/17)

Goal: make Auspex a fast exploration, combined-report (S1) and integration-DDL
(S2) tool with low query and token use.

Merged work:

- Review issues #26–#30 (PRs #32, #33): live-owner locks, spreadsheet-safe CSV
  headers and Operations CSV, current-version sharing, whole-export budgets,
  host/port URL options rejected.
- Roadmap #31 T8 (PRs #35–#37): structured error envelope with correlation ID;
  dropped connections are `CONNECTION_FAILED`; a dropped checked-out
  connection no longer crashes the server. Remaining: per-step timings.
- Batch tools and query budget (PRs #24, #25), `relation_stats` and the DDL
  catalog (`describe_functions`, triggers/checks/sequences/partitions, routine
  search) (PR #39), compact `describe_tables` summary, `profile_tables`
  `parentFilter`, lock ceiling `maxHoldMs` (PR #41).
- Skills `auspex-explore`, `auspex-report`, `auspex-ddl`, MCP prompts and
  `npm run skills:install` (PR #38); viewer roles, Flow view and compact
  report header (PR #40).
- 2026-10-16: script roots for change scripts and report files, function
  bodies in change scripts (PR #43); `notesLanguage` for notes, report texts
  and change-script texts, code lookup in the skills, contains-match search
  (PRs #44, #45); viewer: full width with one page scroll, Flow center card
  and join labels, 3D Schema graph with directed layers, per-side top-N
  picker, schema picker, SQL highlighting for change scripts, report filter,
  ready themes and a theme generator (PRs #47–#51); report approval revoke
  and stage history, approve/revoke from the browser viewer and from the
  desktop app through the stage CLI and `auspexRoot` (PRs #52, #53).
- 2026-10-16: documentation, skills and tests made generic for any user (PR #54):
  examples use one alias set, no assumed SQL client, folder layout, naming
  convention or business-data language, no default for cancelled or deleted
  rows (the agent asks and saves the answer as a rule), the step structure
  of change scripts is described as recommended, and the existing-file
  error suggests a number only when the folder already numbers its files.
- 2026-10-17: the stale-by-age lock takeover test got a longer waitMs so slow
  Windows runners cannot exhaust it (PR #55).
- 2026-10-17 (external review): approve/revoke are bound to the reviewed SQL
  hash (`expectedHash`, required in viewer/desktop/stage CLI, optional in
  `approve_report`; mismatch is `STALE_VERSION`; `save_report` and
  `run_report` return the `sqlHash`), and a malformed viewer
  request target is answered with 400 instead of stopping the viewer.
- 2026-10-17: nested report categories: a category may be up to three
  levels joined by "/" (e.g. Orders/Delivery), stored as nested folders and
  listed with `category` (joined) and `categoryPath`; the viewer and desktop
  show the Reports list as a topic/subtopic tree, change scripts only in
  their own tab. Existing single-level categories are unchanged.
- 2026-10-17: report detail screen (PR #59): the preview table sorts, filters
  and has a totals row and CSV export; Approve/Revoke sit next to the title;
  the Performance details toggle is remembered. The CSV download is
  click-gated, saved under a forced `.csv` name with a UTF-8 BOM, uses a
  decimal comma in Turkish exports, and identifier/code columns are skipped
  in the totals row.
- 2026-10-17: report presets, favorites and Ask Claude: built-in relative
  date-range presets and named custom presets (`save_report` `presets`,
  `run_report` `preset`, recorded per run, listed by `list_reports`); the
  viewer header shows them read-only, Favorites/Recent sit above the report
  tree (local browser storage), and *Ask Claude* copies a prompt without row values.
- 2026-10-18: Rules tab lists all schema-memory notes with filters and archives an active note with a required reason (`POST /api/memory/archive`, desktop `archive_note` -> `stageCli.js archive-note`, same store logic and lock as `remember`); Schema tab downloads a data dictionary (HTML/Markdown) built from memory only.

Working agreements:

- Table roles: Instance = tables the center references; Beslenen (Dependent)
  = tables referencing the center; ranked by estimated linked rows, then size.
- Changes go through a pull request and review; required checks run in CI.
- Commits and PRs carry no attribution trailer.
- Exploration batches announce their statement count first.
