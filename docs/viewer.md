<p><a href="../README.md">← Back to README</a></p>

# Viewer and desktop app

The local web viewer and the Tauri desktop app.

## 📊 Viewer and desktop app

```bash
npm run viewer
```

Opens a local page at http://127.0.0.1:4719 (port: `AUSPEX_VIEWER_PORT`):

- **Overview** — stat tiles, activity over time, usage by profile, tool and table, slowest operations, recent errors
- **Operations** — sortable, paged log with full SQL, parameters and errors (the status shows the error code, the detail the correlation ID); copy and CSV/JSON download. The *All* date range covers at most the last 398 days of logs; pick a custom range for older days
- **Tables** — which tables were accessed, how often and by which profile; a schema-qualified name opens its table page when the database is known
- **Reports** — the report library as a collapsible tree: topic → subtopic → report (database and schema come from the database picker and the report header; the list collapses to a rail; a filter box narrows it by name, category or stage and opens the matching branches; change scripts have their own tab and are not part of *All*), with each report's HTML: the title with its stage badge and the approve/revoke button in the viewer header (the report's own title, location chips and language/theme controls are hidden there and stay in the saved file and *Open in new tab*), the question it answers at the top (first sentence, *More* for the rest, parameters on their own line, last run time and parameters beside *Last run*), execution time, rows and the plan-warnings badge in one strip with the cost, buffer, temp and join figures behind a *Performance details* toggle (remembered), and sticky tabs that open on *Preview*. The preview table has readable headers (raw name in the tooltip), click-to-sort, a quick filter, a preview-only totals row for numeric columns and a spreadsheet-safe CSV export of the rows shown (Turkish exports use a decimal comma; identifier and code columns such as `order_id` or `status_code` are skipped in the totals row; the download needs a click in the report and is saved with a sanitized `.csv` file name and a UTF-8 BOM); masked columns stay masked. The header also shows the last run's preset with its parameter values and lists the presets the report offers (read-only: running stays an agent action, the viewer never runs SQL), a star to pin the report, and *Ask Claude*, which copies a ready prompt in the viewer language (report location, title, last run time, preset and parameters, row count and the first column names, never preview values) to the clipboard. Above the tree, *Favorites* lists the pinned reports and *Recent* the last 8 opened; both are local to this viewer or desktop app (browser storage, nothing is written to the library) and drop reports that no longer exist. SQL and change scripts are syntax-highlighted (step markers stand out, long lines soft-wrap), copy buttons inside a report work from the viewer, and drafts and approved reports can be approved or revoked (see below)
- **Schema** — the schema memory of a database in three views, an inspector with notes, relations and history, and a timeline of schema changes. A schema picker moves the selection and the view center into the chosen schema. A badge in the header counts schema changes you have not seen yet. Around a selected table, foreign keys give two roles: **Reference** (TR *Instance*: tables it points to, such as status codes) and **Dependent** (TR *Beslenen*: tables that point to it, such as order lines). Each role is ranked by linked rows, then by the table's row estimate; both are planner estimates, and a relation without a linked-row figure falls back to the row estimate.
  - *Graph* — a 3D graph (with a 2D fallback): click a table to focus it, and the focused table's Reference and Dependent tables are laid out in directed layers with always-visible labels; *+1 depth* adds the next ring and *Show all* shows everything. The focused table's FK edges are blue (Reference) or orange (Dependent), darkest at rank 1 and lightest at rank 10; edges beyond the top 10 are grey and dashed and can be hidden
  - *ER diagram* — Reference tables on the left, Dependent tables on the right, with a per-side top-N picker (5, 10, 25, 50 or All), every card with its rank, linked rows and explored state; the rest stay in the inspector's Relations list
  - *Flow* — Reference → Center → Dependent swimlanes around a center card, edge width by linked rows (log scale) and edges labelled with their join columns; the same top-N picker per side; a Dependent opens its own dependents as a further labelled lane (depth 2), clicking a table makes it the center and the trail leads back
  - *Data dictionary* (TR *Veri sözlüğü*) — downloads a self-contained HTML or Markdown document of the database built from the schema memory only (no database access): the explored tables with their comment, key columns (primary key, foreign key, used, noted), relations (Reference/instance and Dependent), active rules and observations (observations with their aggregate figures), and the database-wide rules and observations, with the generation date. Unconfirmed inferences, archived notes and evidence SQL are left out; every name and text is escaped. The file is saved as `auspex-data-dictionary-<db>-<date>.html` or `.md` after a click (when loading the table files took too long, the next click downloads)
