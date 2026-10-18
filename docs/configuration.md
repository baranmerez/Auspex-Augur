<p><a href="../README.md">← Back to README</a></p>

# Configuration

Profiles file, environment variables and the recommended database role.

## 🗂️ Profiles file

Databases are listed in `~/.auspex/profiles.json` (`C:\Users\<you>\.auspex` on
Windows; override with `AUSPEX_PROFILES_FILE`):

```json
{
  "example": {
    "url": "postgresql://Auspex@db.example.test:5432/exampledb",
    "description": "Example PRODUCTION",
    "maxTimeoutSeconds": 180,
    "maxQueriesPerMinute": 30
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `url` | yes | `postgresql://user@host:port/db`; host, user and database are required, and a URL without a port connects to 5432 (written out explicitly, so the endpoint shown is the one used); a password here (user-info or query option) is rejected. Host and port go only in the URL authority (IPv6 in brackets, a Unix socket directory percent-encoded); `host` and `port` query options are rejected. Query options are limited to `ssl`, `sslmode`, `sslcert`, `sslkey`, `sslrootcert`, `sslnegotiation`, `uselibpqcompat`, `application_name`, `fallback_application_name`, `connect_timeout`, `keepalives`, `keepalives_idle`; anything else (for example `options=-c ...`, `replication`, `client_encoding`, `user`, `db`) stops the server at startup, as does the same URL in `AUSPEX_DB_<NAME>` |
| `description` | no | Shown by `list_profiles` when the model asks which database to use; mark production clearly |
| `maxTimeoutSeconds` | no | Ceiling for `timeoutSeconds` on this profile (1-3600) |
| `maxQueriesPerMinute` | no | Query budget for this profile (1-10000); overrides `AUSPEX_MAX_QUERIES_PER_MINUTE` |

An optional top-level `scriptRoots` object names folders for change scripts
(see Report library, Script roots); it is not a profile:

```json
{
  "scriptRoots": {
    "scripts": "/path/to/sql-scripts"
  }
}
```

The root name is only a label you pick (`scripts` here); use any name that
follows the profile-name rules. Each value is an absolute directory path; a relative path, control
characters, a URL or anything that looks like a password stops the server at
startup. Root names follow the profile-name rules. If the folder is under
AppData, check that saved scripts appear there: MSIX-packaged clients may
redirect AppData writes (see Configuration).

An optional top-level `codeRoots` object names source code folders the
agent may read with its own file tools for column meanings (see Code
meanings); it is not a profile and has the same shape and checks as
`scriptRoots`:

```json
{
  "codeRoots": {
    "example_app": "/path/to/example_app"
  }
}
```

Auspex never reads or writes a code root; the name only scopes the
`evidenceCode` references of `remember`, and `list_profiles` lists the roots
as `codeRoots` (`name`, `path`, `source`). Code root names are a separate
namespace from script root names.

An optional top-level `notesLanguage` sets the language of schema-memory
notes and of report titles, descriptions, version notes and change-script texts (save_execute_script title, purpose and comments; step markers such as BEGIN and MATCH stay as written) (a language code such as `tr`, `en`, `de` or `pt-BR`); it is not a
profile and an invalid value stops the server at startup:

```json
{
  "notesLanguage": "en"
}
```

`list_profiles` returns it as `notesLanguage` (`null` when unset). When it is
unset the model asks the user once which language notes, report texts and change-script texts should be saved in and
suggests adding the key. Existing notes are not translated.

An optional top-level `auspexRoot` is the absolute path of your Auspex
checkout; the desktop app runs `src/stageCli.js` from it to approve or revoke
reports (`AUSPEX_ROOT` takes precedence). It is not a profile; a value that is
not an absolute, existing directory holding `src/stageCli.js` stops the server
at startup:

```json
{
  "auspexRoot": "/path/to/auspex"
}
```

Profile names are case-insensitive and use `a-z`, `0-9`, `-`, `_`. Restart
your MCP client session after editing (profiles are read at start). A missing
file means no file profiles; an invalid file stops the server with a message
naming the problem.

## ⚙️ Configuration

<details>
<summary><b>Environment variables</b></summary>

