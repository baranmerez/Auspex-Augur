#!/usr/bin/env node
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, describeConnection } from './config.js';
import { ReadOnlyDatabase } from './db.js';
import { classifyError, ToolError } from './errors.js';
import {
  listSchemas, listTables, describeTable, describeTables, profileTables, search,
  maxDescribeTables, maxProfileTables, defaultSampleRows, maxSampleRows,
} from './catalog.js';
import { ReportService } from './reports/service.js';
import { sqlHash } from './reports/library.js';
import { SchemaMemory, noteKinds } from './memory/store.js';
import { relationsFromTextPlan } from './memory/planUsage.js';
import { loadPromptSkills, promptText } from './skills.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  process.stderr.write(`auspex: configuration error: ${err.message}\n`);
  process.exit(1);
}
// Workflow prompts come from the skill files; a broken checkout fails here,
// not on the first prompt request.
let promptSkills;
try {
  promptSkills = loadPromptSkills();
} catch (err) {
  process.stderr.write(`auspex: skills error: ${err.message}
`);
  process.exit(1);
}
const db = new ReadOnlyDatabase(config, { source: 'mcp' });
const memory = new SchemaMemory(config.memoryDir, { approvedJoins: profile => reports.approvedJoinPairs(profile) });
const reports = new ReportService(db, config.libraryDir, memory);

const defaultTimeoutS = config.statementTimeoutMs / 1000;
const maxTimeoutS = config.maxStatementTimeoutMs / 1000;

const instructions = [
  'Auspex gives read-only access to one or more PostgreSQL databases, each configured as a named profile.',
  'Every tool except list_profiles requires an explicit profile. There is no default database.',
  'On the first call to a profile Auspex checks that its database role is read-only. If the role could write, every call on that profile fails with an explanation: tell the user which privilege to remove; do not look for a way around it. Warnings (for example CREATE on a schema) do not block; mention them once.',
  'Before the first database call in a conversation, the user must have named the database to work on in this conversation.',
  'If they have not, call list_profiles, show the profiles and ask which one to use. Never guess a profile and never reuse a choice from another conversation.',
  'When switching to a different profile mid-conversation, confirm with the user first.',
  'Each profile has a query budget (maxQueriesPerMinute in list_profiles); when it is used up calls are refused for a while, so batch work into fewer, set-based queries instead of one query per item, and never retry a refused call in a loop.',
  'Some tables are very large. Use search to find tables and columns, use estimated_rows instead of count(*) on big tables, check plans with explain (without analyze) first, and narrow by indexed columns.',
  `Queries time out after ${defaultTimeoutS} s by default. Before running a query with a longer timeoutSeconds, or explain analyze on a large table, tell the user which table, the estimated rows and why it may take long.`,
  'Report library: when an analysis query is worth keeping, save it with save_report (it becomes a draft under <db>/<schema>/<category>), run it with run_report and show the user the summary and the HTML file path; iterate by saving new SQL versions.',
  'Call approve_report only after the user explicitly approved that report in this conversation.',
  'Change scripts (INSERT/UPDATE/DELETE/DDL) are never executed through Auspex: write them with save_execute_script for the user to run with a privileged role.',
  'run_report with analyze="auto" skips EXPLAIN ANALYZE when the previous run took longer than 30 s; ask the user before forcing analyze="always" on such reports.',
  'Schema memory: Auspex keeps local notes per profile about the tables you worked with. describe_table and describe_tables record a table and report changesSinceLast (tell the user about them); run_report and explain record the tables and columns their plans used. It never crawls the catalog on its own.',
  'Before describing a table again, call table_knowledge: it answers from memory without touching the database.',
  `When you need several tables, do not loop over describe_table or send one measuring query per table: use describe_tables for the structure of up to ${maxDescribeTables} tables and profile_tables for row estimates, fill rates, distinct counts and parent-child fan-out of up to ${maxProfileTables} tables. Each takes a constant number of statements however many tables are listed.`,
  'When the user states a business rule, save it with remember kind=rule. Save a finding from data as kind=observation with evidence (the SQL and aggregate figures only, never row values or personal data). Your own interpretations are kind=inference; never present them as fact, and confirm one only after the user agreed.',
  'Results may carry notes for the tables they touched; take them into account.',
  'When a report or analysis is finished and results listed unexploredNeighbors, name them and ask the user whether to explore them. Only after a yes, call describe_tables on them (structure only); do not query their data unless asked.',
].join(' ');

