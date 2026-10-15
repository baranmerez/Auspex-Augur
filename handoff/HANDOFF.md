# Auspex Augur — Handoff

Last updated: 2026-10-15 · Versions: MCP server 0.9.0, desktop app 0.1.0

Environment-specific details (servers, databases, schema lists, privilege
exceptions) are **not** in this file. They live in
`handoff/environment.local.md`, which is git-ignored.

Current security work: see [Security Analyze handoff](#14-security-analyze-handoff-2026-10-15)
for the psql fix, verification evidence and proposed next steps.

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
│   ├── catalog.js      list_schemas / list_tables / describe_table / search
│   ├── config.js       ~/.auspex, profiles.json, environment variables
│   ├── auditLog.js     Daily JSONL audit log
│   ├── fileLock.js     Cross-process lock for the library and the schema memory
│   ├── roleCheck.js    Read-only role check on the first call to each profile
│   ├── viewer.js       Local viewer server (127.0.0.1:4719)
│   ├── viewer.html     Viewer UI (shared by browser and desktop app)
│   ├── reports/        Report library: library, plan summary, masking, HTML template
│   └── memory/         Schema memory: store (tables, notes, relations, view) and plan usage
├── desktop/            Tauri 2 desktop app (Rust)
├── scripts/            SQL: local test setup, role creation, schema grants
├── tests/              Unit tests (*.test.js) + local integration test
├── profiles.example.json
├── handoff/            This file (+ environment.local.md, git-ignored)
└── README.md           Technical reference
```

## 3. MCP tools

| Tool | Purpose |
|---|---|
| `list_profiles` | Configured profiles (description, host, database, user, timeout ceiling; never passwords) |
| `search` | Search table/view/column names and comments across all schemas |
| `list_schemas`, `list_tables`, `describe_table` | Browse: schemas, tables (estimated rows, size, privilege), columns, FKs, indexes, view definitions |
| `query` | One SELECT/WITH/VALUES/TABLE statement; max 500 rows; `$1..$n` params; `timeoutSeconds` |
| `explain` | Estimated plan; `analyze: true` for real timings and buffers |
| `export_csv` | Writes the result to CSV under `~/.auspex/exports`, returns only path and row count |
| `save_report`, `run_report`, `approve_report`, `list_reports`, `render_reports` | Report library: versioned drafts, read-only runs with plan summary and masked preview, approval after explicit user consent |
| `save_execute_script` | Writes a change script into `EXECUTE/`; never executed by Auspex |
| `table_knowledge` | Answers from the schema memory without database access |
| `remember` | Adds, confirms or archives a note (rule, observation, inference) |

`describe_table` also records the table in the schema memory and reports
changes since the last time; `run_report` and `explain` record the tables and
columns their plans used. The memory never crawls the catalog on its own.

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
└── analyses\       Optional: analysis output written by agents
```

**Why not AppData:** when the MCP client is an MSIX-packaged desktop app,
Windows redirects AppData writes of its child processes into a hidden
`AppData\Local\Packages\<package>\LocalCache\...` folder. Files there were
invisible in Explorer and unreadable for tools started outside the app. Old
copies remain in that hidden folder and are no longer used.

## 6. Setup (new machine)

```bash
cd C:/src/mcps/auspex && npm install
npm test
```

Register the stdio server `node <repo>/src/index.js` under the name `auspex`
in your MCP client. The README has ready-made snippets for Claude Code, Codex
CLI, Cursor and VS Code, plus the generic `mcpServers` JSON.

Then create `~/.auspex/profiles.json` (see `profiles.example.json`) and the
pgpass lines. Profile changes are picked up when the client session restarts.

## 7. Adding a database

1. On the server, in DBeaver as superuser: `scripts/create-auspex-role.sql`
   (change the password; run with ROLLBACK first, check the MATCH results,
   then COMMIT).
2. In the same database: `scripts/grant-schemas-readonly.sql` — USAGE +
   SELECT + default privileges for `"Auspex"` only; no other role's
   privileges change. Do not open personal-data or identity schemas (e.g.
   ASP.NET Identity schemas).
3. Add the pgpass line (PowerShell command in the README; the password never
   reaches the screen).
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
  CSV/JSON download), Tables (accesses extracted from SQL), Reports (library
  tree and report HTML), Schema (relation graph, ER diagram, notes inspector,
  change timeline), Profiles.
- The Schema tab reads `graph.json`, which the memory module rebuilds after
  every change, so the viewer and the Rust app contain no relation logic.
- Binds to 127.0.0.1 only, GET only, foreign Host headers get 403; never
  connects to a database.

Desktop build: Rust (MSVC toolchain), VS 2022 C++ Build Tools, WebView2;
`cd desktop && npm install && npm run build` (first build ~6 min;
`src-tauri/target` takes 1-4 GB, `cargo clean` removes it).

## 9. Tests

