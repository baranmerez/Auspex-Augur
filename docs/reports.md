<p><a href="../README.md">← Back to README</a></p>

# Reports and schedules

The report library (drafts, approval, presets, HTML) and scheduled runs.

## 📚 Report library

When an analysis query is worth keeping, the agent saves it as a report.
Reports are grouped by database (profile), schema and category, and live in a
user-specific folder outside any repository (`~/.auspex/library`, override
with `AUSPEX_LIBRARY_DIR`):

```
library/
├── _drafts/<db>/<schema>/<category>/<name>.sql|.report.json|.html   work in progress
├── SELECT/<db>/<schema>/<category>/<name>.sql|.report.json|.html    approved reports
└── EXECUTE/<db>/<schema>/<category>/<name>.sql|.execute.json        change scripts for a human (.execute.json: file in a script root)
```

A category is one folder or a topic path of up to three levels joined by
`/`, for example `Orders` or `Orders/Delivery`; each level is a real folder
(`SELECT/<db>/<schema>/Orders/Delivery/<name>.sql`). Every level follows the
same rules (no `..`, no empty level, no leading or trailing spaces, no
Windows device names such as `CON` or `NUL`, Unicode
letters allowed). Existing single-level categories keep working; nothing is
moved.

- **The agent only writes SQL.** `run_report` executes it read-only in one
  snapshot (`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON)` plus a
  cursor preview), summarizes the plan, masks personal columns, appends the run
  to the history and fills one fixed HTML template. Rendering costs no tokens.
  It runs only the report's saved active revision (for an approved report the
  approved one): a `.sql` file edited outside `save_report` is refused before
  any database call; save it with `save_report` (and approve it again).
- **The HTML is self-contained** (data embedded, no external files): stat tiles,
  plan warnings, a plan tree with time share and misestimates, joins read from
  the plan (with the column pairs they use), tables touched, the masked preview,
  run history with a duration chart, and a diff between SQL versions.
- **Parameter presets:** a report saved with `dateRange: true` (its SQL
  takes exactly two parameters, `$1` start inclusive and `$2` end exclusive)
  can run with a built-in relative date range: `today`, `yesterday`,
  `last_7_days` (the last seven days including today), `this_month`,
  `last_month`, `this_year`, `last_year`. Built-in presets are opt-in:
  reports saved without the flag (including every report saved before it
  existed) offer none until they are saved again with `dateRange: true`.
  The presets resolve when the report runs to ISO dates; day boundaries are
  computed in the local time zone of the machine Auspex runs on, while a
  comparison with a `timestamptz` column reads the date in the database
  session time zone, so compare with `$1::date` / `$2::date` or a date
  column. Any report can also keep named parameter sets
  (`save_report` `presets`, e.g. `{ "name": "April 2023 trial", "params":
  ["2023-04-01", "2023-05-01"] }`; names 1–60 characters, unique, one value
  per SQL parameter; passing `presets` replaces the list). `run_report`
  takes `preset` (a built-in key or a custom name) instead of `params`; the
  run history and the audit log record the preset and the resolved values,
  and `list_reports` shows the presets, the preset of the last run and the
  custom presets that no longer fit the SQL (`mismatched`; refused by
  `run_report` and shown struck through in the viewer). A shared copy never
  contains presets.
- **Develop a query like a car:** every saved SQL change becomes a new version,
  every run is kept (last 100), so you can see what each change did to time,
  cost and plan.
- **Heavy reports:** with `analyze: "auto"` the plan is still read but
  `EXPLAIN ANALYZE` is skipped when the previous run took more than 30 s, so a
  slow query is not executed twice without asking.
- **Approval:** drafts move to `SELECT/` only through `approve_report`, which
  the server instructions restrict to an explicit user approval, or through
  the user's own click in the viewer (see *Approving reports in the viewer*). Approval also
  requires a successful run of the current SQL (`run_report`); an older
  revision's run does not count, and a draft file changed outside Auspex
  must be saved with `save_report` first. An approval is bound to the version
  that was reviewed: the viewer and desktop app always send the SQL hash of
  the report content the person opened, and
  `approve_report` accepts it as the optional `expectedHash` (`save_report`
  and `run_report` return it as `sqlHash`). If the draft SQL changed since
  then, the request is refused with `STALE_VERSION` and nothing moves.
