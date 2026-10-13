#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, describeConnection } from './config.js';
import { ReadOnlyDatabase } from './db.js';
import { listSchemas, listTables, describeTable, search } from './catalog.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  process.stderr.write(`auspex: configuration error: ${err.message}\n`);
  process.exit(1);
}
const db = new ReadOnlyDatabase(config, { source: 'mcp' });

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
].join(' ');

const server = new McpServer({ name: 'auspex', version: '0.7.0' }, { instructions });

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

async function shutdown() {
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
