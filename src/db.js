import fs from 'node:fs';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import pg from 'pg';
import { assertReadOnlyQuery, SqlGuardError, maxSqlLength } from './sqlGuard.js';
import { createAuditLog } from './auditLog.js';
import { ensurePrivateDir } from './privateFiles.js';
import { runRoleCheck, RoleCheckError } from './roleCheck.js';
import { ToolError, classifyError } from './errors.js';

// Keep date/time values exactly as PostgreSQL prints them; converting a
// timestamp without time zone to a JS Date would shift it to local time.
for (const oid of [1082, 1083, 1114, 1184, 1266]) pg.types.setTypeParser(oid, value => value);

// Keep numeric array elements exact, like scalar numeric values, not JS floats.
pg.types.setTypeParser(1231, pg.types.getTypeParser(1009, 'text'));

// Array parsers do not use the scalar overrides above; keep their text too.
for (const oid of [1182, 1115, 1185]) pg.types.setTypeParser(oid, pg.types.getTypeParser(1009, 'text'));

const cursorName = 'auspex_cursor';
const exportBatchSize = 1000;
// How long past exportMaxMs an export waits for a cancelled FETCH to come back
// and, separately, for the file to close (docs/tools.md: CSV export budget).
const exportGraceMs = 2000;
const connectTimeoutMs = 10000;
const budgetWindowMs = 60000;
export const defaultMaxQueriesPerMinute = 60;

// Refusal of a database operation because the profile used up its query
// budget (AUSPEX_MAX_QUERIES_PER_MINUTE). Raised before connecting.
export class QueryBudgetError extends Error {
  constructor(profile, count, limit, waitMs) {
    const seconds = Math.max(1, Math.ceil(waitMs / 1000));
    super(`Query budget exhausted for profile "${profile}": ${count} database operations in the last minute, limit ${limit} per minute. `
      + `The next slot frees up in ${seconds} s. Do not retry in a loop: batch the work into fewer, set-based queries `
      + '(one query with a join, IN or = ANY($1) instead of one query per item).');
    this.name = 'QueryBudgetError';
    this.profile = profile;
    this.count = count;
    this.limit = limit;
    this.retryAfterMs = waitMs;
    this.errorCode = 'QUERY_BUDGET_EXCEEDED';
    this.retryable = true;
    this.retryAfterSeconds = seconds;
    this.budgetScope = 'process'; // per profile and Auspex process, not a database-wide limit
  }
}

// node-postgres fills every connection setting the URL leaves out from a PG*
// environment variable, and reads some that a URL cannot override at all:
// PGOPTIONS (session settings such as -c search_path), PGREPLICATION,
// PGCLIENT_ENCODING, PGBINARY and PGPASSWORD (a password outside pgpass).
// Auspex connects only to what the profile URL says, so these are removed
// from the process environment before a pool is created. PGPASSFILE (where
// pgpass lives) and the PGSSL* settings stay. Returns the names it removed.
export const ignoredLibpqEnv = ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
  'PGOPTIONS', 'PGREPLICATION', 'PGCLIENT_ENCODING', 'PGBINARY'];

export function clearLibpqEnv(env = process.env) {
  const removed = ignoredLibpqEnv.filter(name => env[name] !== undefined);
  for (const name of removed) delete env[name];
  return removed;
}

export class ReadOnlyDatabase {
  // Every public operation is written to the audit log here, so database reads
  // are recorded whether they come from the MCP server or from a script.
  // source: 'mcp' for the server, 'script' (default) for direct library use.
  // now: clock for the query budget (tests inject a fake one).
  constructor(config, { audit, source = 'script', now = Date.now } = {}) {
    this.config = config;
    this.pools = new Map();
    this.auditFn = audit ?? (config.logDir ? createAuditLog(config.logDir) : () => {});
    this.source = source;
    this.roleChecks = new Map(); // profile -> result of the read-only role check
    this.now = now;
    this.budgetUse = new Map(); // profile -> start times (ms) of operations in the window
    this.operation = new AsyncLocalStorage(); // profiles already charged by the current audited operation
    this.correlation = new AsyncLocalStorage(); // correlation ID of the current tool call
    this.auditScope = new AsyncLocalStorage(); // { tool, fields } of the innermost audited operation
    this.exportGraceMs = exportGraceMs; // tests shorten it
  }

  // Effective query budget of a profile: per-profile setting, else the global one.
  maxQueriesPerMinute(name) {
    return this.config.maxQueriesByProfile?.get(name) ?? this.config.maxQueriesPerMinute ?? defaultMaxQueriesPerMinute;
  }

