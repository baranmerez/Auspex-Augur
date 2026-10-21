// Extracts the relations (and, from JSON plans, the columns) a query touched,
// so the schema memory learns from work that already happened. No database
// access: it only reads plans Auspex already produced.

const systemSchema = /^(pg_.*|information_schema)$/;

const unquote = name => (name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name);
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const identifier = '("(?:[^"]|"")+"|[A-Za-z_\\u00C0-\\uFFFF][\\w$\\u00C0-\\uFFFF]*)';

// Plan expressions with every string constant emptied ('...' becomes ''), so
// text such as 'orders.example_note'::text is not read as a column. Quoted
// identifiers are kept as they are, even when they contain a single quote.
// EXPLAIN writes constants with doubled quotes ('') and doubled backslashes.
function withoutStringLiterals(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      out += "''";
      i = j;
    } else {
      out += c;
    }
  }
  return out;
}

// Columns written as alias.column in plan expressions (VERBOSE output qualifies them).
function aliasColumns(alias, texts) {
  const re = new RegExp(`(?:^|[^\\w$."])${escapeRegex(alias)}\\.${identifier}`, 'g');
  const found = new Set();
  for (const text of texts) {
    for (const m of withoutStringLiterals(String(text)).matchAll(re)) found.add(unquote(m[1]));
  }
  return found;
}

// Words that can stand alone in a plan expression without naming a column:
// operators, literals, cast type words, aggregate stages and sub-plan labels.
const expressionWords = new Set(('and or not is null true false in any all some array row case when then else end as asc desc nulls first last like ilike similar to escape between distinct filter within group over ' +
  'partial finalize simple collate at time zone with without varying precision character interval subplan initplan alternative hashed unknown').split(' '));

// Unqualified identifiers of plan expressions, for a plan with a single scan:
// every bare name there can only belong to that relation. Skipped: names after
// a cast (::), names used as function (followed by "("), qualifiers (followed
// by "."), the part after a "." and the words above. When the caller knows the
// relation's column names, only those count.
function bareColumns(texts, known) {
  const re = new RegExp(identifier, 'g'); // a quoted name is one token, so quotes inside it never start another
  const found = new Set();
  for (const raw of texts) {
    const text = withoutStringLiterals(String(raw));
    for (const m of text.matchAll(re)) {
      const before = text[m.index - 1] ?? '';
      const after = text.slice(m.index + m[0].length).match(/^\s*(.?)/)[1];
      if (/[\w$.:À-￿]/.test(before) || after === '(' || after === '.') continue;
      const name = unquote(m[1]);
      const isWord = !m[1].startsWith('"') && expressionWords.has(name.toLowerCase());
      if (!isWord && (!known || known.has(name))) found.add(name);
    }
  }
  return found;
}

// Expression keys that name the columns a node really needs.
const expressionKeys = ['Filter', 'Index Cond', 'Recheck Cond', 'TID Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Group Key', 'Sort Key', 'Presorted Key'];

// EXPLAIN (VERBOSE, FORMAT JSON): scan nodes name relation, schema and alias.
// Columns come from the expressions of all nodes and from the Output of
// non-scan nodes: a scan's own Output often lists every column of the table
// (physical target list), so it is only used when the scan is the whole plan.
export function relationsFromJsonPlan(explainJson, joins = [], knownColumns = new Map()) {
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
  // One relation scan and no other scan kind (CTE, function, subquery...):
  // unqualified names in the expressions belong to that relation.
  const scans = nodes.filter(n => n['Relation Name']);
  const otherScan = nodes.some(n => !n['Relation Name'] && / Scan$/.test(n['Node Type'] || '') && n['Node Type'] !== 'Bitmap Index Scan');
  const single = scans.length === 1 && !otherScan && relations.size === 1 ? relations.get(`${scans[0].Schema}.${scans[0]['Relation Name']}`) : null;
  const known = single && knownColumns.get(`${single.schema}.${single.table}`);
  for (const node of nodes) {
    const isScan = !!node['Relation Name'];
    const texts = expressionKeys.flatMap(k => [].concat(node[k] ?? []));
    if (!isScan || node === root) texts.push(...(node.Output || []));
    for (const [alias, keys] of aliases) {
      if (keys.size !== 1) continue; // the same alias on two relations: ambiguous
      const rel = relations.get([...keys][0]);
      for (const col of aliasColumns(alias, texts)) rel.columns.add(col);
    }
    if (single) for (const col of bareColumns(texts, known ? new Set(known) : null)) single.columns.add(col);
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
  const re = new RegExp(`(?:Seq Scan|Index Scan(?: Backward)? using \\S+|Index Only Scan(?: Backward)? using \\S+|Bitmap Heap Scan|Tid Scan|Tid Range Scan|Sample Scan|Foreign Scan) on ${identifier}\\.${identifier}`, 'g');
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