const server = new McpServer({ name: 'auspex', version: '0.9.0' }, { instructions });

const profileArg = z.string().min(1).describe('Required profile name (see list_profiles). Use only a profile the user named in this conversation; otherwise ask the user first.');
const paramsArg = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
  .describe('Values for $1, $2, ... placeholders. Prefer these over inlining literals.');
const timeoutArg = z.number().min(1).optional()
  .describe(`Statement timeout in seconds for this call. Default ${defaultTimeoutS}; maximum ${maxTimeoutS} unless the profile has a lower limit (see list_profiles). Tell the user before using more than the default.`);

// Memory is a side effect of database work: it must never fail the tool.
function learn(fn) {
  try {
    return fn() ?? {};
  } catch (err) {
    return { memoryError: err.message };
  }
}

// Error result: the readable text first (unchanged), then the machine-readable
// envelope (src/errors.js) as structuredContent and as a JSON text block for
// clients that only read text. The envelope never holds the message itself.
function errorResult(err, correlationId, text = `Error: ${err?.message ?? String(err)}`) {
  const error = { ...classifyError(err), correlationId };
  return {
    content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify({ error }) }],
    structuredContent: { error },
    _meta: { correlationId },
    isError: true,
  };
}

// Wraps a handler: JSON output and error reporting. Audit logging happens in
// ReadOnlyDatabase (database calls) or in the handler via db.audited (library
// and memory changes), so each call is recorded exactly once. One correlation
// ID per call links its audit entries and its result (_meta.correlationId).
function tool(name, toolConfig, handler) {
  server.registerTool(name, toolConfig, async args => {
    const correlationId = crypto.randomUUID();
    try {
      const result = await db.withCorrelation(correlationId, () => handler(args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], _meta: { correlationId } };
    } catch (err) {
      return errorResult(err, correlationId);
    }
  });
}

// Failures inside the MCP SDK (input schema validation, unknown tool) never
// reach tool() and are not audited; they get the same envelope. The SDK's
// text is kept as is.
if (typeof server.createToolError === 'function') {
  server.createToolError = message => errorResult(
    new ToolError(/-32602|Input validation error|Invalid arguments/.test(message) ? 'INVALID_INPUT' : 'INTERNAL', message),
    crypto.randomUUID(), message);
}

tool('list_profiles', {
  title: 'List connection profiles',
  description: 'Lists configured database profiles with description, host, database, user, timeout limit and query budget per minute (never passwords). Call this and ask the user which profile to use when they have not named one in this conversation; show each description so production databases are clearly marked.',
  inputSchema: {},
}, async () => ({
  limits: {
    maxRows: config.maxRows, exportMaxRows: config.exportMaxRows, exportMaxBytes: config.exportMaxBytes,
    exportMaxSeconds: config.exportMaxMs / 1000, defaultTimeoutSeconds: defaultTimeoutS,
  },
  exportDir: config.exportDir,
  profilesFile: config.profilesFile,
  profiles: [...config.profiles].map(([name, cs]) => ({
    name,
    description: config.profileInfo.get(name)?.description ?? null,
    source: config.profileInfo.get(name)?.source,
    ...describeConnection(cs),
    maxTimeoutSeconds: (config.maxTimeoutByProfile.get(name) ?? config.maxStatementTimeoutMs) / 1000,
    defaultTimeoutSeconds: Math.min(config.statementTimeoutMs, config.maxTimeoutByProfile.get(name) ?? config.maxStatementTimeoutMs) / 1000,
    maxQueriesPerMinute: db.maxQueriesPerMinute(name),
    roleCheck: roleCheckSummary(db.roleCheck(name)),
  })),
}));

