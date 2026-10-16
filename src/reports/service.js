// Ties the library, the database and the template together. The agent writes
// SQL; everything else (plan summary, masking, history, HTML) happens here, so
// a report never costs tokens to render.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Library, normalizeRef, refLabel, sqlHash } from './library.js';
import { summarizePlan, planDigest } from './planSummary.js';
import { maskRows } from './mask.js';
import { ToolError } from '../errors.js';
import { relationsFromJsonPlan } from '../memory/planUsage.js';

export const autoAnalyzeLimitMs = 30000;
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template.html');
export const templateVersion = 2;

// Embeds the report JSON into the fixed template; the page reads it on load.
export function renderReport(meta) {
  const template = fs.readFileSync(templatePath, 'utf8');
  // Recompute the summary from the stored raw plan so older reports pick up
  // summary improvements (e.g. structured warnings) when re-rendered.
  if (meta.last?.plan) {
    try { meta = { ...meta, last: { ...meta.last, summary: summarizePlan(meta.last.plan) } }; } catch { /* keep stored summary */ }
  }
  const json = JSON.stringify({ templateVersion, generatedAt: new Date().toISOString(), report: meta })
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
  const title = String(meta.title || meta.name).replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
  return template.replace('__AUSPEX_TITLE__', () => title).replace('"__AUSPEX_DATA__"', () => json);
}

// Data for a shared copy, built from an allowlist instead of the stored
// metadata: title, description, category, the masked preview, plain figures
// and provenance (the result's SQL version number and run time). Never SQL, plan or plan expressions, parameters, warnings, history,
// profile, server or database/schema names. Values in preview rows stay as the
// masking left them; masking is by column name only.
export function shareableReport(meta) {
  const last = meta.last;
  const s = last?.summary;
  return {
    shareable: true, name: meta.name, title: meta.title || meta.name, description: meta.description || '',
    category: meta.category, status: meta.status, sqlVersions: [], runs: [],
    last: last ? {
      at: last.at,
      version: Number.isInteger(last.version) ? last.version : null,
      columns: (last.columns || []).map(c => ({ name: c.name, type: c.type })),
      preview: last.preview || [],
      maskedColumns: last.maskedColumns || [],
      previewTruncated: !!last.previewTruncated,
      previewMs: last.previewMs,
      previewExecuted: last.previewExecuted,
      summary: {
        analyzed: !!s?.analyzed, planningMs: s?.planningMs, executionMs: s?.executionMs,
        rows: s?.rows, totalCost: s?.totalCost, buffers: s?.buffers ?? {},
        nodes: [], joins: [], relations: [], warnings: [],
      },
    } : null,
  };
}

export class ReportService {
  // memory (optional): a SchemaMemory that learns relations and used columns
  // from each run's plan. scriptRoots: name -> { dir } from the configuration.
  constructor(db, libraryDir, memory = null, { scriptRoots = new Map() } = {}) {
    this.db = db;
    this.library = new Library(libraryDir);
    this.memory = memory;
    this.scriptRoots = scriptRoots;
  }

  // Join column pairs of approved reports on one database: the "used" level
  // of relations in the schema memory.
  approvedJoinPairs(profile) {
    // Only results produced by the approved SQL count; a stale last run from
    // an older revision teaches nothing.
    return this.library.list()
      .filter(i => i.stage === 'approved' && i.db === profile)
      .flatMap(i => {
        const meta = this.library.readMeta('approved', i);
        if (!meta?.last || meta.last.sqlHash !== this.library.activeHash('approved', i, meta)) return [];
        return meta.last.summary?.joins ?? [];
      })
      .flatMap(j => j.columnPairs ?? []);
  }

  learn(profile, plan, summary) {
    if (!this.memory) return {};
    try {
      return this.memory.recordSeen(profile, relationsFromJsonPlan(plan, summary.joins));
    } catch (err) {
      return { memoryError: err.message };
    }
  }

  ref(input) {
    const ref = normalizeRef(input);
    this.db.resolveProfile(ref.db); // the db segment must be a configured profile
    return ref;
  }