| Command | Scope | Last result |
|---|---|---|
| `npm test` | SQL guard, profiles, config, timeouts, explain, audit (incl. MCP server end to end), reports, change-script lint, CSV export, file lock with child processes, schema memory (no database) | 262/262 (psql delivery run; Windows, Node 24.18.0) |
| `npm run test:local` | Local PG16 + `auspex_test` schema: writes rejected by the database, unprivileged table, CTE, stacked statements, timeout, EXPLAIN ANALYZE, CSV, search, reports, memory | 35/35 (psql delivery run) |
| `cargo test` (in `desktop/src-tauri`) | Path validation of the desktop API | 1/1 |

The package and local PostgreSQL suites passed after integrating upstream
revision `1608991` with the psql fix. The Cargo result is historical; no desktop
code was changed by this fix. See section 14 for focused regression evidence.

Local test setup: `scripts/local-test-setup.sql` (+ a `local` profile and a
pgpass line). The Turkish names in the test data are intentional: they check
UTF-8 handling.

CI: `.github/workflows/ci.yml` runs `npm test` on Ubuntu (Node 20/22/24) and
Windows (Node 22/24) and `npm run test:local` against a PostgreSQL 16 service
container (same setup script, run through the container socket with a random
password). The "Desktop build (Windows)" job runs `cargo test` and `npm run build` in
`desktop`. All seven jobs are required checks on `main` (branch protection,
admins exempt); PRs are merged with `gh pr merge --auto --rebase` and their
branch is deleted automatically.

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
  display only; `src/config.js` is the source of truth for validation.
- **Log file day is UTC:** entries between 00:00 and 03:00 Turkey time land in
  the previous day's file; the viewer filters by local day.
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
- **Personal data:** SELECT was granted per schema. Personal-data columns are
  to be inventoried during the first exploration, then revoked or moved
  behind masked views. Reports never contain personal values.

## 12. Next steps

1. Keep exploring with the schema memory: after each report, review the
   unexplored neighbors it suggests.
2. Personal-data column inventory and a privilege decision.
3. Production database: role + schema grants + profile (`description`:
   "PRODUCTION", lower `maxTimeoutSeconds`).
4. pgpass deprecation fix.
5. Optional: file saving in the desktop app, NSIS installer.

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

## 14. Security Analyze handoff (2026-10-15)

Task: **Auspex Augur / Security Analyze** (`auspex-augur` / `security-analyze`).
Codex Security scan `8b86b0d7-95e5-42df-90b3-7505b16f878b` completed against
revision `4d20f27bb227913a527c399dbebca87a0be18bbe` with four low-severity findings.
The user selected the inline psql lint bypass for the first remediation.

### Implemented fix

- `src/reports/library.js`: reject any backslash left after masking literals,
  quoted identifiers and comments. Inline or adjacent `\gexec` / `\i` commands
  can no longer pass EXECUTE-script lint before file creation or replacement.
- `src/sqlGuard.js`: recognize non-ASCII dollar-quote tags and their identifier
  boundaries, so valid quoted text remains accepted by the stricter check.
- `tests/reports.test.js` and `tests/sqlGuard.test.js`: cover LF/CRLF/CR, inline
  commands, quoted/comment controls, non-ASCII tags, identifier boundaries and
  rejection before creating or overwriting an EXECUTE file.

The user authorized commit and push on 2026-10-15. These four source/test files
and this handoff belong to the same delivery. No PR or deployment was performed.

### Verification already completed

- Before the source fix, the psql-focused run reproduced five failures.
- `node --test tests/reports.test.js tests/sqlGuard.test.js`: **132/132 passed**.
- Initial `node --test tests/*.test.js`: **238/238 passed**, no failures or skips.
- After fast-forwarding to upstream `1608991`, the required pre-commit gates
  passed: `npm test` **262/262** and `npm run test:local` **35/35**, no skips.
- `git diff --check` and syntax checks on the four changed JavaScript files passed.
- One independent read-only patch review found no concrete issue.

The original and alternate lint triggers are rejected, while benign controls
pass. Local integration used the existing localhost test profile, with generated
files redirected to temporary directories. No privileged psql script,
spreadsheet end-to-end test or POSIX permission test was executed.

The completed scan report remains unchanged. Supplemental `artifacts/fix_report.md`
and `artifacts/psql-fix/{before-fix,focused,package-tests}.log` are retained in
the local Codex Security collection
`artifacts-7a5cd8370b1a0d9cb938ec6da56de3bbbc3ecd44d78a23bda03808d5eb049eb0`.
The same collection contains the delivery logs
`artifacts/psql-fix/{precommit-unit,precommit-integration}.log`.

### Proposed next work

1. Done: CI passed for the delivery commit `3adfce9`.
2. Done in #27 (PR #32): spreadsheet-mode headers and Operations CSV text
   cells are neutralized; raw export is unchanged.
3. Prioritize the conditional POSIX artifact-permission finding according to
   supported Linux/macOS deployments and local-user access. The scan did not
   establish a Windows ACL exposure.

This is the recommended order, not authorization to implement the remaining
findings. The current evidence does not call for another full scan, a new SQL
parser or a broad architecture refactor. Keep each remediation scoped to its
finding and regression evidence.

