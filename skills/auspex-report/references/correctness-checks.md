# Report correctness checks

Run through this list before `save_report`. Every item that applies is
either handled in the SQL or named as an assumption in the report
description.

## Fan-out (1:N joins)

- Know each table's grain. A join from the parent to a child with
  `fanOut.maxPerParent > 1` multiplies parent rows and inflates every sum
  over parent columns.
- Pre-aggregate the child to the parent key in a CTE, then join 1:1:

```sql
WITH inv AS (
  SELECT i.order_id, sum(i.amount) AS invoice_amount, count(*) AS invoice_count
  FROM test.invoices i
  WHERE i.created_at >= $1 AND i.created_at < $2
  GROUP BY i.order_id
)
SELECT o.customer_id, sum(o.amount) AS order_amount, sum(inv.invoice_amount) AS invoice_amount
FROM example.orders o
LEFT JOIN inv ON inv.order_id = o.order_id
WHERE o.created_at >= $1 AND o.created_at < $2
GROUP BY o.customer_id;
```

- Two children of the same parent are never joined to each other directly
  (N x M rows): aggregate each to the parent key first.
- `count(DISTINCT parent_key)` for counts at the parent grain after a join.

## Duplicates

- Check that the driving key is unique at the report grain (primary key or
  a `count(*) vs count(DISTINCT key)` check in the plan's estimate or one
  aggregate query).
- Lookup joins must be on a unique key; a lookup with repeated codes
  (per language, per period) needs its extra key in the join.

## NULLs

- `LEFT JOIN` when the child may be missing; `coalesce(sum(x), 0)` only
  where 0 is the correct business reading, otherwise keep NULL and say so.
- `col <> 'X'` drops NULL rows: write `col IS DISTINCT FROM 'X'` when NULLs
  must stay.
- `NOT IN (subquery)` returns nothing when the subquery has a NULL: use
  `NOT EXISTS`.
- Group keys that can be NULL get a visible label (`coalesce(name, '(none)')`).

## Cancelled, deleted, test rows

- Apply the remembered rules (status codes, cancelled flags, soft-delete
  columns such as `is_deleted`, `is_active`, `deleted_at`).
- There is no default. When such a column is present and no rule exists,
  ask neutrally in the question round whether those rows count, and save the
  answer as a rule.

## Status codes

- Read the code list from its source (lookup table, enum type, CHECK
  constraint or column comment) with one small query.
- Similar words are not the same state (failed vs pending retry vs
  returned): propose the mapping, confirm it, then filter.
- Filter on codes, not names; names change.

## Numbers and dates

- `numeric` for money; no float sums. Integer division: cast first.
- Half-open date ranges; time zone named for `timestamptz`.
- Percentages computed from sums, not averaged per group.

## Performance

- `explain` before the first run; filter on indexed columns; window the
  period on the driving table.
- Expected run longer than the default timeout: tell the user the table,
  estimated rows and reason, and use `timeoutSeconds` only after a yes.
- `run_report` with `analyze="auto"` skips EXPLAIN ANALYZE after a slow
  run; ask before `analyze="always"`.
- An approved report with a newer draft at the same location: `run_report`
  runs the draft unless you pass `stage: "approved"` (and the `version` the
  user saw, for example from a request copied in the viewer).
