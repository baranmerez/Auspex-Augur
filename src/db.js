import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { assertReadOnlyQuery, SqlGuardError } from './sqlGuard.js';
import { createAuditLog } from './auditLog.js';

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
  }

  // Runs one operation and records it: tool, profile, request details,
  // duration, and row count / file or the error. Failures are logged too.
  async audited(tool, details, fn) {
    const started = Date.now();
    const entry = { source: this.source, tool, ...details };
    try {
      const result = await fn();
      this.auditFn({ ...entry, ms: Date.now() - started, rowCount: result?.rowCount, file: result?.file });
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
  // value that may not exceed the profile's ceiling.
  timeoutMs(name, timeoutSeconds) {
    if (timeoutSeconds === undefined || timeoutSeconds === null) return this.config.statementTimeoutMs;
    const ceiling = this.config.maxTimeoutByProfile?.get(name) ?? this.config.maxStatementTimeoutMs ?? this.config.statementTimeoutMs;
    const ms = Math.round(Number(timeoutSeconds) * 1000);
    if (!Number.isFinite(ms) || ms < 1000) throw new Error('timeoutSeconds must be at least 1.');
    if (ms > ceiling) throw new Error(`timeoutSeconds ${timeoutSeconds} exceeds the ${ceiling / 1000} s limit for profile "${name}".`);
    return ms;
  }

  // Runs fn inside BEGIN READ ONLY ... ROLLBACK. Nothing is ever committed.
  async withReadOnly(profile, fn, timeoutSeconds) {
    const name = this.resolveProfile(profile);
    const timeoutMs = this.timeoutMs(name, timeoutSeconds);
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

  query(profile, sql, params, maxRows, timeoutSeconds) {
    return this.audited('query', { profile: profile ?? null, sql, params, maxRows, timeoutSeconds },
      () => this._query(profile, sql, params, maxRows, timeoutSeconds));
  }

  explain(profile, sql, params, analyze = false, timeoutSeconds) {
    return this.audited('explain', { profile: profile ?? null, sql, params, analyze, timeoutSeconds },
      () => this._explain(profile, sql, params, analyze, timeoutSeconds));
  }

  exportCsv(profile, sql, params, fileName, delimiter, timeoutSeconds) {
    return this.audited('export_csv', { profile: profile ?? null, sql, params, fileName, timeoutSeconds },
      () => this._exportCsv(profile, sql, params, fileName, delimiter, timeoutSeconds));
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

      const t1 = performance.now();
      await this.declareCursor(client, query, params);
      const res = await client.query({ text: `FETCH ${limit + 1} FROM ${cursorName}`, rowMode: 'array' });
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

  async _exportCsv(profile, sql, params, fileName, delimiter, timeoutSeconds) {
    const query = assertReadOnlyQuery(sql);
    const target = this.exportPath(fileName);
    return this.withReadOnly(profile, async (client, name) => {
      await this.declareCursor(client, query, params);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const out = fs.createWriteStream(target, { encoding: 'utf8', flags: 'wx' });
      const done = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
      let rowCount = 0;
      let columns = [];
      let truncated = false;
      try {
        out.write('﻿'); // BOM so Excel opens UTF-8 (Turkish characters) correctly
        for (;;) {
          const res = await client.query({ text: `FETCH ${exportBatchSize} FROM ${cursorName}`, rowMode: 'array' });
          if (rowCount === 0) {
            columns = res.fields.map(f => f.name);
            out.write(columns.map(c => csvCell(c, delimiter)).join(delimiter) + '\r\n');
          }
          for (const row of res.rows) {
            if (rowCount >= this.config.exportMaxRows) { truncated = true; break; }
            out.write(row.map(v => csvCell(rawCell(v), delimiter)).join(delimiter) + '\r\n');
            rowCount++;
          }
          if (truncated || res.rows.length < exportBatchSize) break;
        }
      } catch (err) {
        out.end();
        await done.catch(() => {});
        fs.rmSync(target, { force: true });
        throw err;
      }
      out.end();
      await done;
      return { profile: name, file: target, columns, rowCount, truncated };
    }, timeoutSeconds);
  }

  exportPath(fileName) {
    const base = String(fileName || 'export').replace(/\.csv$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'export';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return path.join(this.config.exportDir, `${stamp}_${base}.csv`);
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
