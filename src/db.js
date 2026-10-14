import fs from 'node:fs';
import crypto from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import pg from 'pg';
import { assertReadOnlyQuery, SqlGuardError } from './sqlGuard.js';
import { createAuditLog } from './auditLog.js';
import { runRoleCheck, RoleCheckError } from './roleCheck.js';

// Keep date/time values exactly as PostgreSQL prints them; converting a
// timestamp without time zone to a JS Date would shift it to local time.
for (const oid of [1082, 1083, 1114, 1184, 1266]) pg.types.setTypeParser(oid, value => value);

const cursorName = 'auspex_cursor';
const exportBatchSize = 1000;
const connectTimeoutMs = 10000;

export class ReadOnlyDatabase {
  // Every public operation is written to the audit log here, so database reads
  // are recorded whether they come from the MCP server or from a script.
  // source: 'mcp' for the server, 'script' (default) for direct library use.
  constructor(config, { audit, source = 'script' } = {}) {
    this.config = config;
    this.pools = new Map();
    this.auditFn = audit ?? (config.logDir ? createAuditLog(config.logDir) : () => {});
    this.source = source;
    this.roleChecks = new Map(); // profile -> result of the read-only role check
  }

  // Result of the role check for a profile in this process, or null when the
  // profile has not been used yet.
  roleCheck(name) {
    return this.roleChecks.get(name) ?? null;
  }

  // Runs the role check again (check_profile) and returns its result; a
  // blocked role is reported, not thrown.
  async checkProfile(profile) {
    const name = this.resolveProfile(profile);
    this.roleChecks.delete(name);
    try {
      await this.withReadOnly(name, async () => null);
    } catch (err) {
      if (!(err instanceof RoleCheckError)) throw err;
    }
    return { profile: name, ...this.roleChecks.get(name) };
  }

  // First use of a profile in this process: check that its role is read-only
  // with the open client, record the result in the audit log, and refuse the
  // call when the role could write.
  async ensureRoleChecked(client, name) {
    let result = this.roleChecks.get(name);
    if (!result) {
      result = { ...(await runRoleCheck(client)), checkedAt: new Date().toISOString() };
      this.roleChecks.set(name, result);
      this.auditFn({
        source: this.source, tool: 'role_check', profile: name, roleStatus: result.status,
        blocking: result.blocking.map(f => f.code), warnings: result.warnings.map(f => f.code),
      });
    }
    if (result.status === 'blocked') throw new RoleCheckError(name, result);
  }

  // Runs one operation and records it: tool, profile, request details,
  // duration, and row count / file or the error. Failures are logged too.
  // summarize(result) adds safe result fields (ids, versions), never content.
  async audited(tool, details, fn, summarize = null) {
    const started = Date.now();
    const entry = { source: this.source, tool, ...details };
    try {
      const result = await fn();
      this.auditFn({ ...entry, ms: Date.now() - started, rowCount: result?.rowCount, file: result?.file, ...(summarize ? summarize(result) : {}) });
      return result;
    } catch (err) {
      this.auditFn({ ...entry, ms: Date.now() - started, error: err.message });
      throw err;
    }
  }

  // There is deliberately no default profile: every call must name the
  // database, so a query can never land on a database nobody chose.
  resolveProfile(profile) {
    const known = [...this.config.profiles.keys()].join(', ') || '(none)';
    const name = (profile || '').trim().toLowerCase();
    if (!name) throw new Error(`A profile is required. Ask the user which database to use. Known profiles: ${known}.`);
    if (!this.config.profiles.has(name)) throw new Error(`Unknown profile "${name}". Known profiles: ${known}.`);
    return name;
  }

  pool(name) {
    let pool = this.pools.get(name);
    if (!pool) {
      pool = new pg.Pool({
        connectionString: this.config.profiles.get(name),
        max: 2,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: connectTimeoutMs,
        application_name: 'auspex',
      });
      pool.on('error', () => {}); // idle client errors surface on the next query
      this.pools.set(name, pool);
    }
    return pool;
  }