- **Table page** (TR *Tablo sayfası*) — opened from a table name in the Tables tab, the Schema inspector (*Open table page*) or the Schema search (matching tables are listed under the bar); shown in the Schema tab with a breadcrumb (Back, Schema, each visited table). From `graph.json` and the table file only:
  - header: `schema.table`, estimated rows, column count, note count, comment, last scored date, sources (most reports and scripts found for one column) and a badge when the last describe recorded changes
  - columns sorted by effective score, then name: a 5-step single-hue score chip (the accent mixed into the surface, so it follows light, dark and custom themes), name and type, roles as icons with tooltips, the agent's one-line reason and its number of reports; "user 5 · agent 2" when both layers exist. By default only scores 4–5 are listed, with a counter and *Show all columns*; the legend explains the rubric (5 core, 4 frequent, 3 topical, 2 rare, 1 unused). A row expands to the score history of both layers (newest 5 each), the column's notes (a note read from code with a *from code* badge and its `root:path:line · symbol` references), its FK target, default and comment
  - column tools above the column list, in Detailed and Summary: a **search box** (TR *Kolonlarda ara*; `/` focuses it while a table page is open, Esc clears it) matching the column name, its meaning, the agent's reason and any note text, Turkish-aware like the Rules tab, with an *N / total* counter and a clear button; while a query is active all columns are searched and the 4–5 filter is ignored. A **group switch** *Score / Type* (TR *Puan / Tür*, remembered): Type groups come only from catalog facts, so they work for any database: keys and links (primary key, foreign key or a column in a unique constraint), date and time, amounts and numbers, text, flags (boolean) and other (json, uuid, bytea, arrays), each with a count and ordered by score, sources, name. In Detailed, a column with a confirmed rule or observation shows its meaning as one muted line (two lines at most, full text in the tooltip); a note with code evidence is preferred, then the newest rule; unconfirmed inferences stay in the expanded row
  - keys and structure (primary key, unique and check constraints with definitions, outgoing and incoming foreign keys, indexes), triggers (timing and events, level, enabled, function, WHEN, the agent summary; a stale summary is marked *may be out of date*), and neighbours: tables it references on the left, tables that reference it on the right (linking columns, estimated rows; not explored ones muted), each opening its own page
  - an undescribed table explains that `describe_table` is needed; an unscored table points to the `auspex-columns` skill. Clicking a score chip sets your own score (see below)
  - *Detailed / Summary* switch (TR *Ayrıntılı / Özet*). A first visit opens **Summary**: names only, as coloured, clickable chips in groups: primary key, foreign keys (`column → table`, best column score first; the first 12, the rest behind *+N more*, TR *+N daha*; the same for referenced and referencing tables), columns by effective score (coloured by score and grouped under a heading with a count, such as *5 · core (3)*; the five score steps are clearly apart in light and dark; score 1 columns collapse into a *+N unused* chip that expands; unscored columns are dashed), triggers (a disabled one is muted and struck through), trigger functions, reports whose SQL mentions the table (*Mentioned in SQL*, TR *SQL'inde geçiyor*), referenced tables (*Bağlı olduğu*) and referencing tables (*Ona bağlı olan*). A column chip opens its row in the Detailed view, a table chip opens that table's page, a report chip opens the report on the Reports tab. The last choice is remembered in browser storage (the page works without storage). The report match is a simple, case-insensitive name match over the SQL of the database's draft and approved reports (read once each through the existing `GET /api/report`, four at a time, again when the report changes); schema-qualified and bare names match, a longer name that shares a prefix (`example.orders` vs `example.orders_archive`) does not, and neither does the name after another schema (`test.orders`). The first 400 reports are checked (the page says *first 400 reports checked* when there are more); a report that cannot be read is counted as *could not be read* with *Retry*, not remembered as empty. It is a hint, not a hard link
- **Rules** (TR *Kurallar*) — every schema-memory note of the chosen database, laid out as a navigator: a *Database-wide* box on its own, then one box per table (schema, table name and its counts); click a box to see its notes beside the boxes (below them on a narrow screen), so no scrolling through every table. Each note shows rules, observations and inferences with table and column, text, status, confirmed or unconfirmed, created/confirmed/archived dates, and the evidence (figures, SQL and code references) behind a collapsed *Evidence* toggle; a note with code references carries a *from code* badge (TR *koddan*) under its kind. Filters: status (active by default, archived, all), kind, table (part of `schema.table`) and text (case-insensitive, Turkish İ/I/ı/i match each other). An active note can be archived with a required reason (see below); adding or confirming notes stays an agent action (`remember`). The table header and the column sub-header of each group are links: a table opens its table page, a column opens its row in the Detailed view.
- **Profiles** — configured databases with connection details (never passwords) and the latest role check; a `check_profile` that failed shows "unable to assess" with its code, never as a passed check

Scheduled reports (see Scheduled runs): an approved report with a schedule
carries a badge in the Reports list with its last scheduled result
(*scheduled: ok*, *unreachable* or *failed*; the worst one when it has several
schedules). Its header lists each schedule (cadence, preset, last result with
its error code, next slot), and above the report a small trend chart shows the
row count and up to four column totals per scheduled run (one line each with
its own scale; hover a point for its slot and value). The viewer reads
`schedules.json`, `schedule-state.json` and the trend files through GET routes
only (`/api/reports` and `/api/reports/trend`, which leaves out parameter
values); a broken schedule file is shown above the list. The desktop app does
not show schedules or trends yet.

The viewer uses the full window width with one page scroll, has an English
and Turkish interface, and offers ready themes plus a theme studio that checks
contrast (see Themes below); custom themes are saved in the browser and can be
exported and imported as JSON. The generator has a *Summary palette* (TR *Özet paleti*)
section: one colour for each chip group of the table page Summary (primary
key, foreign keys, columns by score, triggers, trigger functions, reports,
referenced, referencing, disabled; the score colour gives the five-step ramp).
Each chip's text colour is derived and checked with the same contrast check as
the other text colours. The palette is saved with a custom theme and included in
its JSON export and import; groups left unset use the defaults, so every ready
theme has a full palette. The chips use only the CSS variables `--sum-<group>`,
`--sum-<group>-line` and `--sum-<group>-ink`.

Ready themes also include *Glass* and *Glass dark* (TR *Cam*, *Cam koyu*):
translucent panels with a backdrop blur over a soft multi-colour background,
thin light borders and an inner highlight. The blur sits on panel containers
only, not on rows of long lists. Text is checked with the same contrast check
against the panel at its opacity over every backdrop colour. When the browser
has no `backdrop-filter` or you prefer reduced transparency
(`prefers-reduced-transparency`), the panels stay opaque and the page
background flat (class `glass-flat` on `<html>`). *Plain* (TR *Sade*) is the
flat, uncoloured look of the default kept as an explicit choice (no tints, no
accent borders, no glass; it still follows the system light or dark); the
default palette is unchanged. On the table page the left *references* and right
*referenced by* panels have their own tinted surface and accent (from
`--role-ref-*` and `--role-dep-*`) in every theme except Plain, the centre stays neutral,
and column and table names are set heavier than types and meta text. The
generator can switch *Glass look* on, tune blur (0-40 px) and opacity
(20-95 %) and pick the two panel tints; they are saved with a custom theme and
included in its JSON export and import (numbers clamped, colours hex only).

Themes. The viewer and the desktop app start in the *Auspex* theme (dark) when
nothing is saved; a saved choice (Auto, Light, Dark, Plain or any theme) is
kept. The theme menu lists five *Auspex themes* (TR *Auspex temaları*):
*Auspex*, *Forge*, *Phosphor* (monospace headings), *Verdigris* and *Ivory*
(light), then the ready themes, then *My themes*. Every text and background
pair of every ready theme passes the contrast check (4.5:1 for text, 3:1 for
large text and interface parts).

The *theme studio* (TR *tema stüdyosu*) is a modal dialog, opened with *New
theme*, with the duplicate button next to any ready theme or saved theme
(*Duplicate and edit*) or with the edit button of a saved theme. A duplicate
carries every colour of its source. You can edit every token, each with a
colour input and a hex field (`#rgb` or `#rrggbb`): surfaces (background,
surface, raised), text (primary, secondary, muted), border, accent (accent,
accent text, text on accent, secondary accent), status (success, warning,
danger, info), the two side-panel tints, the score ramp base, the Summary
palette and the glass look (strength, blur, opacity). A reset button next to a
token returns it to the value derived from the background and accent. The whole
page previews the draft while you edit; the dialog itself keeps the look of the
theme that was active, so it stays readable. *Revert* restores the starting
values, closing without saving restores the active theme (an in-app dialog
asks before edits are discarded). The contrast panel lists each important pair
with its ratio and an AAA, AA, AA large or Fail badge; *Auto-fix* moves failing
text colours in lightness only until they pass. A theme can have a light and a
dark variant; the Auto, Light and Dark switch then picks the variant. *Save*
stores every field (colours, tints, palette, glass, variants, options) in the
browser (`auspex.viewer.themes`) and makes the theme active; a name is unique;
*Delete* asks first. *Export* writes JSON with every field and a version
number (`auspexThemes: 2`); *Import* accepts versions 1 and 2, keeps hex
colours only, clamps numbers, ignores unknown keys, takes at most 50 themes and
200,000 characters per import (100 saved themes in all) and rejects anything
else with a message. The viewer never uses `window.prompt`, `confirm` or
`alert` (the desktop webview blocks them).

The role colors and lane backgrounds are CSS variables at the top of
`src/viewer.html` (`--role-ref-1`, `--role-ref-10`, `--role-dep-1`,
`--role-dep-10`, `--role-other`, `--lane-ref`, `--lane-center`, `--lane-dep`),
each written once as `light-dark(light theme, dark theme)`. Reports rendered
before template v2 keep their old layout until `render_reports` re-renders them.

It binds to 127.0.0.1 only, rejects other Host headers, never connects to a
database and never shows passwords. Every route is GET-only except the two
approval routes, the note archive route and the user column score route below.
Every `/api` route, reads included, needs the `X-Auspex-Token` header with the
per-process token the served page carries (401 `TOKEN_INVALID` otherwise); the
page itself and the vendored scripts need no token.

> [!WARNING]
> The token is still served by `GET /` to any local client that reaches the
> loopback port, so it keeps other web pages out but not other local OS
> accounts. On a machine shared with local accounts you do not trust, do not
> run the browser viewer, or run it only briefly and stop it afterwards. The
> desktop app (Tauri IPC, no HTTP port) is not affected. See
> [Safety: local viewer and other OS accounts](safety.md#local-viewer-and-other-os-accounts).

#### Approving reports in the viewer

On the *Reports* tab a draft has an **Approve** (TR *Onayla*) button and an
approved report a **Revoke approval** (TR *Onayı geri al*) button. Each opens a
confirm dialog with the report name, SQL version, last run, rows and warnings.
Approval moves the draft into `SELECT/` exactly like `approve_report` (it still
needs a successful run of the current SQL); revoking moves it back into
`_drafts/`, keeps its SQL versions and runs, and is refused while another
draft of the same report exists. Both regenerate the report HTML and record
the change in the report's `stageHistory`. Only local Auspex files change
(report library and schema memory view); no database is touched.

The two routes (`POST /api/reports/approve`, `POST /api/reports/revoke`) accept
a request only when all of these hold:

- the Host header is the viewer's own loopback address;
- the `Origin` header is exactly the viewer's own origin (missing or foreign: 403);
- the `X-Auspex-Token` header matches a random token created per viewer
  process and embedded only in the served page (403 otherwise);
- the body is `application/json`, at most 4 KB, and holds only `db`,
  `schema`, `category` and `name` exactly as the library lists them (a
  nested category as its `/`-joined path; no path tricks: 400), plus the required `expectedHash`: the SQL hash of the
  report content the page opened (12 lower-case hex characters; 400
  otherwise). `/api/report` returns it as `sqlHash` with the content it
  served, taken from that HTML itself, so a live list refresh cannot change
  it. A report saved by an older Auspex has none until it is run with
  `run_report` or the library is re-rendered with `render_reports` (both add
  the hash when the SQL file is a saved version; a file edited by hand is
  saved with `save_report` first);
- the report exists (404) and is in the right stage (409);
- the report still stands for that version: the current draft SQL (approve)
  or the approved SQL (revoke) has `expectedHash`. Otherwise the answer is
  409 with code `STALE_VERSION` ("The report changed since you opened it (now
  version N); reload and review again."), nothing moves, and the page
  reloads the list and the report.

When the list (live refresh) already stands for another version than the
opened report, the page shows "This report changed since you opened it;
reload it to review the new version." with a *Reload* button and disables
Approve / Revoke until the report is reloaded.

A malformed request target (anything but a path starting with a single `/`,
including `/\host` forms that URL parsing reads as an authority) is answered
with 400; no request can stop the viewer.

There are no CORS headers, and the page cannot be framed by another site
(`X-Frame-Options: DENY`). Every request that passed the origin and token
checks is written to the audit log with `source` and `actor` `viewer`, the
report, the from/to stage and the version, or the error. The Origin and token
checks stop other web pages, but any local process on this machine could still
call these routes, so the audit actor `viewer` is not proof of a human click.
Approve and revoke also rebuild the schema memory view, since approved
reports' joins are its "used" relations. The desktop app offers the same
buttons (see below).

#### Archiving notes in the viewer

On the *Rules* tab an active note has an **Archive** (TR *Arşivle*) button. It
opens a confirm dialog with the note and a required reason (one line, at most
200 characters). Archiving runs the same store logic as `remember
action=archive`, under the profile's memory lock, keeps the note with its
reason, `archivedAt` and `status: archived` (notes are never deleted) and
rebuilds the schema memory view. Restoring an archived note is not offered.

`POST /api/memory/archive` has the same protections as the approval routes
(loopback Host, exact `Origin`, per-process `X-Auspex-Token`, `application/json`
of at most 4 KB) and accepts only `{ "profile", "id", "reason" }`: the profile
name, a positive integer note id and the reason (400 otherwise). An unknown
profile or note is answered with 404, a note that is already archived with
409 (`PRECONDITION_FAILED`). Every request that passed the origin and token
checks is audited like the `remember` tool (`tool` `remember`, `action`
`archive`, `source` and `actor` `viewer`, profile and note id, never the note
text or the reason).

#### Scoring columns in the viewer

On the table page, clicking a column's score chip opens a small dialog: choose
a score from 1 to 5, optional roles, then *Save*; *Remove my score* (TR
*Puanımı kaldır*) appears when you already gave one. Only the **user layer**
changes, through the same store logic as `score_columns` with `by: "user"`
(under the profile's memory lock, atomic writes, view rebuilt); the agent
score, its reason and history stay. A usage note ("mostly in WHERE") is not
taken here: tell your agent in chat and it is saved as a rule on the column.

`POST /api/memory/column-score` has the same protections as the archive
route (loopback Host, exact `Origin`, per-process `X-Auspex-Token`,
`application/json` of at most 4 KB) and accepts exactly
`{ "profile", "schema", "table", "column", "score" | "clear": true, "roles"? }`:
a profile name, names of 1 to 63 bytes without control characters, a score
from 1 to 5 or `clear: true` (not both), and roles only with a score (any of
`key`, `join`, `filter`, `display`, `aggregate`, `sort/group`, each once).
Anything else, including unknown keys, is 400. An unknown profile, table or
column is 404; a table that is only seen in a plan (not described), or a
`clear` without a user score, is 409 (`PRECONDITION_FAILED`). Every request
that passed the origin and token checks is audited as `score_columns` with
`layer` `user`, `action` `set` or `clear`, `source` and `actor` `viewer`,
profile, schema, table, column, score and role names; there is no free text.

### 🖥️ Desktop app (Tauri)

`desktop/` wraps the same viewer in a small native app (about 3 MB) that reads
`~/.auspex` directly through a Rust command, so no Node server is needed
(approve/revoke, archiving notes, user column scores and the schedules and
trend of approved reports need Node 20+ and the Auspex checkout, see below;
schedules and trends come from the same Node code as in the browser viewer and
are only read when a schedules file exists).
Closing the window keeps it in the tray; the tray menu has *Open*, *Show log
folder*, *Start with Windows* (starts hidden in the tray) and *Quit*.

```bash
cd desktop && npm install && npm run build
```

Needs Rust (MSVC toolchain on Windows), the platform C++ build tools and
WebView2. Output: `desktop/src-tauri/target/release/auspex-augur.exe`.

> [!NOTE]
> Start the desktop app from Explorer. When it is launched from inside an
> MSIX-packaged app, Windows may redirect its "Start with Windows" entry.

#### Approving reports in the desktop app

The *Reports* tab of the desktop app has the same **Approve** / **Revoke
approval** (TR *Onayla* / *Onayı geri al*) buttons and confirm dialog as the
browser viewer. The library logic is not duplicated in Rust: the app's
`approve_report` / `revoke_report` commands run the Node stage CLI of your
Auspex checkout,

```bash
node <auspexRoot>/src/stageCli.js approve|revoke --db=<db> --schema=<schema> --category=<category> --name=<name> --expected-hash=<sqlHash>
```

which applies the viewer's checks (the report location exactly as the library
lists it, at most 200 characters per part, the required SQL hash of the
opened report content, the report must exist, be in the right stage and
still stand for that version, else `STALE_VERSION`). The app reads that hash
only from the report metadata and the served HTML and computes none itself;
a report without one is refused with `INVALID_INPUT` and a request to run it
with `run_report` or re-render the library with `render_reports`. The CLI also takes the same library lock, records `stageHistory`,
regenerates the HTML and rebuilds the schema memory view. Every run is written
to the audit log with `source` and `actor` `desktop`. The CLI prints one
JSON line (`{"ok":true,"stage":..,"version":..}` or
`{"ok":false,"code":..,"message":..}`) and exits with 1 on errors. It honours
`AUSPEX_HOME` and the folder overrides like the server, and never touches a
database or the network.

The *Rules* tab's **Archive** button works the same way: the app's
`archive_note` command checks the profile name, the note id and the reason in
Rust and runs

```bash
node <auspexRoot>/src/stageCli.js archive-note --profile=<profile> --id=<id> --reason=<reason>
```

which applies the viewer's checks and store logic (404 unknown note, 409
already archived) and audits with `source` and `actor` `desktop`.

The table page's score dialog works the same way: the app's `score_column`
command checks the profile, the names, the score or clear and the roles in
Rust (the same rules as the viewer route) and runs

```bash
node <auspexRoot>/src/stageCli.js score-column --profile=<profile> --schema=<schema> --table=<table> --column=<column> --score=<1-5> [--roles=<role,role>]
node <auspexRoot>/src/stageCli.js score-column --profile=<profile> --schema=<schema> --table=<table> --column=<column> --clear=true
```

which writes the user layer only and audits like the viewer route with
`source` and `actor` `desktop`.

Requirements:

- **Node 20+** on `PATH`, or `AUSPEX_NODE` set to the absolute path of
  `node.exe`. Only absolute `PATH` entries are searched.
- **The Auspex folder**: `AUSPEX_ROOT`, or a top-level `"auspexRoot"` in
  `~/.auspex/profiles.json` (see Profiles file), pointing at the checkout that
  holds `src/stageCli.js`. Without it the app shows "Auspex folder not found"
  (TR "Auspex klasörü bulunamadı") with how to set it.

The app starts only this fixed program and script, passes each part of the
report location as its own argument (never through a shell), checks the parts
in Rust first, and stops the CLI after 30 seconds. When the CLI times out or
gives no result, the change may or may not have been applied: the app says so,
reloads the list and writes an audit line (actor `desktop`, error code
`TIMEOUT` or `CLI_FAILED`) itself. Only `api`,
`approve_report`, `revoke_report`, `archive_note` and `score_column` are allowed in the
window's capability; there is no shell plugin.
