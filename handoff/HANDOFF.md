# Auspex Augur — Handoff

Last updated: 2026-10-13 · Versions: MCP server 0.6.0, desktop app 0.1.0

Environment-specific details (servers, databases, schema lists, privilege
exceptions) are **not** in this file. They live in
`handoff/environment.local.md`, which is git-ignored.

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
│   ├── viewer.js       Local viewer server (127.0.0.1:4719)
│   └── viewer.html     Viewer UI (shared by browser and desktop app)
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
   `nextval`, ...) are rejected.
3. **READ ONLY transaction** — every call runs in `BEGIN ... READ ONLY` with
   `SET LOCAL statement_timeout / lock_timeout / idle_in_transaction...` and
   always ends with `ROLLBACK`.
4. **Cursor + extended protocol** — queries run as `DECLARE CURSOR FOR`; the
   server itself rejects stacked statements and data-modifying CTEs.
5. **Audit log** — in the database layer, so both MCP and script calls are
   recorded (`source: mcp | script`), rejected queries included.

Passwords are in no file of this project: they live in **pgpass**
(`%APPDATA%\postgresql\pgpass.conf`, line: `host:port:db:Auspex:password`).
If `profiles.json` contains a password, Auspex refuses to start.

## 5. File locations (`C:\Users\<user>\.auspex`)

```
.auspex\
├── profiles.json   Database profiles
├── logs\           YYYY-MM-DD.jsonl audit log (file name is the UTC day)
├── exports\        CSV exports
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
- Tabs: Overview (stat tiles, activity chart, by profile/tool/table, slowest
  operations, recent errors), Operations (sort, paging, details, copy,
  CSV/JSON download), Tables (accesses extracted from SQL), Profiles.
- Binds to 127.0.0.1 only, GET only, foreign Host headers get 403; never
  connects to a database.

Desktop build: Rust (MSVC toolchain), VS 2022 C++ Build Tools, WebView2;
`cd desktop && npm install && npm run build` (first build ~6 min;
`src-tauri/target` takes 1-4 GB, `cargo clean` removes it).

## 9. Tests

| Command | Scope | Last result |
|---|---|---|
| `npm test` | SQL guard, profiles, config, timeouts, explain, audit (no database) | 81/81 |
| `npm run test:local` | Local PG16 + `auspex_test` schema: writes rejected by the database, unprivileged table, CTE, stacked statements, timeout, EXPLAIN ANALYZE, CSV, search | 22/22 |

Local test setup: `scripts/local-test-setup.sql` (+ a `local` profile and a
pgpass line). The Turkish names in the test data are intentional: they check
UTF-8 handling.

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
- **Personal data:** SELECT was granted per schema. Personal-data columns are
  to be inventoried during the first exploration, then revoked or moved
  behind masked views. Reports never contain personal values.

## 12. Next steps

1. First real exploration and data dictionary with the data agents
   (see `environment.local.md`).
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