function roleCheckSummary(r) {
  if (!r) return 'not checked yet (runs on the first call to this profile; check_profile runs it now)';
  return { status: r.status, blocking: r.blocking.map(f => f.text), warnings: r.warnings.map(f => f.text), checkedAt: r.checkedAt };
}

tool('check_profile', {
  title: 'Check that a profile is read-only',
  description: 'Checks the database role of a profile from the catalog: superuser, BYPASSRLS, REPLICATION, CREATEROLE, membership in pg_write_all_data / server-file roles, or any table it can write to block the profile (no query runs on it); CREATE on a schema or the database, CREATEDB and default_transaction_read_only off are warnings. Runs automatically on the first call to each profile; use this to see the result or to check again after the role was fixed.',
  inputSchema: { profile: profileArg },
}, async ({ profile }) => db.audited('check_profile', { profile: profile ?? null }, async () => {
  const r = await db.checkProfile(profile);
  return { profile: r.profile, ...roleCheckSummary(r) };
}, r => ({ roleStatus: r.status })));

tool('search', {
  title: 'Search tables and columns',
  description: 'Finds tables, views and columns whose name or comment matches the text, across all non-system schemas (or one schema). Case-insensitive; plain text is a contains-match, % and _ work as ILIKE wildcards. Returns estimated rows (null = never analyzed, unknown) and SELECT privilege.',
  inputSchema: {
    profile: profileArg,
    text: z.string().min(1).describe('Text to find, e.g. invoice or customer.'),
    schema: z.string().optional().describe('Limit to one schema.'),
    includeColumns: z.boolean().optional().describe('Also match column names and comments. Default true.'),
  },
}, async ({ profile, text, schema, includeColumns }) => search(db, profile, text, schema, includeColumns !== false));

tool('list_schemas', {
  title: 'List schemas',
  description: 'Lists non-system schemas with owner, relation count, usage privilege and comment.',
  inputSchema: { profile: profileArg },
}, async ({ profile }) => listSchemas(db, profile));

tool('list_tables', {
  title: 'List tables',
  description: 'Lists tables, views, materialized views and foreign tables in a schema with estimated rows (null = never analyzed, unknown), size, SELECT privilege and comment.',
  inputSchema: {
    profile: profileArg,
    schema: z.string().describe('Schema name, e.g. public.'),
    pattern: z.string().optional().describe('Optional ILIKE filter on the name, e.g. %invoice%.'),
  },
}, async ({ profile, schema, pattern }) => listTables(db, profile, schema, pattern));

tool('describe_table', {
  title: 'Describe table',
  description: 'Shows columns, types, nullability, defaults, comments, constraints, indexes, incoming foreign keys and (for views) the definition. Reads the catalog only. Also records the table in the schema memory; the memory field reports changes since the last time and notes on the table.',
  inputSchema: {
    profile: profileArg,
    schema: z.string(),
    table: z.string(),
  },
}, async ({ profile, schema, table }) => {
  const { oid, columns, ...result } = await describeTable(db, profile, schema, table);
  return {
    ...result,
    columns: columns.map(({ attnum, ...c }) => c),
    memory: learn(() => memory.recordDescribe({ ...result, oid, columns })),
  };
});

const tableListArg = max => z.array(z.string().min(1)).min(1).max(max);

