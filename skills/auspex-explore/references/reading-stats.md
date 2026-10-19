# Reading table statistics

Answer "why does this table exist" and "which columns matter" from figures
the tools already return. State each conclusion with its evidence and a
confidence; it stays an inference until the user confirms it.

## Table purpose signals

| Signal (source) | Reading |
|---|---|
| Comment on table (`describe_tables`) | stated purpose: fact |
| Many incoming foreign keys | master / reference table |
| Few columns, code + name, small row count | lookup (status, type, region) |
| Two foreign keys, few other columns | link table (N:M) |
| Date + amount + foreign keys, large row count | transaction / movement table |
| Same columns as another table plus date/user/op columns | log or history copy |
| Estimated rows 0 | empty when it was last vacuumed or analyzed |
| Estimated rows `null` | no estimate (never vacuumed or analyzed, or statistics not available on a standby or after a reset): measure with `profile_tables` before calling it empty |
| Write activity (inserts/updates/deletes since stats reset, when a tool returns it) | live vs frozen table |

## Column importance signals (`profile_tables`)

| Figure | Reading |
|---|---|
| fillRate 0 | unused column; good note candidate |
| fillRate 1 and distinctInSample = sampled rows | identifier or unique key candidate |
| fillRate 1, low distinct (2-20) | status / type / flag; find where its codes are defined (lookup table, enum, CHECK or comment) |
| Low fillRate (< 0.1) | optional or legacy field; check whether recent rows fill it |
| distinctInSample 1 | constant; ignore in reports |
| Column in an index or foreign key | used for access or joins |
| Column used in approved reports (memory, `used` relations) | known important |

Distinct counts come from a sample: "distinct in sample" is a lower bound,
not the table's distinct count. Say so when it matters.

## Fan-out (`profile_tables` with `parent`)

- `fanOut.avgPerParent` and `fanOut.maxPerParent`: max 1 means 1:1 in
  practice; max > 1 means a join multiplies parent rows.
- `parentsWithChildren` / `parentRows`: share of parents that have any child;
  low share means an inner join drops most parents. `parentRowsCapped` true:
  the figures cover only the first `sampleRows` parent keys.
- Use `window` on a parent date column for large parents; say which window.

## What to record

- Observation: fill rate 0, unexpected fan-out, near-empty twin tables, with
  the evidence SQL (or the tool and arguments) and aggregate figures.
- Inference: table purpose read from signals, with confidence (high /
  medium / low) in the text.
- Nothing about individual rows or people.
