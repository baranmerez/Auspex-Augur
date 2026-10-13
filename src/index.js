#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, describeConnection } from './config.js';
import { ReadOnlyDatabase } from './db.js';
import { listSchemas, listTables, describeTable, search } from './catalog.js';
import { ReportService } from './reports/service.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  process.stderr.write(`auspex: configuration error: ${err.message}\n`);
  process.exit(1);
}
const db = new ReadOnlyDatabase(config, { source: 'mcp' });
const reports = new ReportService(db, config.libraryDir);

const defaultTimeoutS = config.statementTimeoutMs / 1000;
const maxTimeoutS = config.maxStatementTimeoutMs / 1000;

const instructions = [
  'Auspex gives read-only access to one or more PostgreSQL databases, each configured as a named profile.',
  'Every tool except list_profiles requires an explicit profile. There is no default database.',
  'Before the first database call in a conversation, the user must have named the database to work on in this conversation.',
  'If they have not, call list_profiles, show the profiles and ask which one to use. Never guess a profile and never reuse a choice from another conversation.',
  'When switching to a different profile mid-conversation, confirm with the user first.',
  'Some tables are very large. Use search to find tables and columns, use estimated_rows instead of count(*) on big tables, check plans with explain (without analyze) first, and narrow by indexed columns.',
  `Queries time out after ${defaultTimeoutS} s by default. Before running a query with a longer timeoutSeconds, or explain analyze on a large table, tell the user which table, the estimated rows and why it may take long.`,
  'Report library: when an analysis query is worth keeping, save it with save_report (it becomes a draft under <db>/<schema>/<category>), run it with run_report and show the user the summary and the HTML file path; iterate by saving new SQL versions.',
  'Call approve_report only after the user explicitly approved that report in this conversation.',
  'Change scripts (INSERT/UPDATE/DELETE/DDL) are never executed through Auspex: write them with save_execute_script for the user to run with a privileged role.',
  'run_report with analyze="auto" skips EXPLAIN ANALYZE when the previous run took longer than 30 s; ask the user before forcing analyze="always" on such reports.',
].join(' ');

const server = new McpServer({ name: 'auspex', version: '0.8.0' }, { instructions });

const profileArg = z.string().min(1).describe('Required profile name (see list_profiles). Use only a profile the user named in this conversation; otherwise ask the user first.');
const paramsArg = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
  .describe('Values for $1, $2, ... placeholders. Prefer these over inlining literals.');
const timeoutArg = z.number().min(1).optional()
  .describe(`Statement timeout in seconds for this call. Default ${defaultTimeoutS}; maximum ${maxTimeoutS} unless the profile has a lower limit (see list_profiles). Tell the user before using more than the default.`);

// Wraps a handler: JSON output and error reporting. Audit logging happens in
// ReadOnlyDatabase, so every database call is recorded exactly once.
function tool(name, toolConfig, handler) {
  server.registerTool(name, toolConfig, async args => {
    try {
      const result = await handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });
}

tool('list_profiles', {
  title: 'List connection profiles',
  description: 'Lists configured database profiles with description, host, database, user and timeout limit (never passwords). Call this and ask the user which profile to use when they have not named one in this conversation; show each description so production databases are clearly marked.',
  inputSchema: {},
}, async () => ({
  limits: { maxRows: config.maxRows, exportMaxRows: config.exportMaxRows, defaultTimeoutSeconds: defaultTimeoutS },
  exportDir: config.exportDir,
  profilesFile: config.profilesFile,
  profiles: [...config.profiles].map(([name, cs]) => ({
    name,
    description: config.profileInfo.get(name)?.description ?? null,
    source: config.profileInfo.get(name)?.source,
    ...describeConnection(cs),
    maxTimeoutSeconds: (config.maxTimeoutByProfile.get(name) ?? config.maxStatementTimeoutMs) / 1000,
  })),
}));

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
  description: 'Shows columns, types, nullability, defaults, comments, constraints, indexes, incoming foreign keys and (for views) the definition.',
  inputSchema: {
    profile: profileArg,
    schema: z.string(),
    table: z.string(),
  },
}, async ({ profile, schema, table }) => describeTable(db, profile, schema, table));

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
}, async ({ profile, sql, params, maxRows, timeoutSeconds }) => db.query(profile, sql, params, maxRows, timeoutSeconds));

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
}, async ({ profile, sql, params, analyze, timeoutSeconds }) => db.explain(profile, sql, params, analyze === true, timeoutSeconds));

tool('export_csv', {
  title: 'Export query to CSV',
  description: `Streams a read-only query result to a UTF-8 CSV file in ${config.exportDir} (up to ${config.exportMaxRows} rows) and returns only the file path, columns and row count. Use for large results; analyze the file locally instead of reading rows into the conversation.`,
  inputSchema: {
    profile: profileArg,
    sql: z.string(),
    params: paramsArg,
    fileName: z.string().optional().describe('Base file name; a timestamp prefix is added.'),
    delimiter: z.enum([',', ';', '\t']).optional().describe('Default ",". Use ";" for Turkish-locale Excel.'),
    timeoutSeconds: timeoutArg,
  },
}, async ({ profile, sql, params, fileName, delimiter, timeoutSeconds }) => db.exportCsv(profile, sql, params, fileName, delimiter || ',', timeoutSeconds));

// ---------- report library ----------
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
}, async args => reports.save(args));

tool('run_report', {
  title: 'Run report',
  description: 'Runs a library report read-only: EXPLAIN (FORMAT JSON, with ANALYZE unless skipped) plus a masked preview, appends the run to its history and regenerates its HTML. Returns a compact summary (timings, hotspots, joins, warnings, first preview rows) and the HTML path.',
  inputSchema: {
    ...refArgs,
    analyze: z.enum(['auto', 'always', 'never']).optional().describe('auto (default): ANALYZE unless the previous run took more than 30 s. always: ask the user first for slow reports. never: plan only.'),
    previewRows: z.number().int().min(0).max(config.maxRows).optional().describe('Rows stored in the HTML preview. Default 50.'),
    returnRows: z.number().int().min(0).max(100).optional().describe('Preview rows returned to you. Default 20.'),
    params: paramsArg,
    timeoutSeconds: timeoutArg,
  },
}, async ({ analyze, previewRows, returnRows, params, timeoutSeconds, ...ref }) =>
  reports.run(ref, { analyze: analyze === 'never' ? false : analyze === 'always' ? 'always' : 'auto', previewRows, returnRows, params, timeoutSeconds }));

tool('approve_report', {
  title: 'Approve report',
  description: 'Moves a report draft into SELECT/<db>/<schema>/<category>/. Only call this after the user explicitly approved the report in this conversation.',
  inputSchema: refArgs,
}, async args => reports.approve(args));

tool('list_reports', {
  title: 'List reports',
  description: 'Lists library reports and change scripts with stage (draft, approved, execute), db, schema, category, versions and last run.',
  inputSchema: {
    db: z.string().optional().describe('Only this database (profile).'),
    stage: z.enum(['draft', 'approved', 'execute']).optional(),
  },
}, async filter => ({ libraryDir: config.libraryDir, reports: reports.list(filter) }));

tool('render_reports', {
  title: 'Re-render report HTML',
  description: 'Regenerates every report HTML from its stored JSON (for example after a template update). Does not touch the database.',
  inputSchema: {},
}, async () => reports.renderAll());

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
}, async args => reports.saveExecute(args));

async function shutdown() {
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
