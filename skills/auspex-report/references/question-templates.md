# Question templates (one message, max 3)

Ask only for gaps. Every question carries a proposed default so the user can
answer with one word. Put the rules you will apply anyway above the
questions, so the user can object without being asked.

## Shape

```
Applying from memory: <rule 1>; <rule 2>.
1. Period and date column: <proposal, e.g. December 2025 on order date (siparis_tarihi)>. OK?
2. Known tables or codes: <proposal, e.g. damaged = codes 7, 8 from barkod_durum>. Correct, or do you know others?
3. Output: <columns>, grouped by <x>, sum of <z>. Anything to add or drop?
```

## Choosing the 3 questions

Priority when more than 3 gaps exist (ask the first three, assume and state
the rest):

1. Which date column defines the period (order, invoice, delivery date give
   different totals).
2. Codes or states whose meaning is not in memory or a lookup table.
3. Grain and grouping (one row per order, per line, per person).
4. Output columns and number formats.
5. Category and report name in the library.

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
