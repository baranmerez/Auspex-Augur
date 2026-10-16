# Question templates (one message, max 3)

Ask only for gaps. Every question carries a proposed default so the user can
answer with one word, except whether cancelled or deleted rows count: ask
that neutrally, without a default, and save the answer as a rule. Put the
rules you will apply anyway above the questions, so the user can object
without being asked.

## Shape

```
Applying from memory: <rule 1>; <rule 2>.
1. Period and date column: <proposal, e.g. December 2025 on order date (created_at)>. OK?
2. Known tables or codes: <proposal, e.g. failed = status_code 7, 8 from example.status_codes>. Correct, or do you know others?
3. Output: <columns>, grouped by <x>, sum of <z>. Anything to add or drop?
```

## Choosing the 3 questions

Priority when more than 3 gaps exist (ask the first three, assume and state
the rest):

1. Which date column defines the period (order, invoice, delivery date give
   different totals).
2. Whether cancelled or deleted rows count, when a state or soft-delete
   column exists and no rule is remembered (neutral, no default; it cannot
   be assumed, so it is never pushed out of the 3).
3. Codes or states whose meaning is not in memory or in their source
   (lookup table, enum type, CHECK constraint or column comment).
4. Grain and grouping (one row per order, per line, per person).
5. Output columns and number formats.
6. Category and report name in the library.

## Do not ask

- Rules already in `databaseNotes` or table notes: apply and list them.
- Anything the request states.
- Column meanings the catalog comments state.
- The profile when the user named it in this conversation.

## Period conventions

- Half-open ranges: `col >= '2025-12-01' AND col < '2026-01-01'`; never
  `BETWEEN` on timestamps.
- Name the time zone when the column is `timestamptz`.
- "December" without a year: propose the most recent December and say so.
