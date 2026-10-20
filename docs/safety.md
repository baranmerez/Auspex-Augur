<p><a href="../README.md">← Back to README</a></p>

# Safety layers

How Auspex keeps every call read-only, layer by layer.

## 🛡️ Safety layers

<p align="center">
  <img src="assets/safety-layers.svg" alt="Five safety layers: SQL guard, READ ONLY transaction, cursor and extended protocol, read-only database role, audit log" width="100%">
</p>

<details>
<summary><b>Details of each layer</b></summary>

1. **SQL guard** (`src/sqlGuard.js`): single statement only; must start with
   `SELECT`/`WITH`/`VALUES`/`TABLE`; rejects data-modifying CTEs, `SELECT INTO`,
   `FOR UPDATE` and side-effect functions (`set_config`, `pg_terminate_backend`,
   `pg_sleep`, `lo_*`, `dblink*`, `pg_read_*`, `nextval`...), also when the
   name is quoted, schema-qualified or Unicode-escaped (comments and a lone
   carriage return are read the way PostgreSQL reads them), and built-ins that
   run SQL given as text (`query_to_xml*`, `cursor_to_xml*`, `ts_stat`,
   `ts_rewrite`). Runs before connecting. It is a lexical check only: functions
   that call these internally are not seen, so what the role may EXECUTE is
   limited by its grants.
2. **Transaction wrapper** (`src/db.js`): every call runs in
   `BEGIN ... READ ONLY` with `statement_timeout`, `lock_timeout`,
   `idle_in_transaction_session_timeout` and `standard_conforming_strings = on`
   (so strings are read the way the SQL guard reads them), and always ends
   with `ROLLBACK`.
3. **Cursor + extended protocol:** queries run as `DECLARE CURSOR FOR <query>`
   over the extended protocol, which rejects stacked statements and
   data-modifying CTEs at the server.
4. **Database role (the real guarantee):** the role only has `CONNECT`, `USAGE`
   and `SELECT`. Everything else is defense in depth. Auspex checks this
   instead of trusting it: on the first call to each profile it reads the
   catalog (`src/roleCheck.js`). Superuser, `BYPASSRLS`, `REPLICATION`,
   `CREATEROLE`, membership in `pg_write_all_data` or the server-file roles, or
   any table it can write (table or column grants) **block** the profile: no
   query runs on it until the role is fixed. CREATE on a schema or the
   database, `CREATEDB` and `default_transaction_read_only` off are
   **warnings** only, since the READ ONLY transaction already stops them. The
   result is in `list_profiles`, `check_profile` runs it again, and the audit
   log and the viewer's profile cards show it.
5. **Audit log:** appended to `<data dir>/logs/YYYY-MM-DD.jsonl`.
   - Database calls (`query`, `explain`, `export_csv`, `run_report`, catalog
     tools): time, source, tool, profile, SQL, params, row count, duration,
     error — also when the SQL guard rejects the query.
   - `run_report` has one entry per call for the whole run: refusals before
     the database (both `params` and `preset`, a `.sql` file changed outside
     `save_report`, a missing report, a busy lock) and failures after the
     query (saving the run, writing the HTML) carry `error` and `errorCode`.
     `phases.database` holds the duration of the database part (and its
     `errorCode` if that part failed); no `phases` means the run was refused
     before the database. A success adds the stage, version and SQL hash.
     Preview values and masking settings are not logged. Scheduled runs keep
     their own `run_report` entry for the database part next to `schedule_run`.
   - Library and memory changes (`save_report`, `approve_report`,
     `save_execute_script`, `render_reports`, `share_report`, `remember`,
     `score_columns`): which report, note or table, the SQL hash and version,
     note id and status or the number of scored columns, trigger summaries and
     scanned files, and the error;
     for a report or script saved into a script root also the root, folder
     and file name and the written paths.
     The SQL text, note text, evidence, reasons, trigger summaries and
     scanned file paths are not logged.
   - Not logged: tools that only read local files (`table_knowledge`,
     `scanned_files`, `list_reports`, `list_profiles`) and calls the MCP SDK rejects for
     invalid arguments before any handler runs.
   - Writing is best effort: if the log cannot be written, the call still
     runs and the failure goes to stderr. A day file that is a symbolic link,
     junction, hard-linked file or not a regular file is refused the same way,
     so log lines never land in a file outside the log folder. The file is plain appendable JSONL
     on your disk, readable and editable by your user account; it is a record,
     not tamper-proof evidence.

</details>

> [!WARNING]
> Never put a password in a connection string or in `profiles.json` — Auspex
> refuses to start if it finds one, whether in `user:password@` or as a
> `?password=` / `?sslpassword=` option, in the file or in `AUSPEX_DB_<NAME>`.
> Passwords belong in pgpass only.

## Local viewer and other OS accounts

The browser viewer (`npm run viewer`) listens on `127.0.0.1` and checks the
Host header. Every `/api` route, reads as well as the four write routes, needs
the `X-Auspex-Token` header with a random token created per viewer process;
write routes also need the exact `Origin`. Requests without the token get 401
(reads) or 403 (writes) and no data.

This keeps other web pages out, but it does **not** separate local OS
accounts: `GET /` still serves the page with the token to any process on the
machine that can reach the loopback port, and a native HTTP client can send
any `Origin`. Another account on the same machine could therefore read the
audit log (SQL and parameters), reports and schema memory through the viewer,
and use the approve/revoke, note archive and column score routes, even though
it cannot open those files directly (owner-only file permissions do not apply
to the HTTP route).

- On a machine shared with local accounts you do not trust, do not run the
  browser viewer, or run it only briefly and stop it (Ctrl+C) afterwards.
- The desktop app is not affected: it talks to its own window through Tauri
  IPC and opens no loopback HTTP port.
- An owner-only bootstrap secret for the browser viewer is planned
  (issue #102).
