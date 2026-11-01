# Report correctness checks

Run through this list before `save_report`. Every item that applies is
handled in SQL or explicitly unresolved. An assumption that changes totals
needs a business decision before the report is presented as correct.

## Fan-out (1:N joins)

- Know each table's grain. A join from the parent to a child with
  `fanOut.maxPerParent > 1` multiplies parent rows and inflates every sum
  over parent columns.
- Pre-aggregate the child to the parent key in a CTE, then join 1:1:

```sql
WITH inv AS (
  SELECT i.order_id, sum(i.amount) AS invoice_amount, count(*) AS invoice_count
  FROM example.invoices i
  WHERE i.created_at >= $1 AND i.created_at < $2
  GROUP BY i.order_id
)
SELECT o.customer_id, sum(o.amount) AS order_amount, sum(inv.invoice_amount) AS invoice_amount
FROM example.orders o
LEFT JOIN inv ON inv.order_id = o.order_id
WHERE o.created_at >= $1 AND o.created_at < $2
GROUP BY o.customer_id;
```

- For parent totals, aggregate each child to the full parent key first;
  two unaggregated children can produce N x M rows. A detail report may
  intentionally return child rows; document that grain.
- `count(DISTINCT parent_key)` for counts at the parent grain after a join.
  This repairs a count only; `sum(DISTINCT amount)` incorrectly merges
  different parents with equal amounts. Use EXISTS for presence-only filters.

## Duplicates

- Check the full driving key at the report grain using an applicable
  primary/unique constraint or a scoped aggregate comparing row and distinct
  key counts. Neither a plan estimate nor a capped sample proves uniqueness.
- Lookup joins must be on a unique key; a lookup with repeated codes
  (per language, per period) needs its extra key in the join.

## NULLs

- `LEFT JOIN` when the child may be missing; `coalesce(sum(x), 0)` only
  where 0 is the correct business reading, otherwise keep NULL and say so.
- `col <> 'X'` drops NULL rows: write `col IS DISTINCT FROM 'X'` when NULLs
  must stay.
- `NOT IN (subquery)` can exclude all candidate rows when its result includes
  NULL; use `NOT EXISTS` with explicit NULL semantics.
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
- For a report with `dateRange: true`, `$1` is the inclusive start and `$2`
  the exclusive end: `created_at >= $1 AND created_at < $2`. Keep literal
  positional SQL parameters in reference files: Claude expands the same
  notation as skill arguments inside a `SKILL.md` entrypoint.
- Ratios use the correct denominator and weighting, not an unweighted
  average of group percentages. State zero-denominator behavior.

## Reconciliation

- Compare at the same grain, full join keys, period, time zone and filters.
  A grouped report's row count is its group count, not the number of parents.
- Check additive measures with a separate bounded aggregate; use the proper
  formula for distinct counts and ratios. Sample statistics, estimated plan
  rows and a truncated preview cannot establish exact equality.
- Missing/overlapping classification rules: count distinct driving keys with
  zero, one and multiple rule matches. Keep overlaps separate from mutually
  exclusive exclusions; do not hide duplicate matches with DISTINCT.
- If no exact check ran, state what remains unverified.

## Performance

- `explain` before the first run; look for unintended multiplication and
  estimate errors. A sequential scan may be appropriate. Preserve the
  requested population; do not add filters just to force index use.
- Expected run longer than the default timeout: tell the user the table,
  estimated rows and reason, and use `timeoutSeconds` only after a yes.
- `run_report` with `analyze="auto"` skips EXPLAIN ANALYZE after a slow
  run; ask before `analyze="always"`.
- An approved report with a newer draft at the same location: `run_report`
  runs the draft unless you pass `stage: "approved"` (and the `version` the
  user saw, for example from a request copied in the viewer).
