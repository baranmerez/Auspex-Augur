# Resolve report decisions in small batches

Ask only for gaps, up to three questions at a time. Propose defaults for
presentation and naming; do not invent missing business semantics. Ask
neutrally whether cancelled/deleted rows count. Record the user's answer as
a rule with its actual scope: a one-off report choice is not automatically a
database-wide policy. Reuse explicit answers and applicable remembered rules.

## Shape

```
Applying from memory: <rule 1>; <rule 2>.
1. Period and date column: <proposal, e.g. December 2025 on order date (created_at)>. OK?
2. Known tables or codes: <proposal, e.g. failed = status_code 7, 8 from example.status_codes>. Correct, or do you know others?
3. Output: <columns>, grouped by <x>, sum of <z>. Anything to add or drop?
```

## Choosing the 3 questions

Resolve the most consequential gaps first. Continue a second short round if
an unresolved choice changes the population or totals; never assume grain or
state semantics just to stop at three questions. Presentation can use a
stated default.

1. Which date column defines the period (order, invoice, delivery date give
   different totals).
2. Whether cancelled or deleted rows count, when a state or soft-delete
   column exists and no rule is remembered (neutral, no default; it cannot
   be assumed).
3. Codes or states whose meaning is not in memory or in their source
   (lookup table, enum type, CHECK constraint or column comment).
4. Grain and grouping (one row per order, per line, per person).
5. Output columns and number formats.
6. Category (optionally topic/subtopic, e.g. `Orders/Delivery`) and report name in the library.

## Do not ask

- Applicable user rules already in memory: apply and list them. A conflict,
  stale observation or unconfirmed inference may still need clarification.
- Anything the request states.
- Column meanings the catalog comments state.
- The profile when the user named it in this conversation.

## Period conventions

- Half-open ranges: `col >= '2025-12-01' AND col < '2026-01-01'`; never
  `BETWEEN` on timestamps.
- Name the time zone when the column is `timestamptz`.
- "December" without a year: propose the most recent December and say so.