tool('describe_tables', {
  title: 'Describe many tables',
  description: `Like describe_table for up to ${maxDescribeTables} relations at once: columns, types, nullability, defaults, comments, constraints (incl. foreign keys), indexes, incoming foreign keys, estimated rows and (for views) the definition. Reads the catalog only, with a constant number of statements however many tables are listed: 5, or 6 when one of them is a view or materialized view (field statements). Unknown or invalid names are reported per table (field error) without failing the call. Each found table is recorded in the schema memory like describe_table (memory per table, incl. changesSinceLast). Prefer this over calling describe_table in a loop.`,
  inputSchema: {
    profile: profileArg,
    tables: tableListArg(maxDescribeTables).describe('Relations as schema.table, e.g. ["sales.orders", "sales.customers"].'),
  },
}, async ({ profile, tables }) => {
  const result = await describeTables(db, profile, tables);
  const found = result.tables.filter(t => !t.error);
  const learned = learn(() => ({ list: memory.recordDescribeMany(result.profile, found) }));
  return {
    ...result,
    tables: result.tables.map(t => {
      if (t.error) return t;
      const { profile: _profile, oid: _oid, columns, ...rest } = t;
      return { ...rest, columns: columns.map(({ attnum, ...c }) => c), memory: learned.list?.[found.indexOf(t)] ?? learned };
    }),
  };
});

tool('profile_tables', {
  title: 'Profile many tables',
  description: `Measures up to ${maxProfileTables} relations at once without returning any row values: estimated rows and, per column, fillRate (non-null share) and distinctInSample, computed on a sample of sampleRows rows per table (default ${defaultSampleRows}, max ${maxSampleRows}; TABLESAMPLE SYSTEM plus LIMIT when the estimate exceeds sampleRows, otherwise a plain LIMIT scan; the response field sampling explains it). With parent, also the fan-out of each table over the parent rows (optionally only those inside window on a parent column, from <= column < to): parent rows, parents with children, child rows, average and maximum children per parent. The child column is the single-column foreign key to parent.key; without one, list the table as schema.table:column. All tables together take at most 3 statements in one read-only transaction (1 catalog lookup, 1 column-statistics statement, 1 fan-out statement when parent is given; field statements). Names are checked against the catalog before they are used. Prefer this over one measuring query per table.`,
  inputSchema: {
    profile: profileArg,
    tables: tableListArg(maxProfileTables).describe('Relations as schema.table; with parent, schema.table:column names the column that points at parent.key when there is no foreign key.'),
    parent: z.object({
      table: z.string().min(1).describe('Parent relation as schema.table.'),
      key: z.string().min(1).describe('Parent column the children point at, usually its primary key.'),
    }).optional().describe('Measure fan-out of each table over this parent.'),
    window: z.object({
      column: z.string().min(1).describe('Column of the parent table, e.g. a date.'),
      from: z.string().min(1).describe('Inclusive lower bound, e.g. 2026-01-01.'),
      to: z.string().min(1).describe('Exclusive upper bound, e.g. 2026-02-01.'),
    }).optional().describe('Only parent rows with from <= column < to. Requires parent.'),
    sampleRows: z.number().int().min(1).max(maxSampleRows).optional().describe(`Rows sampled per table for column statistics; also caps the distinct parent keys used for fan-out. Default ${defaultSampleRows}.`),
    timeoutSeconds: timeoutArg,
  },
}, async ({ profile, ...options }) => profileTables(db, profile, options));

tool('query', {
  title: 'Run read-only query',
  description: `Runs one SELECT/WITH/VALUES/TABLE statement in a READ ONLY transaction that is always rolled back. Returns at most ${config.maxRows} rows (truncated=true when more exist). Use export_csv for larger results and aggregate in SQL where possible.`,
  inputSchema: {
    profile: profileArg,
    sql: z.string().describe('A single read-only SQL statement.'),
    params: paramsArg,
    maxRows: z.number().int().min(1).max(config.maxRows).optional(),
    timeoutSeconds: timeoutArg,
  },
}, async ({ profile, sql, params, maxRows, timeoutSeconds }) => {
  const result = await db.query(profile, sql, params, maxRows, timeoutSeconds);
  return { ...result, ...learn(() => memory.notesForSql(result.profile, sql)) };
});