  // Statement timeout for one call: the configured default, or a per-call
  // value. Neither may exceed the profile's ceiling; a default above a lower
  // per-profile ceiling is clamped to that ceiling.
  timeoutMs(name, timeoutSeconds) {
    const ceiling = this.config.maxTimeoutByProfile?.get(name) ?? this.config.maxStatementTimeoutMs ?? this.config.statementTimeoutMs;
    if (timeoutSeconds === undefined || timeoutSeconds === null) return Math.min(this.config.statementTimeoutMs, ceiling);
    const ms = Math.round(Number(timeoutSeconds) * 1000);
    if (!Number.isFinite(ms) || ms < 1000) throw new Error('timeoutSeconds must be at least 1.');
    if (ms > ceiling) throw new Error(`timeoutSeconds ${timeoutSeconds} exceeds the ${ceiling / 1000} s limit for profile "${name}".`);
    return ms;
  }

  // Runs fn inside BEGIN READ ONLY ... ROLLBACK. Nothing is ever committed.
  async withReadOnly(profile, fn, timeoutSeconds) {
    const name = this.resolveProfile(profile);
    const timeoutMs = this.timeoutMs(name, timeoutSeconds);
    const known = this.roleChecks.get(name);
    if (known?.status === 'blocked') throw new RoleCheckError(name, known); // no connection needed
    let client;
    try {
      client = await this.pool(name).connect();
    } catch (err) {
      throw connectionError(err, name);
    }
    let broken = false;
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${timeoutMs * 2}`);
      await client.query("SET LOCAL lock_timeout = '5s'");
      await this.ensureRoleChecked(client, name);
      return await fn(client, name);
    } catch (err) {
      if (!err.code && !(err instanceof SqlGuardError)) broken = true;
      throw err;
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      client.release(broken);
    }
  }

  // Declares a cursor for an already guarded query. The extended protocol
  // rejects a second statement, and DECLARE only accepts SELECT/VALUES without
  // data-modifying CTEs, so this is a second layer behind sqlGuard.
  async declareCursor(client, query, params) {
    await client.query({ text: `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${query}`, values: params || [], queryMode: 'extended' });
  }

  // Runs generated SQL (identifiers checked against the catalog and quoted)
  // inside an open withReadOnly transaction: through the same guard as user
  // queries and with the extended protocol, which rejects a second statement.
  async guardedQuery(client, sql, params) {
    const text = assertReadOnlyQuery(sql);
    return client.query({ text, values: params || [], queryMode: 'extended' });
  }

  query(profile, sql, params, maxRows, timeoutSeconds) {
    return this.audited('query', { profile: profile ?? null, sql, params, maxRows, timeoutSeconds },
      () => this._query(profile, sql, params, maxRows, timeoutSeconds));
  }

  explain(profile, sql, params, analyze = false, timeoutSeconds) {
    return this.audited('explain', { profile: profile ?? null, sql, params, analyze, timeoutSeconds },
      () => this._explain(profile, sql, params, analyze, timeoutSeconds));
  }

  // mode 'raw' (default) writes values exactly; 'spreadsheet' neutralizes
  // text cells a spreadsheet would run as a formula (see spreadsheetSafe).
  exportCsv(profile, sql, params, fileName, delimiter, timeoutSeconds, mode = 'raw') {
    return this.audited('export_csv', { profile: profile ?? null, sql, params, fileName, timeoutSeconds, mode },
      () => this._exportCsv(profile, sql, params, fileName, delimiter, timeoutSeconds, mode),
      r => ({ bytes: r.bytes, stopReason: r.stopReason }));
  }

  runReport(profile, sql, options = {}) {
    return this.audited('run_report', { profile: profile ?? null, sql, params: options.params, analyze: options.analyze, report: options.label, timeoutSeconds: options.timeoutSeconds },
      () => this._runReport(profile, sql, options));
  }

  // One READ ONLY transaction, one snapshot: EXPLAIN (FORMAT JSON), with
  // ANALYZE when asked, then the first rows through a cursor. With analyze the
  // query runs twice (plan + preview), so callers decide when that is worth it.
  async _runReport(profile, sql, { params, analyze = true, previewRows = 50, timeoutSeconds } = {}) {
    const query = assertReadOnlyQuery(sql);
    const limit = Math.max(0, Math.min(previewRows, this.config.maxRows));
    const options = analyze ? 'ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON' : 'VERBOSE, SETTINGS, FORMAT JSON';
    return this.withReadOnly(profile, async (client, name) => {
      const t0 = performance.now();
      const ex = await client.query({ text: `EXPLAIN (${options}) ${query}`, values: params || [], queryMode: 'extended' });
      const explainMs = performance.now() - t0;
      const raw = ex.rows[0]['QUERY PLAN'];
      const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;

      // previewRows = 0: no cursor and no FETCH. Column names come from the
      // query wrapped in LIMIT 0, which plans it but produces no rows. The
      // newline keeps a trailing -- comment from swallowing the wrapper.
      const t1 = performance.now();
      let res;
      if (limit === 0) {
        res = await client.query({ text: `SELECT * FROM (${query}\n) auspex_columns LIMIT 0`, values: params || [], rowMode: 'array', queryMode: 'extended' });
      } else {
        await this.declareCursor(client, query, params);
        res = await client.query({ text: `FETCH ${limit + 1} FROM ${cursorName}`, rowMode: 'array' });
      }
      const previewMs = performance.now() - t1;
      const truncated = res.rows.length > limit;
      const rows = (truncated ? res.rows.slice(0, limit) : res.rows).map(row => row.map(v => this.formatCell(v)));

      const oids = [...new Set(res.fields.map(f => f.dataTypeID))];
      const types = new Map((await client.query('select oid::int as oid, format_type(oid, null) as name from pg_type where oid = any($1::oid[])', [oids])).rows.map(r => [r.oid, r.name]));
      const version = (await client.query("select current_setting('server_version') as v")).rows[0].v;
      return {
        profile: name,
        serverVersion: version,
        analyzed: analyze,
        plan,
        explainMs,
        previewMs,
        previewExecuted: limit > 0,
        columns: res.fields.map(f => ({ name: f.name, type: types.get(f.dataTypeID) || String(f.dataTypeID) })),
        rows,
        rowCount: rows.length,
        truncated,
      };
    }, timeoutSeconds);
  }

  async _query(profile, sql, params, maxRows, timeoutSeconds) {
    const limit = Math.min(maxRows || this.config.maxRows, this.config.maxRows);
    const query = assertReadOnlyQuery(sql);
    return this.withReadOnly(profile, async (client, name) => {
      await this.declareCursor(client, query, params);
      const res = await client.query({ text: `FETCH ${limit + 1} FROM ${cursorName}`, rowMode: 'array' });
      const truncated = res.rows.length > limit;
      const rows = (truncated ? res.rows.slice(0, limit) : res.rows).map(row => row.map(v => this.formatCell(v)));
      return { profile: name, columns: res.fields.map(f => f.name), rows, rowCount: rows.length, truncated };
    }, timeoutSeconds);
  }

  // analyze=true executes the guarded SELECT to report actual times, rows and
  // buffers. It still runs in the READ ONLY transaction under statement_timeout
  // and is rolled back like every other call.
  async _explain(profile, sql, params, analyze = false, timeoutSeconds) {
    const query = assertReadOnlyQuery(sql);
    const options = analyze ? 'ANALYZE, BUFFERS, VERBOSE, COSTS, FORMAT TEXT' : 'VERBOSE, COSTS, FORMAT TEXT';
    return this.withReadOnly(profile, async (client, name) => {
      const res = await client.query({ text: `EXPLAIN (${options}) ${query}`, values: params || [], queryMode: 'extended' });
      return { profile: name, analyzed: analyze, plan: res.rows.map(r => r['QUERY PLAN']).join('\n') };
    }, timeoutSeconds);
  }

  async _exportCsv(profile, sql, params, fileName, delimiter, timeoutSeconds, mode = 'raw') {
    if (mode !== 'raw' && mode !== 'spreadsheet') throw new Error('mode must be "raw" or "spreadsheet".');
    const query = assertReadOnlyQuery(sql);
    const target = this.exportPath(fileName);
    return this.withReadOnly(profile, async (client, name) => {
      await this.declareCursor(client, query, params);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 'wx' never touches an existing file; only a file this call created is
      // ever removed again.
      const out = this.openExportStream(target);
      let owned = false;
      out.once('open', () => { owned = true; });
      const closed = new Promise(resolve => out.once('close', resolve));
      // Listening from the start: a stream error is never an unhandled rejection.
      const failed = new Promise((_, reject) => out.once('error', reject));
      failed.catch(() => {});
      let bytes = 0;
      const write = chunk => {
        bytes += Buffer.byteLength(chunk);
        return out.write(chunk) ? null : Promise.race([once(out, 'drain'), failed]);
      };
      // Budget for the whole export, on top of the per-statement timeout: a
      // row cap, a size cap and a total time cap. Hitting one ends the file
      // cleanly at a row boundary; stopReason says which.
      const maxBytes = this.config.exportMaxBytes ?? Infinity;
      const deadline = Date.now() + (this.config.exportMaxMs ?? Infinity);
      let rowCount = 0;
      let columns = [];
      let textColumn = [];
      let stopReason = null;
      try {
        await write('﻿'); // BOM so Excel opens UTF-8 (Turkish characters) correctly
        for (;;) {
          const res = await Promise.race([client.query({ text: `FETCH ${exportBatchSize} FROM ${cursorName}`, rowMode: 'array' }), failed]);
          if (rowCount === 0) {
            columns = res.fields.map(f => f.name);
            textColumn = res.fields.map(f => mode === 'spreadsheet' && !nonTextTypes.has(f.dataTypeID));
            await write(columns.map(c => csvCell(c, delimiter)).join(delimiter) + '\r\n');
          }
          for (const row of res.rows) {
            if (rowCount >= this.config.exportMaxRows) { stopReason = 'rows'; break; }
            const line = row.map((v, i) => csvCell(textColumn[i] ? spreadsheetSafe(rawCell(v)) : rawCell(v), delimiter)).join(delimiter) + '\r\n';
            if (bytes + Buffer.byteLength(line) > maxBytes) { stopReason = 'bytes'; break; }
            await write(line);
            rowCount++;
          }
          if (stopReason || res.rows.length < exportBatchSize) break;
          if (Date.now() >= deadline) { stopReason = 'time'; break; }
        }
        out.end();
        await Promise.race([once(out, 'finish'), failed]);
      } catch (err) {
        out.destroy();
        await closed;
        if (owned) fs.rmSync(target, { force: true });
        throw err;
      }
      return { profile: name, file: target, columns, rowCount, bytes, truncated: stopReason !== null, stopReason };
    }, timeoutSeconds);
  }

  // Separate so tests can substitute a failing or slow stream.
  openExportStream(target) {
    return fs.createWriteStream(target, { encoding: 'utf8', flags: 'wx' });
  }

  // Timestamp plus a random part: two exports with the same name in the same
  // second get different files.
  exportPath(fileName) {
    const base = String(fileName || 'export').replace(/\.csv$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'export';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return path.join(this.config.exportDir, `${stamp}_${crypto.randomBytes(3).toString('hex')}_${base}.csv`);
  }

  formatCell(value) {
    const raw = rawCell(value);
    if (typeof raw === 'string' && raw.length > this.config.maxCellChars) {
      return `${raw.slice(0, this.config.maxCellChars)}… [${raw.length} chars]`;
    }
    return raw;
  }

  async close() {
    await Promise.all([...this.pools.values()].map(p => p.end()));
    this.pools.clear();
  }
}

function rawCell(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `<bytea ${value.length} bytes>`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

// Type OIDs whose values are never free text (numbers, dates, booleans,
// uuid...). They stay exact in spreadsheet mode, so a real negative number is
// not turned into text. Any other type, including unknown ones, counts as text.
const nonTextTypes = new Set([16, 20, 21, 23, 26, 700, 701, 790, 1082, 1083, 1114, 1184, 1186, 1266, 1700, 2950]);

// A cell starting with = + - @ or a tab/carriage return can run as a formula
// in Excel, LibreOffice or Google Sheets; a leading apostrophe makes it text.
export function spreadsheetSafe(value) {
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value, delimiter) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function connectionError(err, profile) {
  const network = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err.code)
    || /timeout/i.test(err.message);
  const hint = network ? ' The server is unreachable; if it is behind a VPN, check that the VPN is connected.' : '';
  return new Error(`Could not connect with profile "${profile}": ${err.message}.${hint}`);
}