  // Sliding one-minute window per profile and process. One audited operation
  // costs one unit however many statements or connections it uses; the
  // internal role check is part of the operation. Refuses before connecting.
  chargeQueryBudget(name) {
    const charged = this.operation.getStore();
    if (charged?.has(name)) return;
    const now = this.now();
    const limit = this.maxQueriesPerMinute(name);
    let used = this.budgetUse.get(name);
    if (!used) this.budgetUse.set(name, used = []);
    while (used.length && used[0] <= now - budgetWindowMs) used.shift();
    if (used.length >= limit) throw new QueryBudgetError(name, used.length, limit, used[used.length - limit] + budgetWindowMs - now);
    used.push(now);
    charged?.add(name);
  }

  // Runs fn as one tool call: every audit entry it writes carries this
  // correlation ID, so the call, its audit entries and its result are linked.
  withCorrelation(correlationId, fn) {
    return this.correlation.run(correlationId, fn);
  }

  // Audit field of the current tool call; none outside one (scripts).
  correlationField() {
    const correlationId = this.correlation.getStore();
    return correlationId ? { correlationId } : {};
  }

  // Result of the role check for a profile in this process, or null when the
  // profile has not been used yet.
  roleCheck(name) {
    return this.roleChecks.get(name) ?? null;
  }