| Variable | Default | Meaning |
|---|---|---|
| `AUSPEX_HOME` | `~/.auspex` | Folder for `profiles.json`, `logs/` and `exports/` |
| `AUSPEX_PROFILES_FILE` | `<home>/profiles.json` | Profiles file location |
| `AUSPEX_DB_<NAME>` | none | Extra profile from the environment, e.g. `AUSPEX_DB_LOCAL`; the same name in the file and env is an error |
| `AUSPEX_SCRIPT_ROOT_<NAME>` | none | Extra script root (absolute folder for `save_execute_script`), e.g. `AUSPEX_SCRIPT_ROOT_SCRIPTS`; the same name in `scriptRoots` and env is an error |
| `AUSPEX_CODE_ROOT_<NAME>` | none | Extra code root (absolute source code folder the agent reads itself; names `remember` `evidenceCode` roots), e.g. `AUSPEX_CODE_ROOT_EXAMPLE_APP`; the same name in `codeRoots` and env is an error |
| `AUSPEX_ROOT` | `auspexRoot` in the profiles file | Auspex checkout the desktop app runs `src/stageCli.js` from (report approve/revoke) |
| `AUSPEX_NODE` | `node` on `PATH` | Absolute path of the Node executable the desktop app uses for approve/revoke |
| `AUSPEX_MAX_ROWS` | 500 | Row cap for `query` |
| `AUSPEX_EXPORT_MAX_ROWS` | 100000 | Row cap for `export_csv` |
| `AUSPEX_EXPORT_MAX_BYTES` | 104857600 | Size cap for one `export_csv` file (100 MB), BOM and header included |
| `AUSPEX_EXPORT_MAX_MS` | 300000 | Total time cap for one `export_csv` (5 min), on top of the per-statement timeout; covers fetching, writing and closing the file (see CSV export budget) |
| `AUSPEX_STATEMENT_TIMEOUT_MS` | 30000 | Default statement timeout per call |
| `AUSPEX_MAX_STATEMENT_TIMEOUT_MS` | 300000 | Ceiling for the per-call `timeoutSeconds` |
| `AUSPEX_MAX_STATEMENT_TIMEOUT_MS_<NAME>` | global ceiling | Ceiling for one profile, e.g. `_EXAMPLE=120000` |
| `AUSPEX_MAX_QUERIES_PER_MINUTE` | 60 | Query budget: database operations per profile in any sliding minute, per process (1-10000). One tool call or library call counts once, however many statements it runs; over the budget a call is refused before connecting and the refusal is audited |
| `AUSPEX_MAX_QUERIES_PER_MINUTE_<NAME>` | file value or global | Query budget for one profile, e.g. `_EXAMPLE=30`; overrides `maxQueriesPerMinute` in the profiles file |
| `AUSPEX_MAX_CELL_CHARS` | 2000 | Long text values are cut in `query` output |
| `AUSPEX_DATA_DIR` | `<home>` | Base for `exports/` and `logs/` |
| `AUSPEX_EXPORT_DIR`, `AUSPEX_LOG_DIR` | under data dir | Override each folder |
| `AUSPEX_VIEWER_PORT` | 4719 | Port of the local viewer |
| `AUSPEX_LIBRARY_DIR` | `<home>/library` | Report library (`SELECT/`, `EXECUTE/`, `_drafts/`) |
| `AUSPEX_MEMORY_DIR` | `<home>/memory` | Schema memory, one folder per profile |

Files are kept out of AppData on purpose: MSIX-packaged desktop apps
(including some AI clients) redirect AppData writes of their child processes
into a hidden per-package folder.

</details>

**Passwords live in pgpass**, which node-postgres reads automatically:
`%APPDATA%\postgresql\pgpass.conf` on Windows, `~/.pgpass` (mode 600)
elsewhere. Line format: `host:port:database:user:password`.

**The profile URL alone decides where Auspex connects.** node-postgres would
fill missing parts from `PGHOST`, `PGPORT`, `PGDATABASE` and `PGUSER` and read
`PGOPTIONS`, `PGREPLICATION`, `PGCLIENT_ENCODING`, `PGBINARY` and `PGPASSWORD`
even for a complete URL; Auspex removes these from its own environment before
it connects and says so once on stderr (names only). `PGPASSFILE` and the
`PGSSL*` settings keep working.

If the server is behind a VPN, calls fail fast (10 s connect timeout) with a
hint to check the VPN.

## 🐘 Recommended database role

The role is named `Auspex` with a capital A, so in SQL it must always be
written in double quotes: `"Auspex"`. Connection strings and pgpass use the
plain name `Auspex`.

```sql
CREATE ROLE "Auspex" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 3;
ALTER ROLE "Auspex" SET default_transaction_read_only = on;
ALTER ROLE "Auspex" SET statement_timeout = '30s';
ALTER ROLE "Auspex" SET idle_in_transaction_session_timeout = '60s';
GRANT CONNECT ON DATABASE <db> TO "Auspex";
GRANT USAGE ON SCHEMA <schema> TO "Auspex";
GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO "Auspex";  -- or a column/view subset for personal data
```

> [!CAUTION]
> If a schema grants `CREATE` to `PUBLIC`, the role inherits it. Writes are
> still blocked by the read-only transaction, but check `PUBLIC` grants,
> `EXECUTE` on `SECURITY DEFINER` functions that write, and `pg_hba.conf`
> rules for the role. Prefer a read replica for heavy analysis.

The scripts in [`scripts/`](../scripts) do all of this with a
`BEGIN → DEFINE → PROCESS → MATCH → CORRECT/FAIL → ROLLBACK` step structure, so you can
review every result before committing.