- **Change scripts:** `save_execute_script` only writes files. A script must
  start with `BEGIN`, end with `ROLLBACK`, contain no `COMMIT` and have `WHERE`
  on every `UPDATE`/`DELETE`; whoever runs it with a privileged role swaps the
  final `ROLLBACK` for `COMMIT` after checking the results. The check fails
  closed: no other transaction statement (`END`, `ABORT`, an early `ROLLBACK`,
  a second `BEGIN`, `PREPARE TRANSACTION`) is allowed in between, only
  `SAVEPOINT` / `RELEASE` / `ROLLBACK TO`; `DO` blocks, `CALL`, `CREATE
  PROCEDURE`, `MERGE` and psql backslash commands are rejected because their
  bodies or branches cannot be checked; and each `UPDATE`/`DELETE`, also
  inside a CTE, needs its own `WHERE` (one inside a subquery does not count).
  It is a structural check, not a proof that the script is right: a `WHERE`
  that matches everything (`WHERE true`) passes, and no script is rehearsed
  against a database (Auspex's role cannot write). A human still reviews
  every script. Inside the transaction, `DEFINE → PROCESS → MATCH → CORRECT
  or FAIL` comments are the recommended step structure (scope, change,
  verification, assertions); they are highlighted but not enforced.
- **Functions and triggers in change scripts:** `CREATE [OR REPLACE]
  FUNCTION` is allowed with `LANGUAGE plpgsql` or `LANGUAGE sql` (unquoted)
  and exactly one dollar-quoted body (`AS $tag$ ... $tag$`, any tag);
  `CREATE [OR REPLACE] [CONSTRAINT] TRIGGER` is allowed too, so a table
  script and its trigger functions can be one script. The body is masked
  like a string literal: creating a function does not run it, so its
  statements are **not linted** (an `UPDATE` without `WHERE` inside a body
  passes, the same statement outside is rejected). The saved file then
  carries the header line `-- NOTE: function bodies are not linted by
  Auspex; review them before COMMIT`. Other languages, quoted language
  names, single-quoted or SQL-standard (`RETURN` / `BEGIN ATOMIC`) bodies
  are rejected. Warnings: `SECURITY DEFINER`; a later statement that calls
  a function created in the same script (quoted names included), since its
  body runs there; and every `INSERT`/`UPDATE`/`DELETE` after a `CREATE
  TRIGGER` or a function `RETURNS trigger`, since trigger bodies run during
  the dry run.
- **Script roots:** to keep change scripts where you run them (for example
  a folder of saved SQL scripts in your SQL client), name the folder in
  `scriptRoots` in the profiles file or as `AUSPEX_SCRIPT_ROOT_<NAME>` (see
  Profiles file). `save_execute_script` with `root` (the name), `folder`
  (one or two levels joined by `/`, for example `example` or
  `example/reports`, created if missing) and `fileName` (ending
  in `.sql`) writes the script to `<root>/<folder>/<fileName>` and keeps the
  `EXECUTE/` copy as the library record (`list_reports` shows its
  `externalFile`; the header names the file). Auspex assumes no folder layout
  or naming convention; the limit of two levels is a safety limit, not a
  layout. Each folder level and the
  file name is one name of letters (any Unicode letter), digits, `_`, `-` and
  `.`, at most 80 characters, without `..`, a leading or trailing dot or a
  Windows device name; empty levels, absolute or drive paths and a third
  level are refused. The root must exist; Auspex never creates it. A file
  that already exists is never overwritten (when the folder's files start
  with a number such as `03_`, the error proposes the next free one;
  otherwise it asks for a new file name), and a folder level that resolves outside its parent
  through a link or junction is refused. `replace` only applies to the
  library copy. The lint runs before anything is written. This only writes
  files; no database is touched.
- **Report queries in a script root:** `save_report` takes the same `root`,
  `folder` and `fileName` and writes the read-only query (checked by the SQL
  guard, one statement) as a new `.sql` file with a comment header, for
  running in your SQL client; the draft lists it under
  `externalFiles`. The change-script lint is not involved. A read-only
  check file with several SELECTs (for example a post-commit check) goes
  through `save_execute_script` wrapped in `BEGIN; ... ROLLBACK;`, which the
  lint already accepts.
- **Several Auspex processes:** two MCP clients or a script can share one
  library and memory folder. Every change runs under a lock file
  (`<library>/.lock`, `<memory>/<profile>/.lock`), so concurrent writers do
  not lose each other's updates and SQL, metadata and HTML stay in step. A
  second writer waits up to 5 s, then gets a "try again" error. A lock whose
  owner process is still alive on this machine is not taken over while it is
  younger than 10 minutes (debugger, sleep); a lock left by a crashed process
  is taken over automatically. Only when the owner cannot be checked
  (unreadable lock file, another host) does a lock older than 30 s expire.
  Past 10 minutes (`maxHoldMs` of `withFileLock`) any lock or leftover
  takeover marker is reclaimed even when its pid looks alive, because the OS
  may have reused the pid of an owner that died holding it; every guarded
  section is short file work, far below that ceiling. Locks are same-host
  only: sharing one library or memory folder between machines over a network
  filesystem is not supported. A crash in the middle of an approval can leave
  it half done.

- **Private report, shared copy:** a report's own HTML is a private working
  file: it embeds the raw SQL, parameters, query plan (with its filter
  expressions) and run history, and says so at the top. To send a report to
  someone, `share_report` writes a separate copy into `exports/` built from an
  allowlist: title, description, category, the masked preview, the
  timing/row figures and the result's SQL version number and run time. It is
  refused when the last results come from a SQL version other than the
  current one (saved but not run yet); run the current version first. The
  report's current `mask`/`unmask` is applied to the stored preview once more,
  so a column masked after the last run is masked in the share; a value the
  run already masked stays masked even if the column was unmasked later. SQL,
  plan, parameters, warnings, history and database, schema and server names are left out, not redacted. The title and
  description are kept as written, so keep secrets out of them.

> [!NOTE]
> Masking is a name-based safety net. The built-in name lists cover English
> and Turkish column names (including Turkish compounds without separators);
> add other names, and free-text or JSON columns that can contain personal
> data, to a report's `mask` list. A shared copy is no
> anonymization: its preview rows are exactly what the masking left, so check
> them before sending.

## ⏰ Scheduled runs

An approved report can run on a schedule, for example every Monday at 08:00
for the last seven days. Auspex itself never registers or changes a
scheduled task: you edit the schedule file and register one daily task
yourself with the command Auspex prints.

**Schedule file:** `<AUSPEX_HOME or ~/.auspex>/schedules.json`, edited by you:

```json
{
  "schedules": [
    {
      "id": "weekly-example",
      "profile": "exampledb",
      "report": { "db": "exampledb", "schema": "example", "category": "Orders/Delivery", "name": "example-report" },
      "preset": "last_7_days",
      "cadence": { "weekly": "monday", "at": "08:00" }
    },
    {
      "id": "daily-example",
      "profile": "exampledb",
      "report": { "db": "exampledb", "schema": "example", "category": "Orders", "name": "example-daily" },
      "preset": "yesterday",
      "cadence": { "daily": true, "at": "07:30" }
    }
  ]
}
```

- `id`: 1-60 characters `a-z`, `0-9`, `-`, `_`; unique.
- `profile`: required, there is no default; it must be the report's `db`.
- `report`: the location exactly as `list_reports` shows it. Only
  **approved** reports run; a draft (or a report that is not found) is
  recorded as `failed` without a database call. A newer draft of an approved
  report does not change what runs: the scheduler always runs the approved
  SQL.
- `preset`: a built-in date preset (`today`, `yesterday`, `last_7_days`,
  `this_month`, `last_month`, `this_year`, `last_year`; only for reports saved
  with `dateRange: true`) or one of the report's custom presets. Leave it out
  only for SQL without parameters.
- `cadence`: `{ "weekly": "<weekday in English>", "at": "HH:MM" }` or
  `{ "daily": true, "at": "HH:MM" }`, local time of the machine.
- Optional: `"enabled": false` on a schedule; top-level `"taskTime": "HH:MM"`
  (time of the daily task, default the latest `at` of the enabled schedules)
  and `"notify": "all" | "failures" | "none"` (default `all`).

Validation is strict: an unknown key, a missing profile or a malformed
cadence rejects the whole file, so a typo never silently drops a schedule.

**Commands** (`node src/scheduleCli.js ...`, no shell, prints JSON):

| Command | What it does |
|---|---|
| `run-due` | Runs every enabled schedule whose most recent due slot has passed and has no successful run yet (catch-up: a PC that was off on Monday runs Monday's slot on Tuesday). |
| `run --id <id>` | Runs one schedule now (manual). Adds no trend point and leaves the due slot open. |
| `status` | Lists the schedules with problems (not approved, preset not usable), last result and next slot, and warns about an enabled schedule due later than the task time (the daily task would run it only the next day). No database access. |
| `task-command` | Prints the PowerShell commands that register the daily task. It does not run them. |

Each command takes `--home <absolute folder>` to use that folder as
`AUSPEX_HOME`.

Exit codes: `0` every run succeeded or nothing was due, `1` at least one run
was skipped or failed, `2` usage or schedule-file error, `3` another scheduler
run is in progress. One scheduler runs at a time, under the same lock rules
as the library (`<home>/scheduler.lock`; a lock left by a dead process is
taken over). A lock held longer than the task's 2 h limit is reported with a
notification, and one older than 3 h is taken over even when its process id
looks alive (a process id reused after a reboot).

**Period of a catch-up run:** the preset is resolved against the date of the
due slot, not the time the run happens. A catch-up on Tuesday for Monday's
08:00 slot gets the same `last_7_days` as a run on Monday would have.
Slots are local wall-clock times computed with calendar arithmetic, so a
daylight saving change does not move a slot to another day or hour.

**Same path as `run_report`:** every scheduled run goes through the report
service and `ReadOnlyDatabase` (SQL guard, `READ ONLY` transaction, role
check, query budget, statement timeout), appends to the report's run history
and regenerates its HTML. Its audit entries carry source and actor
`scheduler`, plus one `schedule_run` entry per schedule with its status.

**Unreachable database and retries:** when the database cannot be reached
(connection refused or timed out, DNS failure, for example a VPN that is
down) the slot is recorded as `skipped-unreachable`; other errors as `failed`
with their error code. Both send a notification and end with exit code 1.
The task retries 30 minutes later, and the next daily `run-due` catches up a
slot that is still open.

**Registering the task (Windows):**

```bash
node src/scheduleCli.js task-command
```

prints commands like these (paths and time from your setup); review them and
run them yourself in PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' -Argument '"C:\example\auspex\src\scheduleCli.js" run-due --home "C:\example\auspex-home"' -WorkingDirectory 'C:\example\auspex'
$triggers = @((New-ScheduledTaskTrigger -Daily -At '08:00'), (New-ScheduledTaskTrigger -Daily -At '08:30'))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 30) -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Auspex scheduled reports' -Description 'Runs due Auspex report schedules (read-only).' -Action $action -Trigger $triggers -Settings $settings
```

The task restarts once after 30 minutes when it fails. Task Scheduler applies
that setting when the task cannot start, not on a non-zero exit code, so the
command adds a second daily trigger 30 minutes later: `run-due` is a no-op
for slots that already succeeded and retries the ones that were skipped or
failed. `-StartWhenAvailable` runs a missed task after the PC wakes up. The
task runs as the current user and only while that user is signed in, which
the notifications need. On other systems, use your own scheduler (for
example cron) to run `run-due` once a day.

**Re-register after changing times.** The task time is fixed when you
register it: `taskTime`, or by default the latest `at` of the enabled
schedules. After adding a schedule or changing a time, run `task-command`
again and register the task again (`status` warns about a schedule due later
than `taskTime`).

**Environment of the task:** a scheduled task does not inherit settings made
only in your MCP client's configuration or in your shell. When `AUSPEX_HOME`
is set, the printed action passes it as `--home`. Every profile a schedule
uses must be readable by the task: put it into `profiles.json` (passwords
stay in pgpass), or set its `AUSPEX_DB_<NAME>` variable as a user environment
variable. `task-command` names, never prints, the `AUSPEX_DB_*` and other
`AUSPEX_*` variables of the current shell that the task will not see.

**Notifications:** on Windows a toast with the report title and the status
(`ok`, skipped because the database was unreachable, or failed with its error
code). Never data values, SQL, parameters or error messages. The text is
passed to PowerShell through environment variables and inserted as XML text
nodes, never as script. Elsewhere, or when the toast fails, one line on
stderr. A notification never fails a run.

**Trend history:** after each successful scheduled run Auspex appends one
point to `<home>/trends/<profile>/<schema>/<category>/<name>.jsonl`: slot,
run time, preset, resolved parameters, SQL version, the row count (exact
from `EXPLAIN ANALYZE` or a complete preview, otherwise `estimatedRows`) and
the column totals the report page shows under its preview (identifier, code
and masked columns excluded; kept only when the preview holds every row).
Integer and numeric columns are summed exactly; a total with more than 15
significant digits is stored as decimal text so no digit is lost (floating-point
columns keep a sum rounded to 15 digits).
Aggregates only, never row values. The newest 520 points are kept. There are
no threshold alerts yet; the point format (one number per series, totals
keyed by column) is ready for them.

**State:** the last result per schedule is in
`<home>/schedule-state.json` (status, slot, time, error code; no messages),
which the viewer reads. The full error message is in the command output and
the audit log.