tool('explain', {
  title: 'Explain query plan',
  description: 'Shows the query plan. By default the estimated plan only (query not executed). With analyze=true runs EXPLAIN (ANALYZE, BUFFERS): the SELECT is actually executed to report real times, row counts and buffer usage, inside a READ ONLY transaction that is rolled back and limited by the statement timeout. Use analyze on heavy queries only when the user wants real timings.',
  inputSchema: {
    profile: profileArg,
    sql: z.string(),
    params: paramsArg,
    analyze: z.boolean().optional().describe('Execute the query and report actual timings (EXPLAIN ANALYZE, BUFFERS). Default false.'),
    timeoutSeconds: timeoutArg,
  },
}, async ({ profile, sql, params, analyze, timeoutSeconds }) => {
  const result = await db.explain(profile, sql, params, analyze === true, timeoutSeconds);
  return { ...result, ...learn(() => memory.recordSeen(result.profile, relationsFromTextPlan(result.plan))) };
});

tool('export_csv', {
  title: 'Export query to CSV',
  description: `Streams a read-only query result to a UTF-8 CSV file in ${config.exportDir} (up to ${config.exportMaxRows} rows, ${Math.round(config.exportMaxBytes / 1048576)} MB and ${config.exportMaxMs / 1000} s in total) and returns only the file path, columns, row count and size. When a limit is hit the file ends cleanly at a row: truncated is true and stopReason says rows, bytes or time; tell the user and narrow the query. Use for large results; analyze the file locally instead of reading rows into the conversation.`,
  inputSchema: {
    profile: profileArg,
    sql: z.string(),
    params: paramsArg,
    fileName: z.string().optional().describe('Base file name; a timestamp and a random part are added, so an existing file is never overwritten.'),
    delimiter: z.enum([',', ';', '\t']).optional().describe('Default ",". Use ";" for Turkish-locale Excel.'),
    mode: z.enum(['raw', 'spreadsheet']).optional().describe('raw (default): exact values, for scripts and other tools. spreadsheet: text cells starting with = + - @, tab or carriage return get a leading apostrophe so Excel, LibreOffice or Google Sheets do not run them as formulas; numbers and dates stay exact. Use spreadsheet when a person will open the file in a spreadsheet.'),
    timeoutSeconds: timeoutArg,
  },
}, async ({ profile, sql, params, fileName, delimiter, mode, timeoutSeconds }) => db.exportCsv(profile, sql, params, fileName, delimiter || ',', timeoutSeconds, mode || 'raw'));

// ---------- report library ----------
// Audit details for a library change: which report, never its SQL text (the
// SQL is identified by its hash; the library keeps the text itself).
const reportDetails = args => ({ profile: args.db, report: [args.db, args.schema, args.category, args.name].join('/') });

const refArgs = {
  db: z.string().min(1).describe('Database = the profile name the report runs on (first folder level).'),
  schema: z.string().min(1).describe('Main schema of the report (second folder level).'),
  category: z.string().min(1).describe('Category folder, e.g. "Barcode reports" or "General".'),
  name: z.string().min(1).describe('Report name; stored as an ASCII kebab-case file name.'),
};

tool('save_report', {
  title: 'Save report draft',
  description: 'Saves a read-only SQL query as a report draft in the library (_drafts/<db>/<schema>/<category>/<name>.sql) with a fixed HTML template. Saving changed SQL adds a new version. Then call run_report.',
  inputSchema: {
    ...refArgs,
    sql: z.string().min(1).describe('A single read-only SQL statement.'),
    title: z.string().optional().describe('Human-readable title shown in the report.'),
    description: z.string().optional().describe('What the report answers and how to read it.'),
    note: z.string().optional().describe('What changed in this SQL version.'),
    mask: z.array(z.string()).optional().describe('Extra result columns to mask in previews.'),
    unmask: z.array(z.string()).optional().describe('Columns to exempt from automatic masking (only when the user agreed).'),
  },
}, async args => db.audited('save_report', { ...reportDetails(args), sqlHash: sqlHash(args.sql) }, () => reports.save(args),
  r => ({ version: r.version, stage: r.stage })));

