# Candidate filtering (catalog only)

Filter candidate tables before any `describe_tables` or `profile_tables`
call. Everything here uses the output of `search` / `list_tables`, so it costs
no extra statement.

## Skip by default (name patterns)

| Pattern | Usually |
|---|---|
| `*_upd*`, `*_update*`, `*_bak*`, `*_backup*`, `*_old*`, `*_copy*` | manual copies before a change |
| `tmp_*`, `temp_*`, `*_tmp`, `*_temp`, `test_*`, `*_test` | scratch tables |
| `*_log_*`, `*_log`, `*_logs`, `*_history`, `*_hist`, `*_audit` | audit or history copies of a live table |
| `*_YYYYMMDD`, `*_2024*`, `*_v2` next to an undated twin | dated snapshots |
| `x_*`, `del_*`, `silinen_*`, `eski_*`, `yedek_*` | retired tables (Turkish: silinen = deleted, eski = old, yedek = backup) |

Keep a skipped table when the user asks for history or logs, when the live
twin does not exist, or when it is the only match. Name what you skipped in
one line so the user can ask for it.

## Rank the rest

1. Exact business name over partial matches (`orders` over `order_notes`).
2. Larger estimated rows over near-empty twins (estimate `null` = never
   analyzed: unknown, not empty).
3. Tables with SELECT privilege; a table without it cannot be measured.
4. Comments that state a purpose.
5. Schema the user or memory named.

## Limits per batch

- `describe_tables`: up to 50 names, 5 statements (6 with a view).
- `profile_tables`: up to 30 names, at most 3 statements.
- More candidates than that: ask the user to narrow (schema, module, date)
  instead of sending a second batch unprompted.

## Search terms

Try the business word in Turkish and English, singular and plural, and the
common abbreviations of the codebase (for example `orders`, `sip`, `order`;
`fatura`, `fat`, `invoice`). Use `%` only when a plain contains-match is too
broad.
