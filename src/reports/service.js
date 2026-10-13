// Ties the library, the database and the template together. The agent writes
// SQL; everything else (plan summary, masking, history, HTML) happens here, so
// a report never costs tokens to render.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library, normalizeRef, refLabel, sqlHash } from './library.js';
import { summarizePlan, planDigest } from './planSummary.js';
import { maskRows } from './mask.js';
import { relationsFromJsonPlan } from '../memory/planUsage.js';

export const autoAnalyzeLimitMs = 30000;
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template.html');
export const templateVersion = 1;

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

export class ReportService {
  // memory (optional): a SchemaMemory that learns relations and used columns
  // from each run's plan.
  constructor(db, libraryDir, memory = null) {
    this.db = db;
    this.library = new Library(libraryDir);
    this.memory = memory;
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

  save(input) {
    const ref = this.ref(input);
    const saved = this.library.saveDraft({ ...input, ref });
    const meta = this.library.readMeta('draft', ref);
    this.library.writeHtml('draft', ref, renderReport(meta));
    return { report: refLabel(ref), stage: 'draft', version: saved.version, sqlFile: saved.paths.sql, htmlFile: saved.paths.html };
  }

  async run(input, { analyze = 'auto', previewRows = 50, returnRows = 20, timeoutSeconds, params } = {}) {
    const ref = this.ref(input);
    const stage = this.library.locate(ref);
    const sql = this.library.readSql(stage, ref);
    const meta = this.library.readMeta(stage, ref);
    if (!meta) throw new Error(`Report metadata missing for ${refLabel(ref)}; save the report first.`);

    let doAnalyze = analyze === true || analyze === 'always';
    let note = null;
    if (analyze === 'auto' || analyze === undefined) {
      const prev = meta.runs.filter(r => Number.isFinite(r.durationMs)).at(-1);
      doAnalyze = !prev || prev.durationMs <= autoAnalyzeLimitMs;
      if (!doAnalyze) note = `Previous run took ${(prev.durationMs / 1000).toFixed(1)} s; ran plan only. Ask the user before running with analyze="always".`;
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
      explainMs: Math.round(result.explainMs), previewMs: Math.round(result.previewMs),
      totalCost: summary.totalCost, rows: summary.rows, buffers: summary.buffers,
      warnings: summary.warnings.map(w => w.text), params: params || null,
    };
    const last = {
      at, profile: result.profile, serverVersion: result.serverVersion, sqlHash: hash, version,
      summary, plan: result.plan, columns, preview: masked.rows, maskedColumns: masked.maskedColumns,
      previewTruncated: result.truncated, explainMs: run.explainMs, previewMs: run.previewMs,
    };
    const updated = this.library.appendRun(stage, ref, run, last);
    const html = this.library.paths(stage, ref).html;
    this.library.writeHtml(stage, ref, renderReport(updated));
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
    const res = this.library.approve(ref);
    this.library.writeHtml('approved', ref, renderReport(res.meta));
    // Its joins now count as "used" relations in the schema memory view.
    try { this.memory?.rebuildView(ref.db); } catch { /* the view is rebuilt on the next memory change */ }
    return { report: refLabel(ref), stage: 'approved', version: res.meta.approvedVersion, sqlFile: res.paths.sql, htmlFile: res.paths.html };
  }

  // Re-renders every report's HTML from its JSON (after a template update). No database access.
  renderAll() {
    const out = [];
    for (const item of this.library.list().filter(i => i.stage !== 'execute')) {
      const meta = this.library.readMeta(item.stage, item);
      if (!meta) continue;
      this.library.writeHtml(item.stage, item, renderReport(meta));
      out.push(`${item.stage}:${refLabel(normalizeRef(item))}`);
    }
    return { rendered: out.length, reports: out };
  }

  list(filter = {}) {
    return this.library.list().filter(i => (!filter.db || i.db === filter.db.toLowerCase()) && (!filter.stage || i.stage === filter.stage));
  }

  saveExecute(input) {
    const ref = this.ref(input);
    return this.library.saveExecuteScript({ ...input, ref });
  }
}