tool('run_report', {
  title: 'Run report',
  description: 'Runs a library report read-only: EXPLAIN (FORMAT JSON, with ANALYZE unless skipped) plus a masked preview, appends the run to its history and regenerates its HTML. Returns a compact summary (timings, hotspots, joins, warnings, first preview rows) and the HTML path.',
  inputSchema: {
    ...refArgs,
    analyze: z.enum(['auto', 'always', 'never']).optional().describe('auto (default): ANALYZE unless the previous run took more than 30 s. always: ask the user first for slow reports. never: estimated plan without EXPLAIN ANALYZE; the query itself still runs once for the preview unless previewRows is 0.'),
    previewRows: z.number().int().min(0).max(config.maxRows).optional().describe('Rows stored in the HTML preview. Default 50. With 0 the query is not executed for a preview; only its column names are read (LIMIT 0).'),
    returnRows: z.number().int().min(0).max(100).optional().describe('Preview rows returned to you. Default 20.'),
    params: paramsArg,
    timeoutSeconds: timeoutArg,
  },
}, async ({ analyze, previewRows, returnRows, params, timeoutSeconds, ...ref }) =>
  reports.run(ref, { analyze: analyze === 'never' ? false : analyze === 'always' ? 'always' : 'auto', previewRows, returnRows, params, timeoutSeconds }));

tool('approve_report', {
  title: 'Approve report',
  description: 'Moves a report draft into SELECT/<db>/<schema>/<category>/. Requires a successful run_report of the current SQL; refused otherwise. Only call this after the user explicitly approved the report in this conversation.',
  inputSchema: refArgs,
}, async args => db.audited('approve_report', reportDetails(args), () => reports.approve(args), r => ({ version: r.version })));

tool('list_reports', {
  title: 'List reports',
  description: 'Lists library reports and change scripts with stage (draft, approved, execute), db, schema, category, versions and last run.',
  inputSchema: {
    db: z.string().optional().describe('Only this database (profile).'),
    stage: z.enum(['draft', 'approved', 'execute']).optional(),
  },
}, async filter => ({ libraryDir: config.libraryDir, reports: reports.list(filter) }));

tool('share_report', {
  title: 'Shared copy of a report',
  description: `Writes a copy of a report that can be sent to someone, as a new HTML file in ${config.exportDir}. The copy contains only the title, description, category, the masked preview, timing/row figures and the result's SQL version number and run time; SQL, query plan, parameters, run history and database names are left out. The report's own HTML (which has all of those) is unchanged. It is refused when the last results come from a SQL version other than the current one: run the current version first. Masking is by column name only, so tell the user to check the preview before sending. Does not touch the database.`,
  inputSchema: refArgs,
}, async args => db.audited('share_report', reportDetails(args), () => reports.share(args, config.exportDir), r => ({ version: r.version })));

tool('render_reports', {
  title: 'Re-render report HTML',
  description: 'Regenerates every report HTML from its stored JSON (for example after a template update). Does not touch the database.',
  inputSchema: {},
}, async () => db.audited('render_reports', {}, () => reports.renderAll(), r => ({ rendered: r.rendered })));

tool('save_execute_script', {
  title: 'Save change script',
  description: 'Writes an INSERT/UPDATE/DELETE/DDL script to EXECUTE/<db>/<schema>/<category>/<name>.sql for the user to run with a privileged role. Auspex never executes it. The script must start with BEGIN, end with ROLLBACK, contain no COMMIT and have WHERE on every UPDATE/DELETE.',
  inputSchema: {
    ...refArgs,
    sql: z.string().min(1).describe('The change script (BEGIN ... MATCH checks ... ROLLBACK).'),
    title: z.string().optional(),
    purpose: z.string().optional().describe('What the script changes and why.'),
    relatedReport: z.string().optional().describe('Report that motivated the change, e.g. db/schema/category/name.'),
    expectedRows: z.union([z.number(), z.string()]).optional().describe('Expected affected rows.'),
    replace: z.boolean().optional().describe('Overwrite an existing script with the same name.'),
  },
}, async args => db.audited('save_execute_script', { ...reportDetails(args), sqlHash: sqlHash(args.sql), replace: args.replace === true },
  () => reports.saveExecute(args), r => ({ warnings: r.warnings?.length ?? 0 })));