  // With root, folder and fileName the query is also written as a new file
  // into that script root (see Library.saveDraftUnlocked).
  save(input) {
    const ref = this.ref(input);
    const { target, rest } = this.scriptTarget(input);
    // SQL, metadata and HTML are written under one lock, so they always match.
    const saved = this.library.locked(() => {
      const s = this.library.saveDraft({ ...rest, ref, target });
      this.library.writeHtml('draft', ref, renderReport(this.library.readMeta('draft', ref)));
      return s;
    });
    return {
      report: refLabel(ref), stage: 'draft', version: saved.version, sqlFile: saved.paths.sql, htmlFile: saved.paths.html,
      ...(saved.externalFile ? { externalFile: saved.externalFile } : {}),
    };
  }

  async run(input, { analyze = 'auto', previewRows = 50, returnRows = 20, timeoutSeconds, params } = {}) {
    const ref = this.ref(input);
    const stage = this.library.locate(ref);
    const sql = this.library.readSql(stage, ref);
    const meta = this.library.readMeta(stage, ref);
    if (!meta) throw new ToolError('NOT_FOUND', `Report metadata missing for ${refLabel(ref)}; save the report first.`);

    let doAnalyze = analyze === true || analyze === 'always';
    let note = null;
    if (analyze === 'auto' || analyze === undefined) {
      const prev = meta.runs.filter(r => Number.isFinite(r.durationMs)).at(-1);
      doAnalyze = !prev || prev.durationMs <= autoAnalyzeLimitMs;
      if (!doAnalyze) {
        const preview = previewRows > 0 ? `; the query still ran once to fetch ${previewRows} preview rows` : '; nothing was executed (previewRows 0)';
        note = `Previous run took ${(prev.durationMs / 1000).toFixed(1)} s; skipped EXPLAIN ANALYZE (estimated plan only)${preview}. Ask the user before running with analyze="always".`;
      }
    }

    const result = await this.db.runReport(ref.db, sql, { params, analyze: doAnalyze, previewRows, timeoutSeconds, label: refLabel(ref) });
    const summary = summarizePlan(result.plan);
    const columns = result.columns;
    const masked = maskRows(columns.map(c => c.name), result.rows, { mask: meta.mask || [], unmask: meta.unmask || [] });
    const hash = sqlHash(sql);
    const version = meta.sqlVersions.find(v => v.hash === hash)?.version ?? null;
    const at = new Date().toISOString();
    const durationMs = summary.analyzed ? (summary.planningMs ?? 0) + (summary.executionMs ?? 0) : null;

    const run = {
      at, profile: result.profile, sqlHash: hash, version, analyzed: summary.analyzed,
      durationMs, planningMs: summary.planningMs, executionMs: summary.executionMs,
      explainMs: Math.round(result.explainMs), previewMs: Math.round(result.previewMs), previewExecuted: result.previewExecuted,
      totalCost: summary.totalCost, rows: summary.rows, buffers: summary.buffers,
      warnings: summary.warnings.map(w => w.text), params: params || null,
    };
    const last = {
      at, profile: result.profile, serverVersion: result.serverVersion, sqlHash: hash, version,
      summary, plan: result.plan, columns, preview: masked.rows, maskedColumns: masked.maskedColumns,
      previewTruncated: result.truncated, explainMs: run.explainMs, previewMs: run.previewMs, previewExecuted: result.previewExecuted,
    };
    // The run is appended to the metadata as it is now on disk (another
    // process may have saved meanwhile), and the HTML is rendered from that.
    this.library.locked(() => {
      const updated = this.library.appendRun(stage, ref, run, last);
      this.library.writeHtml(stage, ref, renderReport(updated));
    });
    const html = this.library.paths(stage, ref).html;
    const learned = this.learn(result.profile, result.plan, summary);

    return {
      report: refLabel(ref), stage, version, htmlFile: html, note,
      durationMs, explainMs: run.explainMs, previewMs: run.previewMs,
      ...planDigest(summary),
      columns: columns.map(c => `${c.name} ${c.type}`),
      maskedColumns: masked.maskedColumns,
      preview: masked.rows.slice(0, returnRows),
      previewTruncated: result.truncated || masked.rows.length > returnRows,
      ...learned,
    };
  }

