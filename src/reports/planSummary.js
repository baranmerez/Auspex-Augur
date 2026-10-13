// Turns PostgreSQL `EXPLAIN (FORMAT JSON)` output into a compact summary for
// reports: per-node exclusive time/cost, misestimates, joins with their
// conditions, relations touched, buffer totals and warnings. Works with and
// without ANALYZE (without it, cost is used where time is missing).

const joinTypes = new Set(['Hash Join', 'Merge Join', 'Nested Loop']);
const bufferKeys = [
  ['sharedHit', 'Shared Hit Blocks'], ['sharedRead', 'Shared Read Blocks'],
  ['sharedDirtied', 'Shared Dirtied Blocks'], ['sharedWritten', 'Shared Written Blocks'],
  ['tempRead', 'Temp Read Blocks'], ['tempWritten', 'Temp Written Blocks'],
];
const bigScanRows = 100000;
const misestimateFactor = 10;
const misestimateMinRows = 1000;

const relationOf = node => (node['Relation Name'] ? `${node.Schema ? node.Schema + '.' : ''}${node['Relation Name']}` : null);
const totalTime = node => (node['Actual Total Time'] ?? 0) * (node['Actual Loops'] ?? 1);
const actualRows = node => (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1);

// Collects every node depth-first with its depth and children.
function walk(node, depth, out, parentId) {
  const id = out.length;
  const entry = { id, parentId, depth, node, children: [] };
  out.push(entry);
  for (const child of node.Plans || []) entry.children.push(walk(child, depth + 1, out, id));
  return id;
}

// Relations scanned somewhere below a node.
function relationsBelow(entries, id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const e = entries[stack.pop()];
    const rel = relationOf(e.node);
    if (rel) out.add(rel);
    stack.push(...e.children);
  }
  return [...out];
}

// Nested loops often carry their join key on the inner index scan.
function innerCondition(entries, id) {
  const stack = [...entries[id].children.slice(1)];
  while (stack.length) {
    const e = entries[stack.shift()];
    const cond = e.node['Index Cond'] || e.node['Recheck Cond'] || e.node.Filter;
    if (cond && /=/.test(cond)) return cond;
    stack.push(...e.children);
  }
  return null;
}

// `(w.region_id = r.id)` with aliases w/r -> column pairs on real relations.
function columnPairs(condition, aliasMap) {
  if (!condition) return [];
  const pairs = [];
  const re = /([A-Za-z_][\w$]*)\.("?[A-Za-z_][\w$]*"?)\s*=\s*([A-Za-z_][\w$]*)\.("?[A-Za-z_][\w$]*"?)/g;
  for (const m of condition.matchAll(re)) {
    const left = aliasMap.get(m[1]);
    const right = aliasMap.get(m[3]);
    if (left && right && left !== right) {
      pairs.push({ left: `${left}.${m[2].replace(/"/g, '')}`, right: `${right}.${m[4].replace(/"/g, '')}` });
    }
  }
  return pairs;
}

