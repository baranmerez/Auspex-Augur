// Audit fields of a schema-memory side effect of a tool or scheduled run:
// what failed and the error code, with counts for a partial change. Never
// note text, file content or messages.

// repair (a committed change whose derived steps failed, see store.js).
export const repairAudit = repair => ({
  repair: Object.fromEntries(Object.entries(repair).filter(([k]) => k !== 'error')),
  ...(repair.error?.code ? { repairErrorCode: repair.error.code } : {}),
});

// A run result (run_report, a scheduled run) with memoryRepair, or a
// memory step that failed (memoryErrorCode, partialCommit).
export const memoryAudit = result => ({
  ...(result?.memoryRepair ? repairAudit(result.memoryRepair) : {}),
  ...(result?.memoryErrorCode ? { memoryErrorCode: result.memoryErrorCode } : {}),
  ...(result?.partialCommit ? { partialCommit: { written: result.partialCommit.written, total: result.partialCommit.total } } : {}),
});