  // Runs the role check again (check_profile) and returns its result; a
  // blocked role is reported, not thrown.
  checkProfile(profile) {
    return this.audited('check_profile', { profile: profile ?? null }, async () => {
      const name = this.resolveProfile(profile);
      this.roleChecks.delete(name);
      try {
        await this.withReadOnly(name, async () => null);
      } catch (err) {
        if (!(err instanceof RoleCheckError)) throw err;
      }
      return { profile: name, ...this.roleChecks.get(name) };
    }, result => ({ roleStatus: result.status }));
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
        source: this.source, tool: 'role_check', ...this.correlationField(), profile: name, roleStatus: result.status,
        blocking: result.blocking.map(f => f.code), warnings: result.warnings.map(f => f.code),
      });
    }
    if (result.status === 'blocked') throw new RoleCheckError(name, result);
  }

  // Runs one operation and records it: tool, profile, request details,
  // duration, and row count / file or the error. Failures are logged too.
  // summarize(result) adds safe result fields (ids, versions), never content.
  // A nested call shares the outer operation, so it is charged once.
  // Fields a nested auditedPhase adds land in this one entry (scope.fields).
  async audited(tool, details, fn, summarize = null) {
    const started = Date.now();
    const entry = { source: this.source, tool, ...this.correlationField(), ...boundedSql(details) };
    const scope = { tool, fields: {} };
    try {
      const store = this.operation.getStore() ?? new Set();
      const result = await this.operation.run(store, () => this.auditScope.run(scope, fn));
      this.auditFn({ ...entry, ms: Date.now() - started, rowCount: result?.rowCount, file: result?.file, ...scope.fields, ...(summarize ? summarize(result) : {}) });
      return result;
    } catch (err) {
      const { code: errorCode, sqlState } = classifyError(err);
      this.auditFn({ ...entry, ms: Date.now() - started, ...scope.fields, error: err.message, errorCode, ...(sqlState ? { sqlState } : {}) });
      throw err;
    }
  }

  // One phase of an operation that is audited as a whole further out (the
  // MCP run_report handler audits the full report run: checks, the database
  // part, saving the run and its HTML). Inside an audited operation of the
  // same tool, the phase writes no entry of its own: its details, its row
  // count and phases.<phase> = { ms, errorCode? } go into that operation's
  // one terminal entry, and the query budget is charged once for the whole
  // operation. Without such an operation (scheduler, scripts) it is audited
  // on its own as before.
  async auditedPhase(tool, phase, details, fn) {
    const scope = this.auditScope.getStore();
    if (scope?.tool !== tool) return this.audited(tool, details, fn);
    Object.assign(scope.fields, boundedSql(details));
    const started = Date.now();
    const record = extra => { scope.fields.phases = { ...scope.fields.phases, [phase]: { ms: Date.now() - started, ...extra } }; };
    try {
      const result = await fn();
      if (result?.rowCount !== undefined) scope.fields.rowCount = result.rowCount;
      record({});
      return result;
    } catch (err) {
      record({ errorCode: classifyError(err).code });
      throw err;
    }
  }

  // There is deliberately no default profile: every call must name the
  // database, so a query can never land on a database nobody chose.
  resolveProfile(profile) {
    const known = [...this.config.profiles.keys()].join(', ') || '(none)';
    const name = (profile || '').trim().toLowerCase();
    if (!name) throw new ToolError('PROFILE_INVALID', `A profile is required. Ask the user which database to use. Known profiles: ${known}.`);
    if (!this.config.profiles.has(name)) throw new ToolError('PROFILE_INVALID', `Unknown profile "${name}". Known profiles: ${known}.`);
    return name;
  }

  pool(name) {
    let pool = this.pools.get(name);
    if (!pool) {
      const removed = clearLibpqEnv();
      if (removed.length) process.stderr.write(`Auspex ignores ${removed.join(', ')} from the environment; the profile URL alone decides where it connects.\n`);
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
    if (!Number.isFinite(ms) || ms < 1000) throw new ToolError('INVALID_INPUT', 'timeoutSeconds must be at least 1.');
    if (ms > ceiling) throw new ToolError('INVALID_INPUT',`timeoutSeconds ${timeoutSeconds} exceeds the ${ceiling / 1000} s limit for profile "${name}".`);
    return ms;
  }

  // Runs fn inside BEGIN READ ONLY ... ROLLBACK. Nothing is ever committed.
  async withReadOnly(profile, fn, timeoutSeconds) {
    const name = this.resolveProfile(profile);
    const timeoutMs = this.timeoutMs(name, timeoutSeconds);
    const known = this.roleChecks.get(name);
    if (known?.status === 'blocked') throw new RoleCheckError(name, known); // no connection needed
    this.chargeQueryBudget(name);
    let client;
    try {
      client = await this.pool(name).connect();
    } catch (err) {
      throw connectionError(err, name);
    }
    let broken = false;
    // A socket drop while checked out is also emitted as an event on the client;
    // without a listener it would be an uncaught exception that ends the server.
    const onClientError = () => { broken = true; };
    client.on?.('error', onClientError); // test doubles may not be emitters
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${timeoutMs * 2}`);
      await client.query("SET LOCAL lock_timeout = '5s'");
      // Match sqlGuard's ordinary-string rules even on legacy server/role defaults.
      await client.query('SET LOCAL standard_conforming_strings = on');
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
      client.off?.('error', onClientError);
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
    const text = assertReadOnlyQuery(sql, { maxLength: Infinity });
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
    return this.auditedPhase('run_report', 'database', { profile: profile ?? null, sql, params: options.params, ...(options.preset ? { preset: options.preset } : {}), analyze: options.analyze, report: options.label, timeoutSeconds: options.timeoutSeconds },
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
    if (mode !== 'raw' && mode !== 'spreadsheet') throw new ToolError('INVALID_INPUT', 'mode must be "raw" or "spreadsheet".');
    const query = assertReadOnlyQuery(sql);
    const target = this.exportPath(fileName);
    return this.withReadOnly(profile, async (client, name) => {
      // Budget for the whole export, on top of the per-statement timeout: a
      // row cap, a size cap and a total time cap. Hitting one ends the file
      // cleanly at a row boundary; stopReason says which. The time budget
      // starts here, once the read-only transaction is open, and covers every
      // FETCH, every write (including waits for a slow disk) and closing the
      // file. See fetchBatch and finishing below for the cancellation grace.
      const maxBytes = this.config.exportMaxBytes ?? Infinity;
      const maxMs = this.config.exportMaxMs ?? Infinity;
      const deadline = Date.now() + maxMs;
      const statementMs = this.timeoutMs(name, timeoutSeconds);
      await this.declareCursor(client, query, params);
      ensurePrivateDir(path.dirname(target));
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
      // Resolves with timeUp when the budget ends while waiting for the disk.
      const write = chunk => {
        bytes += Buffer.byteLength(chunk);
        return out.write(chunk) ? null : Promise.race([once(out, 'drain'), failed, expiry.promise]);
      };
      // One FETCH within the budget. The server cancels it at the deadline:
      // its statement_timeout is lowered to the remaining time (never raised
      // above the call's own timeout), so the connection stays clean. If the
      // server does not answer within the grace after the deadline either,
      // the connection is dropped so it is never returned to the pool busy.
      const fetchBatch = async () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return timeUp;
        const capped = remaining < statementMs;
        const backstop = timer(remaining + this.exportGraceMs);
        const run = async () => {
          if (capped) await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.ceil(remaining))}`);
          return client.query({ text: `FETCH ${exportBatchSize} FROM ${cursorName}`, rowMode: 'array' });
        };
        try {
          const res = await Promise.race([run(), failed, backstop.promise]);
          if (res === timeUp) dropConnection(client);
          return res;
        } catch (err) {
          if (capped && err.code === '57014') return timeUp; // cancelled by the budget
          throw err;
        } finally {
          backstop.clear();
        }
      };
      let rowCount = 0;
      let columns = [];
      let textColumn = [];
      let started = false;
      let stopReason = null;
      const expiry = timer(deadline - Date.now());
      try {
        for (;;) {
          const res = await fetchBatch();
          if (res === timeUp) {
            if (!started) throw new ToolError('TIMEOUT', `Export stopped by the time limit (exportMaxMs ${maxMs} ms) before the first rows arrived; no file was kept.`);
            stopReason = 'time';
            break;
          }
          if (!started) {
            started = true;
            columns = res.fields.map(f => f.name);
            textColumn = res.fields.map(f => mode === 'spreadsheet' && !nonTextTypes.has(f.dataTypeID));
            // BOM so Excel opens UTF-8 (non-ASCII characters) correctly. Column
            // names are text too: spreadsheet mode neutralizes them like text cells.
            const head = '﻿' + columns.map(c => csvCell(mode === 'spreadsheet' ? spreadsheetSafe(c) : c, delimiter)).join(delimiter) + '\r\n';
            const headBytes = Buffer.byteLength(head);
            if (headBytes > maxBytes) throw new ToolError('INVALID_INPUT', `The CSV header alone is ${headBytes} bytes (with the byte order mark), more than exportMaxBytes ${maxBytes}; no file was kept. Select fewer or shorter column names.`);
            if (await write(head) === timeUp) { stopReason = 'time'; break; }
          }
          for (const row of res.rows) {
            if (rowCount >= this.config.exportMaxRows) { stopReason = 'rows'; break; }
            if (Date.now() >= deadline) { stopReason = 'time'; break; }
            const line = row.map((v, i) => csvCell(textColumn[i] ? spreadsheetSafe(rawCell(v)) : rawCell(v), delimiter)).join(delimiter) + '\r\n';
            if (bytes + Buffer.byteLength(line) > maxBytes) { stopReason = 'bytes'; break; }
            const drained = write(line);
            rowCount++; // the whole line is in the stream, so the file still ends at a row
            if (drained && await drained === timeUp) { stopReason = 'time'; break; }
          }
          if (stopReason || res.rows.length < exportBatchSize) break;
        }
        // Closing the file may take until the deadline plus the grace; after
        // that the export fails and the partial file is removed.
        // 'finish' means data was handed to the OS, not that the file handle
        // is closed. On Windows, callers may fail to open the path until 'close'.
        const finished = once(out, 'finish');
        out.end();
        const finishing = timer(Math.max(0, deadline - Date.now()) + this.exportGraceMs);
        try {
          if (await Promise.race([Promise.all([finished, closed]), failed, finishing.promise]) === timeUp) {
            throw new ToolError('TIMEOUT', `Export could not finish writing the file within the time limit (exportMaxMs ${maxMs} ms plus ${this.exportGraceMs} ms); no file was kept.`);
          }
        } finally {
          finishing.clear();
        }
      } catch (err) {
        out.destroy();
        await closed;
        if (owned) fs.rmSync(target, { force: true });
        throw err;
      } finally {
        expiry.clear();
      }
      return { profile: name, file: target, columns, rowCount, bytes, truncated: stopReason !== null, stopReason };
    }, timeoutSeconds);
  }

  // Separate so tests can substitute a failing or slow stream.
  openExportStream(target) {
    return fs.createWriteStream(target, { encoding: 'utf8', flags: 'wx', mode: 0o600 });
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

const timeUp = Symbol('timeUp');

// SQL over the guard's limit is always refused, so its audit entry keeps only
// the start and the length instead of the whole text.
function boundedSql(details) {
  if (typeof details?.sql !== 'string' || details.sql.length <= maxSqlLength) return details;
  return { ...details, sql: details.sql.slice(0, 2000), sqlLength: details.sql.length, sqlTruncated: true };
}

// Resolves with timeUp after ms (never when ms is not finite); clear() stops it.
function timer(ms) {
  let id;
  const promise = new Promise(resolve => { if (Number.isFinite(ms)) id = setTimeout(resolve, Math.max(0, ms), timeUp); });
  return { promise, clear: () => clearTimeout(id) };
}

// Drops the connection of a FETCH that did not come back in time: its pending
// query fails at once and withReadOnly then releases the client as broken, so
// the pool never hands out a busy connection. The server ends the backend
// when it notices, at the latest at its statement_timeout.
function dropConnection(client) {
  client.on?.('error', () => {}); // the expected "connection terminated" error must not crash the process
  client.connection?.stream?.destroy();
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
// src/viewer.html keeps an identical copy for its Operations CSV (the page is
// standalone, also in the desktop app); tests/csvSafety.test.js runs both
// over the same fixtures so they cannot drift.
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
  // An authentication failure (SQLSTATE 28xxx) is not retryable; a network
  // failure or a server that is starting up or full is.
  const cause = classifyError(err);
  const wrapped = new ToolError('CONNECTION_FAILED', `Could not connect with profile "${profile}": ${err.message}.${hint}`,
    { retryable: network || (cause.code === 'CONNECTION_FAILED' && cause.retryable) });
  if (cause.sqlState) wrapped.sqlState = cause.sqlState;
  return wrapped;
}
