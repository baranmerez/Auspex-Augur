// Extracts the relations (and, from JSON plans, the columns) a query touched,
// so the schema memory learns from work that already happened. No database
// access: it only reads plans Auspex already produced.

const systemSchema = /^(pg_.*|information_schema)$/;

const unquote = name => (name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name);
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const identifier = '("(?:[^"]|"")+"|[A-Za-z_\\u00C0-\\uFFFF][\\w$\\u00C0-\\uFFFF]*)';

// Columns written as alias.column in plan expressions (VERBOSE output qualifies them).
function aliasColumns(alias, texts) {
  const re = new RegExp(`(?:^|[^\\w$."])${escapeRegex(alias)}\\.${identifier}`, 'g');
  const found = new Set();
  for (const text of texts) {
    for (const m of String(text).matchAll(re)) found.add(unquote(m[1]));
  }
  return found;
}

// Expression keys that name the columns a node really needs.
const expressionKeys = ['Filter', 'Index Cond', 'Recheck Cond', 'TID Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Group Key', 'Sort Key', 'Presorted Key'];

// EXPLAIN (VERBOSE, FORMAT JSON): scan nodes name relation, schema and alias.
// Columns come from the expressions of all nodes and from the Output of
// non-scan nodes: a scan's own Output often lists every column of the table
// (physical target list), so it is only used when the scan is the whole plan.
export function relationsFromJsonPlan(explainJson, joins = []) {
  const root = Array.isArray(explainJson) ? explainJson[0]?.Plan : explainJson?.Plan;
  const relations = new Map();
  const aliases = new Map();
  const nodes = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    if (node['Relation Name'] && node.Schema && !systemSchema.test(node.Schema)) {
      const key = `${node.Schema}.${node['Relation Name']}`;
      if (!relations.has(key)) relations.set(key, { schema: node.Schema, table: node['Relation Name'], columns: new Set() });
      const alias = node.Alias || node['Relation Name'];
      aliases.set(alias, new Set([...(aliases.get(alias) || []), key]));
    }
    for (const child of node.Plans || []) walk(child);
  };
  walk(root);
  for (const node of nodes) {
    const isScan = !!node['Relation Name'];
    const texts = expressionKeys.flatMap(k => [].concat(node[k] ?? []));
    if (!isScan || node === root) texts.push(...(node.Output || []));
    for (const [alias, keys] of aliases) {
      if (keys.size !== 1) continue; // the same alias on two relations: ambiguous
      const rel = relations.get([...keys][0]);
      for (const col of aliasColumns(alias, texts)) rel.columns.add(col);
    }
  }
  // Join columns from the plan summary (schema.table.column on both sides).
  for (const join of joins) {
    for (const pair of join.columnPairs || []) {
      for (const side of [pair.left, pair.right]) {
        const ref = splitColumnRef(side);
        if (ref && relations.has(`${ref.schema}.${ref.table}`)) relations.get(`${ref.schema}.${ref.table}`).columns.add(ref.column);
      }
    }
  }
  return [...relations.values()].map(r => ({ ...r, columns: [...r.columns].sort() }));
}

// EXPLAIN (VERBOSE, FORMAT TEXT): scan lines read "Seq Scan on schema.table alias".
// Only relation scans count; function, CTE and subquery scans are skipped.
export function relationsFromTextPlan(text) {
  const re = new RegExp(`(?:Seq Scan|Index Scan using \\S+|Index Only Scan using \\S+|Bitmap Heap Scan|Tid Scan|Tid Range Scan|Sample Scan|Foreign Scan) on ${identifier}\\.${identifier}`, 'g');
  const relations = new Map();
  for (const m of String(text || '').matchAll(re)) {
    const schema = unquote(m[1]);
    const table = unquote(m[2]);
    if (!systemSchema.test(schema)) relations.set(`${schema}.${table}`, { schema, table, columns: [] });
  }
  return [...relations.values()];
}

// "schema.table.column" as used in plan summaries.
export function splitColumnRef(ref) {
  const text = String(ref || '');
  const first = text.indexOf('.');
  const last = text.lastIndexOf('.');
  if (first < 1 || last <= first) return null;
  return { schema: text.slice(0, first), table: text.slice(first + 1, last), column: text.slice(last + 1) };
}