// ---------- schema memory ----------
tool('table_knowledge', {
  title: 'Table knowledge from memory',
  description: 'Answers from the local schema memory, without touching the database: structure summary (key, used and noted columns first), foreign keys, relations used in approved reports, name-based suggestions (unconfirmed), notes on the table, database-wide notes (databaseNotes: rules always in full, then observations and unconfirmed inferences; follow the rules), recent schema changes and unexplored neighbors. If the table is not in memory, describe_table records it; database-wide notes are returned either way.',
  inputSchema: {
    profile: profileArg,
    schema: z.string(),
    table: z.string(),
  },
}, async ({ profile, schema, table }) => memory.knowledge(db.resolveProfile(profile), schema, table));

tool('remember', {
  title: 'Remember a fact about the data',
  description: 'Adds, confirms or archives a note in the local schema memory of a profile (no database access). kind=rule: a business rule the user stated. kind=observation: a finding backed by evidence (SQL plus aggregate figures; dated). kind=inference: your own interpretation, shown as unconfirmed. Notes never contain row values or personal data. action=confirm turns an inference into a rule or observation, only after the user agreed. Notes are archived with a reason, never deleted.',
  inputSchema: {
    profile: profileArg,
    action: z.enum(['add', 'confirm', 'archive']),
    kind: z.enum(noteKinds).optional().describe('add: rule, observation or inference. confirm: rule or observation.'),
    schema: z.string().optional().describe('With table: the note is about this table. Leave both out for a database-wide note.'),
    table: z.string().optional(),
    column: z.string().optional(),
    text: z.string().optional().describe('The note, one or two sentences.'),
    evidenceSql: z.string().optional().describe('Observation: the read-only SQL behind the finding.'),
    evidenceFigures: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
      .describe('Observation: aggregate figures, e.g. {"rows": 223000, "filled": 0}. Never row values.'),
    id: z.number().int().optional().describe('confirm / archive: the note id.'),
    reason: z.string().optional().describe('archive: why the note is no longer valid.'),
  },
}, async ({ profile, action, kind, schema, table, column, text, evidenceSql, evidenceFigures, id, reason }) =>
  // Logged without the note text, evidence or reason: only what was changed.
  db.audited('remember', { profile: profile ?? null, action, kind, schema, table, column, noteId: id }, async () => {
    const name = db.resolveProfile(profile);
    if (action === 'add') {
      const evidence = evidenceSql || evidenceFigures ? { sql: evidenceSql, figures: evidenceFigures } : undefined;
      return { note: memory.addNote(name, { kind, schema, table, column, text, evidence }) };
    }
    if (id === undefined) throw new ToolError('INVALID_INPUT', `action=${action} needs id.`);
    if (action === 'confirm') return { note: memory.confirmNote(name, id, kind) };
    return { note: memory.archiveNote(name, id, reason) };
  }, r => ({ noteId: r.note.id, noteKind: r.note.kind, noteStatus: r.note.status })));

// ---------- workflow prompts (text from skills/<name>/SKILL.md) ----------
for (const skill of promptSkills) {
  server.registerPrompt(skill.prompt, {
    title: `Auspex workflow: ${skill.prompt}`,
    description: skill.description,
    argsSchema: {
      profile: z.string().optional().describe('Profile the user chose for this conversation. Leave empty to be asked.'),
      goal: z.string().optional().describe('What the user wants, in their words.'),
    },
  }, ({ profile, goal }) => ({
    description: skill.description,
    messages: [{ role: 'user', content: { type: 'text', text: promptText(skill, { profile: profile?.trim(), goal: goal?.trim() }) } }],
  }));
}

async function shutdown() {
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