  approve(input) {
    const ref = this.ref(input);
    const res = this.library.locked(() => {
      const r = this.library.approve(ref);
      this.library.writeHtml('approved', ref, renderReport(r.meta));
      return r;
    });
    // Its joins now count as "used" relations in the schema memory view.
    try { this.memory?.rebuildView(ref.db); } catch { /* the view is rebuilt on the next memory change */ }
    return { report: refLabel(ref), stage: 'approved', version: res.meta.approvedVersion, sqlFile: res.paths.sql, htmlFile: res.paths.html };
  }

  // Writes a shared copy of a report (see shareableReport) into dir as a new
  // file; the report itself is not changed. No database access.
  // Only results of the active SQL revision are shared; the snapshot is read
  // under the library lock so a concurrent save cannot change it midway.
  share(input, dir) {
    const ref = this.ref(input);
    const { stage, snapshot, version } = this.library.locked(() => {
      const stage = this.library.locate(ref);
      const meta = this.library.readMeta(stage, ref);
      if (!meta) throw new ToolError('NOT_FOUND', `Report metadata missing for ${refLabel(ref)}; save the report first.`);
      if (!meta.last) throw new ToolError('PRECONDITION_FAILED', `${refLabel(ref)} has not been run yet; run it before sharing.`);
      const active = this.library.activeHash(stage, ref, meta);
      if (meta.last.sqlHash !== active) {
        const current = meta.activeVersion ?? meta.sqlVersions?.find(v => v.hash === active)?.version ?? '?';
        throw new ToolError('PRECONDITION_FAILED', `The last results of ${refLabel(ref)} come from SQL v${meta.last.version ?? '?'}, not the current v${current}; run the current version with run_report first, then share.`);
      }
      return { stage, snapshot: shareableReport(meta), version: meta.last.version ?? null };
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `${stamp}_${crypto.randomBytes(3).toString('hex')}_${ref.name}.share.html`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, renderReport(snapshot), { encoding: 'utf8', flag: 'wx' });
    return { report: refLabel(ref), stage, file, version };
  }

  // Re-renders every report's HTML from its JSON (after a template update). No database access.
  renderAll() {
    return this.library.locked(() => {
      const out = [];
      for (const item of this.library.list().filter(i => i.stage !== 'execute')) {
        const meta = this.library.readMeta(item.stage, item);
        if (!meta) continue;
        this.library.writeHtml(item.stage, item, renderReport(meta));
        out.push(`${item.stage}:${refLabel(normalizeRef(item))}`);
      }
      return { rendered: out.length, reports: out };
    });
  }

  list(filter = {}) {
    return this.library.list().filter(i => (!filter.db || i.db === filter.db.toLowerCase()) && (!filter.stage || i.stage === filter.stage));
  }

  // Splits root, folder and fileName off a tool input: { target, rest }, where
  // target is null (library only) or a configured script root location.
  scriptTarget(input) {
    const { root, folder, fileName, ...rest } = input;
    if (root === undefined && folder === undefined && fileName === undefined) return { target: null, rest };
    if (!root || !folder || !fileName) throw new ToolError('INVALID_INPUT', 'root, folder and fileName go together: pass all three to write into a script root, or none for the library only.');
    const name = String(root).toLowerCase();
    const configured = this.scriptRoots.get(name);
    if (!configured) {
      const names = [...this.scriptRoots.keys()].join(', ') || 'none (add "scriptRoots" to profiles.json)';
      throw new ToolError('INVALID_INPUT', `Unknown script root "${root}". Configured: ${names}.`);
    }
    return { target: { root: name, dir: configured.dir, folder, fileName }, rest };
  }

  // With root, folder and fileName the script is also written into that
  // configured script root (see Library.saveExecuteScriptUnlocked).
  saveExecute(input) {
    const ref = this.ref(input);
    const { target, rest } = this.scriptTarget(input);
    return this.library.saveExecuteScript({ ...rest, ref, target });
  }
}
