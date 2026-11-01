# Recover without repeating completed work

Use after a repair warning, persistence failure or ambiguous transport error.
Do not assume every error means nothing was stored. Inspect the returned IDs,
stage, version and hash before choosing a retry.

| Evidence | Interpretation | Next action |
|---|---|---|
| `repair` on remember/score results, nested `memory.repair`, or `memoryRepair` | Canonical memory write completed; a secondary step failed | Keep the result/ID. Do not repeat the mutation or SQL. |
| `memoryErrorCode` and `partialCommit: { written, total }` | Database work stands; some memory records were written | Report the counts and memory gap; do not rerun to restore usage counters. |
| `repair.changelog: "failed"` | Changelog entry was not saved | Report incomplete history; a graph rebuild does not recreate it. |
| `repair.scannedFiles: "failed"` | Scores saved, scan bookkeeping failed | Read files again on the next scoring task; do not rescore solely for this warning. |
| `repair.sections: "omitted"` | Extra answer sections could not be read | Do not interpret omitted notes/neighbors as an empty set. |
| A call the client cancelled (`CANCELLED` in the audit; usually no reply) | The statement stopped; library or memory writes made before the cancel stay | Read back the exact report or record before running it again. |
| Error or lost response without commit evidence | Outcome unknown | Read back the exact record/report before retrying; ask for missing evidence if inaccessible. |

For stale memory, `table_knowledge` or a later authorized memory action can
heal the derived graph. A failing read is still a failing read; do not add a
dummy note, edit graph markers, delete locks or alter canonical JSON to force
repair. A graph's freshness does not prove the live database was rescanned.

Report files have separate boundaries: saving SQL, appending a saved run and
rendering HTML. In the current implementation an HTML error can follow a
stored run. Inspect `list_reports` and, if accessible, the exact report's local
metadata with file-reading tools. Do not treat an old HTML file or matching
SQL hash alone as evidence of the latest parameters, masking or execution.
`render_reports` rebuilds HTML from stored metadata without SQL, but covers
the whole library; use it only when that local write scope is authorized.
It does not rerun the report, repair scheduler state or recreate missing runs.

Scheduler results separate `status` (execution) from `persistence` (trend and
state). `status: "ok"` with persistence failure is an incomplete outcome,
not permission to run the report again. Reconciliation uses pending points,
existing trend points or tagged saved runs. Follow the scheduling workflow
rather than manually editing state/trend files.

Expose error codes and affected operations, not copied exception messages,
file contents, SQL, parameters or row values. A transport retry is safe only
when inspection establishes that the intended mutation did not commit and
the failure is transient; otherwise stop with the known outcome.
