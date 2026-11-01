# Attributing column use in SQL

Read only when a statement is hard to attribute. Examples use invented names.

## Aliases and CTEs

```sql
with recent as (
  select o.order_id, o.customer_id, o.amount
  from example.orders o
  where o.created_at >= $1
)
select c.customer_id, sum(r.amount) as total
from recent r
join example.customers c on c.customer_id = r.customer_id
group by c.customer_id
order by total desc;
```

| Column | Table | Roles |
|---|---|---|
| `order_id` | `example.orders` | display (CTE select list, not used later: still counts once) |
| `customer_id` | `example.orders` | display, join (through `recent.customer_id`) |
| `amount` | `example.orders` | display, aggregate (through `recent.amount`) |
| `created_at` | `example.orders` | filter |
| `customer_id` | `example.customers` | join, display, sort/group |

Rules:

- Follow a CTE or subquery column back to the base table column it selects;
  the outer use adds its role to that base column.
- An expression (`coalesce(o.delivered_at, o.created_at)`) gives each column
  inside it the role of the place it appears in.
- `select *` or `o.*` counts as display for every column of that table.
- An unqualified column belongs to the only table in scope that has it (use
  the recorded structure from `table_knowledge`); skip it when two tables in
  scope have it.
- `count(*)` uses no column. `count(o.order_id)` is aggregate on `order_id`.
- `exists (select 1 from example.order_items i where i.order_id = o.order_id)`
  is join use on both `order_id` columns.

## Counting sources

- One report identity (db/schema/category/name) = one source across its
  stored versions/stages. For deployed usage choose approved SQL, otherwise
  the current draft; a draft-specific task uses its draft. A filename suffix
  such as `_v2` alone does not establish shared identity.
- One script file = one source. A file that holds several statements still
  counts once per column.
- Keep a small table while reading: column -> set of source names. `sources`
  is the size of that set.
- A scan hash is not that table. Reusing a file without reading it requires
  its attribution for the same content and target scope. A new session with
  only `scanned_files` cannot compute full scores from changed files alone.
- Remove deleted files' contributions when recomputing the complete corpus.
  Unreadable or ambiguous sources make coverage incomplete, not zero.

Example: one unchanged script reads `amount`, while a changed script now
reads only `status_code`. Reading only the changed file would incorrectly
erase the first script's contribution. Re-read both for a replacement score
unless the unchanged script's full attribution is available. The same file
may use two tables; a hash recorded while scoring one says nothing about
whether the other was scored.

## Score scale reminders

- Relative within the table: a table used in one report can still have
  columns scored 5 when that report revolves around them.
- Primary key columns joined in most sources: 5. Columns only displayed in a
  single report: 2. No use in the complete inspected corpus: 1. Unknown
  coverage: leave unscored or preserve the previous score with a warning.
- Do not raise a score for columns you believe matter but no SQL reads; say
  so in the summary for the user's review instead.
