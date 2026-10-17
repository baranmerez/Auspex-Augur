// Stable, machine-readable error codes for tool results and the audit log.
// A client decides what to do from code and retryable, never from the English
// message. The envelope carries no message text, SQL, parameters, row values
// or connection details: only the code, retry hints and the PostgreSQL
// SQLSTATE (a five-character class code, never data).
//
// Codes (README: Errors):
//   QUERY_BUDGET_EXCEEDED  per-process query budget used up; retryAfterSeconds
//   LOCK_BUSY              another Auspex process holds the library/memory lock
//   ROLE_REJECTED          the profile's role is not read-only
//   SQL_REJECTED           the SQL guard or the READ ONLY transaction refused the SQL
//   TIMEOUT                statement, lock or export time limit reached
//   INVALID_INPUT          invalid arguments or names
//   PROFILE_INVALID        missing or unknown profile
//   NOT_FOUND              report, note, table or column not found
//   PRECONDITION_FAILED    the operation needs an earlier step (save, run)
//   STALE_VERSION          the report changed since the version the caller reviewed
//   PERMISSION_DENIED      no privilege on the object
//   CONNECTION_FAILED      could not connect or authenticate, or the connection dropped
//   DISK_ERROR             a local file could not be written or read
//   DATABASE_ERROR         any other PostgreSQL error (see sqlState)
//   INTERNAL               anything else
export const errorCodes = [
  'QUERY_BUDGET_EXCEEDED', 'LOCK_BUSY', 'ROLE_REJECTED', 'SQL_REJECTED', 'TIMEOUT', 'INVALID_INPUT',
  'PROFILE_INVALID', 'NOT_FOUND', 'PRECONDITION_FAILED', 'STALE_VERSION', 'PERMISSION_DENIED', 'CONNECTION_FAILED',
  'DISK_ERROR', 'DATABASE_ERROR', 'INTERNAL',
];

// An error with an explicit code. errorCode, not code: pg and fs use code,
// and withReadOnly treats an error without code as a broken connection.
export class ToolError extends Error {
  constructor(errorCode, message, { retryable = false } = {}) {
    super(message);
    this.errorCode = errorCode;
    this.retryable = retryable;
  }
}

const diskCodes = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'EEXIST', 'EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'EISDIR', 'ENOTDIR']);
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN']);
// node-postgres raises these fixed messages without a code when the socket
// drops mid-query (pg/lib/client.js). Matched exactly and only for errors that
// carry no code, so a disk or PostgreSQL error is never reclassified.
const droppedConnectionMessages = new Set([
  'Connection terminated unexpectedly', 'Connection terminated',
  'Client has encountered a connection error and is not queryable',
]);
const isSqlState = code => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);

// PostgreSQL SQLSTATE -> code and retryability.
function fromSqlState(state) {
  if (state === '57014' || state === '25P03') return ['TIMEOUT', false]; // statement / idle-in-transaction timeout
  if (state === '55P03') return ['TIMEOUT', true]; // lock_timeout: another session holds the lock
  if (state === '25006') return ['SQL_REJECTED', false]; // read_only_sql_transaction
  if (state === '42501') return ['PERMISSION_DENIED', false];
  if (state.startsWith('28')) return ['CONNECTION_FAILED', false]; // authentication: retrying does not help
  if (state.startsWith('08') || ['57P01', '57P02', '57P03', '53300'].includes(state)) return ['CONNECTION_FAILED', true];
  if (state === '40001' || state === '40P01') return ['DATABASE_ERROR', true]; // serialization failure, deadlock
  return ['DATABASE_ERROR', false];
}

// Safe, machine-readable fields of any error thrown by a tool.
export function classifyError(err) {
  const out = { code: 'INTERNAL', retryable: false };
  if (err?.errorCode) {
    out.code = err.errorCode;
    out.retryable = err.retryable === true;
  } else if (err?.code === 'LOCK_BUSY') {
    Object.assign(out, { code: 'LOCK_BUSY', retryable: true });
  } else if (err?.code === 'ROLE_NOT_READ_ONLY') {
    out.code = 'ROLE_REJECTED';
  } else if (isSqlState(err?.code) && err.severity) {
    [out.code, out.retryable] = fromSqlState(err.code);
  } else if (networkCodes.has(err?.code)) {
    Object.assign(out, { code: 'CONNECTION_FAILED', retryable: true });
  } else if (err?.code === 'ENOENT') {
    out.code = 'NOT_FOUND';
  } else if (diskCodes.has(err?.code)) {
    out.code = 'DISK_ERROR';
  } else if (err instanceof Error && err.code === undefined && droppedConnectionMessages.has(err.message)) {
    Object.assign(out, { code: 'CONNECTION_FAILED', retryable: true });
  }
  if (Number.isFinite(err?.retryAfterSeconds)) out.retryAfterSeconds = err.retryAfterSeconds;
  if (err?.budgetScope) out.budgetScope = err.budgetScope;
  const state = err?.sqlState ?? (isSqlState(err?.code) && err.severity ? err.code : undefined);
  if (state) out.sqlState = state;
  return out;
}
