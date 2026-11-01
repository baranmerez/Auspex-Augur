import { maxDescribeTables, maxProfileTables } from './catalog.js';

// Server instructions for the enabled tool groups. An entry [groups, text] is
// kept only when all of those groups are enabled, and its text names only
// tools of those groups (and core), so a smaller tool set never gets advice
// for a tool it does not have (tests/instructions.test.js checks every
// combination). The last sentence names the disabled tools.
export function serverInstructions(enabledGroups, disabledTools, { defaultTimeoutS }) {
  const enabled = new Set(enabledGroups);
  const savedTexts = [
    enabled.has('memory') && 'remember note text',
    enabled.has('reports') && 'save_report title, description and note, save_execute_script title and purpose (and comments inside the script)',
    enabled.has('memory') && 'score_columns reasons and trigger summaries',
  ].filter(Boolean);
  const lines = [
    'Auspex gives read-only access to one or more PostgreSQL databases, each configured as a named profile.',
    'Every tool except list_profiles requires an explicit profile. There is no default database.',
    'On the first call to a profile Auspex checks that its database role is read-only. If the role could write, every call on that profile fails with an explanation: tell the user which privilege to remove; do not look for a way around it. Warnings (for example CREATE on a schema) do not block; mention them once.',
    'Before the first database call in a conversation, the user must have named the database to work on in this conversation.',
    'If they have not, call list_profiles, show the profiles and ask which one to use. Never guess a profile and never reuse a choice from another conversation.',
    'When switching to a different profile mid-conversation, confirm with the user first.',
    'Each profile has a query budget (maxQueriesPerMinute in list_profiles); when it is used up calls are refused for a while, so batch work into fewer, set-based queries instead of one query per item, and never retry a refused call in a loop.',
    [['explore'], 'Some tables are very large. Use search to find tables and columns, use estimated_rows instead of count(*) on big tables, and narrow by indexed columns.'],
    [['query'], 'Check plans with explain (without analyze) first on big tables.'],
    [['query'], `Queries time out after ${defaultTimeoutS} s by default. Before running a query with a longer timeoutSeconds, or explain analyze on a large table, tell the user which table, the estimated rows and why it may take long.`],
    [['reports'], 'Report library: when an analysis query is worth keeping, save it with save_report (it becomes a draft under <db>/<schema>/<category>; category may be nested up to 3 levels with "/", e.g. Orders/Delivery), run it with run_report and show the user the summary and the HTML file path; iterate by saving new SQL versions.'],
    [['reports'], 'Call approve_report only after the user explicitly approved that report in this conversation.'],
    [['reports'], 'Change scripts (INSERT/UPDATE/DELETE/DDL) are never executed through Auspex: write them with save_execute_script for the user to run with a privileged role.'],
    [['reports'], 'run_report with analyze="auto" skips EXPLAIN ANALYZE when the previous run took longer than 30 s; ask the user before forcing analyze="always" on such reports.'],
    [['explore'], 'Schema memory: Auspex keeps local notes per profile about the tables you worked with. describe_table and describe_tables record a table and report changesSinceLast (tell the user about them); describe_functions records functions the same way and list_functions records an inventory of them. It never crawls the catalog on its own.'],
    [['query'], 'explain records the tables and columns its plan used in the schema memory.'],
    [['reports'], 'run_report records the tables and columns its plan used in the schema memory.'],
    [['explore'], 'Before describing a table again, call table_knowledge: it answers from memory without touching the database. For a function already described or listed, function_knowledge does the same.'],
    [['explore'], `When you need several tables, do not loop over describe_table or send one measuring query per table: use describe_tables for the structure of up to ${maxDescribeTables} tables and profile_tables for row estimates, fill rates, distinct counts and parent-child fan-out of up to ${maxProfileTables} tables. Each takes a constant number of statements however many tables are listed. To see which neighbours of a table matter most, relation_stats ranks its referenced (instance) and referencing (dependent) tables by estimated linked rows from planner statistics, without reading data.`],
    [['memory'], 'When the user states a business rule, save it with remember kind=rule. Save a finding from data as kind=observation with evidence (the SQL and aggregate figures only, never row values or personal data). Your own interpretations are kind=inference; never present them as fact, and confirm one only after the user agreed.'],
    ...(savedTexts.length ? [`Write every user-facing text you save into Auspex files in the notesLanguage from list_profiles: ${savedTexts.join(', ')}. Identifiers, SQL, column aliases and the script step markers (BEGIN, DEFINE, PROCESS, MATCH, CORRECT/FAIL, ROLLBACK) are not translated; only the text after a marker follows notesLanguage. If notesLanguage is null, ask the user once "Which language should notes and report texts be saved in?" (in the user language), use the answer for this conversation and suggest adding "notesLanguage": "<code>" to profiles.json. Do not translate existing notes.`] : []),
    'Results may carry notes for the tables they touched; take them into account.',
    [['memory'], 'Column importance: score_columns saves your own 1-5 score per column (by agent) after you read the SQL that uses a table (report library and the user script files); it never queries the database. Save a by user score only when the user stated it in this conversation, and their usage note with remember kind=rule on that column. Never save user script files as reports.'],
    [['explore'], 'When a report or analysis is finished and results listed unexploredNeighbors, name them and ask the user whether to explore them. Only after a yes, call describe_tables on them (structure only); do not query their data unless asked.'],
  ];
  const disabled = [...disabledTools];
  return [
    ...lines.filter(line => !Array.isArray(line) || line[0].every(g => enabled.has(g))).map(line => (Array.isArray(line) ? line[1] : line)),
    ...(disabled.length ? [`This server was started with enabledToolGroups ${[...enabled].join(', ')}; these tools are not available: ${disabled.join(', ')}. Do not plan steps that need them; tell the user when a request needs one.`] : []),
  ].join(' ');
}
