# Candidate filtering (catalog only)

Filter candidate tables before any `describe_tables` or `profile_tables`
call. Everything here uses the output of `search` / `list_tables`, so it costs
no extra statement.

## Deprioritize by name, then check relevance

| Pattern | Usually |
|---|---|
| `*_upd*`, `*_update*`, `*_bak*`, `*_backup*`, `*_old*`, `*_copy*` | manual copies before a change |
| `tmp_*`, `temp_*`, `*_tmp`, `*_temp`, `test_*`, `*_test` | scratch tables |
| `*_log_*`, `*_log`, `*_logs`, `*_history`, `*_hist`, `*_audit` | audit or history copies of a live table |
| `*_YYYYMMDD`, `*_2024*`, `*_v2` next to an undated twin | dated snapshots |
| `x_*`, `del_*`, `deleted_*`, `old_*`, `backup_*` | retired tables (also try the same words in the languages the schema uses) |

Names are hints, not proof of retirement. Keep a history/log table for
lifecycle questions, when a relevant view reads it, when no live twin exists,
or when it is the only match. Do not drop an explicit target. State meaningful
exclusions so the user can correct the scope.

## Rank the rest

1. Exact business name over partial matches (`orders` over `order_notes`).
2. Larger estimated rows over near-empty twins (estimate `null` = never
   analyzed: unknown, not empty).
3. Tables with SELECT privilege; a table without it cannot be measured.
4. Comments that state a purpose.
5. Schema the user or memory named.

## Limits per batch

- `describe_tables`: up to 50 names, 7 statements (8 with a view).
- `profile_tables`: up to 30 names, at most 3 statements.
- Split a clearly requested module into bounded batches within its query
  budget. Ask to narrow only when the scope or cost is unclear; a tool's
  batch limit alone is not a reason to ask for the same authorization again.

## Search terms

Try the business word in the languages the schema may use, singular and
plural, and the common abbreviations of the codebase (for example `orders`,
`order`, `ord`; `invoices`, `invoice`, `inv`). Use `%` only when a plain
contains-match is too broad.