export function summarizePlan(explainJson) {
  const root = Array.isArray(explainJson) ? explainJson[0] : explainJson;
  if (!root || !root.Plan) throw new Error('Not an EXPLAIN (FORMAT JSON) result.');
  const analyzed = root.Plan['Actual Total Time'] !== undefined;
  const entries = [];
  walk(root.Plan, 0, entries, null);

  const aliasMap = new Map();
  for (const { node } of entries) {
    const rel = relationOf(node);
    if (rel) aliasMap.set(node.Alias || node['Relation Name'], rel);
  }

  const rootTotal = analyzed ? totalTime(root.Plan) : root.Plan['Total Cost'];
  const nodes = entries.map(e => {
    const n = e.node;
    const childSum = e.children.reduce((s, c) => s + (analyzed ? totalTime(entries[c].node) : entries[c].node['Total Cost'] ?? 0), 0);
    const own = Math.max(0, (analyzed ? totalTime(n) : n['Total Cost'] ?? 0) - childSum);
    const est = (n['Plan Rows'] ?? 0) * (analyzed ? (n['Actual Loops'] ?? 1) : 1);
    const act = analyzed ? actualRows(n) : null;
    let misestimate = null;
    let misDir = null;
    let misFactor = null;
    if (analyzed && Math.max(est, act) >= misestimateMinRows) {
      const ratio = Math.max(est, 1) / Math.max(act, 1);
      if (ratio >= misestimateFactor || 1 / ratio >= misestimateFactor) {
        misDir = ratio >= 1 ? 'over' : 'under';
        misFactor = Math.round(ratio >= 1 ? ratio : 1 / ratio);
        misestimate = `${misDir} ${misFactor}x`;
      }
    }
    const join = joinTypes.has(n['Node Type']);
    return {
      id: e.id,
      parentId: e.parentId,
      depth: e.depth,
      type: n['Node Type'],
      joinType: n['Join Type'] || null,
      relation: relationOf(n),
      alias: n.Alias || null,
      index: n['Index Name'] || null,
      parentRelationship: n['Parent Relationship'] || null,
      subplan: n['Subplan Name'] || n['CTE Name'] || null,
      condition: n['Hash Cond'] || n['Merge Cond'] || n['Join Filter'] || n['Index Cond'] || n['Recheck Cond'] || null,
      filter: n.Filter || null,
      rowsRemovedByFilter: n['Rows Removed by Filter'] ?? null,
      sort: n['Sort Key'] ? { key: n['Sort Key'], method: n['Sort Method'] || null, space: n['Sort Space Used'] ?? null, spaceType: n['Sort Space Type'] || null } : null,
      startupCost: n['Startup Cost'],
      totalCost: n['Total Cost'],
      estRows: est,
      actualRows: act,
      loops: n['Actual Loops'] ?? null,
      totalMs: analyzed ? totalTime(n) : null,
      ownMs: analyzed ? own : null,
      ownCost: analyzed ? null : own,
      share: rootTotal > 0 ? own / rootTotal : 0,
      misestimate,
      misDir,
      misFactor,
      workers: n['Workers Launched'] ?? n['Workers Planned'] ?? null,
      isJoin: join,
    };
  });

  const joins = entries.filter(e => joinTypes.has(e.node['Node Type'])).map(e => {
    const n = e.node;
    const condition = n['Hash Cond'] || n['Merge Cond'] || n['Join Filter'] || (n['Node Type'] === 'Nested Loop' ? innerCondition(entries, e.id) : null);
    return {
      nodeId: e.id,
      method: n['Node Type'],
      type: n['Join Type'] || 'Inner',
      condition,
      outer: e.children[0] !== undefined ? relationsBelow(entries, e.children[0]) : [],
      inner: e.children[1] !== undefined ? relationsBelow(entries, e.children[1]) : [],
      columnPairs: columnPairs(condition, aliasMap),
      rows: analyzed ? actualRows(n) : n['Plan Rows'],
      ms: analyzed ? totalTime(n) : null,
    };
  });

  const relMap = new Map();
  for (const n of nodes) {
    if (!n.relation) continue;
    const r = relMap.get(n.relation) || { relation: n.relation, aliases: new Set(), scans: new Set(), indexes: new Set(), estRows: 0, actualRows: 0, ms: 0 };
    if (n.alias) r.aliases.add(n.alias);
    r.scans.add(n.type);
    if (n.index) r.indexes.add(n.index);
    r.estRows += n.estRows || 0;
    r.actualRows += n.actualRows || 0;
    r.ms += n.ownMs || 0;
    relMap.set(n.relation, r);
  }
  const relations = [...relMap.values()].map(r => ({ ...r, aliases: [...r.aliases], scans: [...r.scans], indexes: [...r.indexes] }));

  const buffers = Object.fromEntries(bufferKeys.map(([k, src]) => [k, root.Plan[src] ?? null]));

  const warnings = [];
  for (const n of nodes) {
    const where = n.relation ? ` on ${n.relation}` : '';
    const rows = n.actualRows ?? n.estRows;
    if (n.type === 'Seq Scan' && rows >= bigScanRows) warnings.push({ nodeId: n.id, kind: 'seq-scan', data: { relation: n.relation, rows }, text: `Sequential scan of ${rows.toLocaleString('en-US')} rows${where}` });
    // Report only where a misestimate starts; parents inherit it from children.
    const childMisestimated = entries[n.id].children.some(c => nodes[c].misestimate);
    if (n.misestimate && !childMisestimated) {
      const hint = n.relation ? '; statistics may be stale, consider ANALYZE on the table' : '';
      warnings.push({ nodeId: n.id, kind: 'misestimate', data: { nodeType: n.type, relation: n.relation, dir: n.misDir, factor: n.misFactor, est: n.estRows, actual: n.actualRows }, text: `${n.type}${where}: row estimate ${n.misestimate} (estimated ${n.estRows.toLocaleString('en-US')}, actual ${n.actualRows.toLocaleString('en-US')})${hint}` });
    }
    if (n.sort && n.sort.spaceType === 'Disk') warnings.push({ nodeId: n.id, kind: 'disk-sort', data: { relation: n.relation, kb: n.sort.space }, text: `Sort spilled to disk (${n.sort.space} kB)${where}` });
    if (n.rowsRemovedByFilter && n.rowsRemovedByFilter >= 10000 && n.rowsRemovedByFilter > 10 * (n.actualRows || 0)) {
      warnings.push({ nodeId: n.id, kind: 'filter', data: { relation: n.relation, rows: n.rowsRemovedByFilter }, text: `Filter discarded ${n.rowsRemovedByFilter.toLocaleString('en-US')} rows${where}; an index on the filtered columns may help` });
    }
    if (n.type === 'Nested Loop' && (n.loops ?? 0) <= 1) {
      const inner = entries[n.id].children[1];
      if (inner !== undefined && (entries[inner].node['Actual Loops'] ?? 0) >= 10000 && entries[inner].node['Node Type'] === 'Seq Scan') {
        warnings.push({ nodeId: n.id, kind: 'nested-seq', data: { loops: entries[inner].node['Actual Loops'] }, text: `Nested loop runs a sequential scan ${entries[inner].node['Actual Loops'].toLocaleString('en-US')} times` });
      }
    }
  }
  if ((buffers.tempWritten ?? 0) > 0) warnings.push({ nodeId: 0, kind: 'temp', data: { blocks: buffers.tempWritten }, text: `Query wrote ${buffers.tempWritten.toLocaleString('en-US')} temp blocks` });

  return {
    analyzed,
    planningMs: root['Planning Time'] ?? null,
    executionMs: root['Execution Time'] ?? null,
    totalCost: root.Plan['Total Cost'],
    rows: analyzed ? actualRows(root.Plan) : root.Plan['Plan Rows'],
    buffers,
    settings: root.Settings || null,
    nodes,
    joins,
    relations,
    warnings,
  };
}

// Short text for the agent: what matters, without the full plan.
export function planDigest(summary, topN = 3) {
  const top = [...summary.nodes].sort((a, b) => b.share - a.share).slice(0, topN)
    .map(n => `${n.type}${n.relation ? ' ' + n.relation : ''} ${Math.round(n.share * 100)}%`);
  return {
    analyzed: summary.analyzed,
    planningMs: summary.planningMs,
    executionMs: summary.executionMs,
    totalCost: summary.totalCost,
    rows: summary.rows,
    hotspots: top,
    joins: summary.joins.map(j => `${j.method} (${j.type})${j.condition ? ' on ' + j.condition : ''}`),
    relations: summary.relations.map(r => `${r.relation} [${r.scans.join(', ')}]`),
    warnings: summary.warnings.map(w => w.text),
  };
}
