// Tool groups for enabledToolGroups (docs/configuration.md: Tool groups).
// The setting chooses which MCP tools this server registers at startup; it
// is not a database permission. Every registered tool must belong to exactly
// one group (src/index.js refuses to start otherwise), so a new tool cannot
// slip past the setting.
export const toolGroups = {
  // Always enabled: profile selection and the read-only role check.
  core: ['list_profiles', 'check_profile'],
  // Catalog and schema-memory reads (catalog tools also record what they read
  // in the local schema memory).
  explore: [
    'search', 'list_schemas', 'list_tables', 'describe_table', 'describe_tables', 'describe_functions', 'list_functions',
    'profile_tables', 'relation_stats', 'table_knowledge', 'function_knowledge', 'scanned_files',
  ],
  // Caller SQL: read-only queries, plans and CSV export.
  query: ['query', 'explain', 'export_csv'],
  // Report library and change-script files.
  reports: ['save_report', 'run_report', 'approve_report', 'list_reports', 'share_report', 'render_reports', 'save_execute_script'],
  // Explicit schema-memory changes.
  memory: ['remember', 'score_columns'],
};

export const toolGroupNames = Object.keys(toolGroups);

// A group that is useless without another one: score_columns needs a table
// recorded by describe_table(s), and notes are read back with table_knowledge.
export const toolGroupDependencies = { memory: ['explore'] };

export function toolGroupOf(tool) {
  return toolGroupNames.find(group => toolGroups[group].includes(tool)) ?? null;
}

// The effective groups for a configured value: null (not configured) enables
// every group; a list must name known groups, at least one besides core, and
// satisfy the dependencies. core is always added. where names the setting in
// error messages. Returns the groups in their fixed order.
export function resolveToolGroups(value, where) {
  if (value === null || value === undefined) return [...toolGroupNames];
  if (!Array.isArray(value) || value.some(g => typeof g !== 'string')) {
    throw new Error(`Invalid ${where}: expected a list of tool group names (${toolGroupNames.join(', ')}).`);
  }
  const names = value.map(g => g.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter(g => !toolGroupNames.includes(g));
  if (unknown.length) throw new Error(`Invalid ${where}: unknown tool group ${unknown.map(g => `"${g}"`).join(', ')}; known groups: ${toolGroupNames.join(', ')}.`);
  const chosen = new Set(['core', ...names]);
  if (chosen.size === 1) throw new Error(`Invalid ${where}: enable at least one group besides core (${toolGroupNames.filter(g => g !== 'core').join(', ')}); leave the setting out to enable all.`);
  for (const group of chosen) {
    const missing = (toolGroupDependencies[group] ?? []).filter(dep => !chosen.has(dep));
    if (missing.length) throw new Error(`Invalid ${where}: tool group "${group}" needs ${missing.map(g => `"${g}"`).join(', ')} as well.`);
  }
  return toolGroupNames.filter(g => chosen.has(g));
}

export const toolsOfGroups = groups => groups.flatMap(g => toolGroups[g]);
