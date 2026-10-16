---
name: auspex-explore
description: "Discover and explain a PostgreSQL database through the read-only Auspex MCP server: find tables, read structure and relations, measure fill rates and fan-out, and record findings in the schema memory with few queries. Use when the user wants to explore a database, find where data lives, understand why a table exists or which columns matter. TR: tablo keşfi, veritabanı keşfi, tablo ne işe yarıyor, hangi kolonlar önemli, ilişkiler, Auspex."
---

# Auspex explore

Goal: answer "where is it, what is it, how is it related" with the fewest
database statements, and leave the answer in the schema memory.

## Hard rules

1. **Profile named by the user.** Use only a profile the user named in this
   conversation. Otherwise call `list_profiles`, show them and ask. Never
   guess, never reuse one from another conversation; confirm before switching.
2. **Memory before the database.** Call `table_knowledge` for every table you
   already know by name before any database call. It costs no query and
   returns database-wide rules (`databaseNotes`): follow them, do not re-ask.
3. **Catalog first, data last.** `search` / `list_tables` to find candidates,
   then batch structure, then batch measurement. Never `count(*)` on a large
   table; use estimated rows.
4. **Batch, never loop.** `describe_tables` (up to 50) instead of
   `describe_table` in a loop; `profile_tables` (up to 30) instead of one
   measuring query per table; `relation_stats` for a center table's
   neighbors when the server offers it.
5. **Announce the cost.** Before each batch tell the user in one line how many
   statements it takes (the tool descriptions state it: `describe_tables` 5-6,
   `profile_tables` at most 3). The profile has a per-minute query budget
   (`maxQueriesPerMinute`); a refused call (`QUERY_BUDGET_EXCEEDED`) is not
   retried in a loop: wait `retryAfterSeconds` or tell the user.
6. **Never invent meaning.** Business meaning comes from comments, memory
   rules or the user. Your reading of the data is an inference until the user
   confirms it.
7. **No row values in notes or answers** about personal data: counts, rates
   and column names only.

## Workflow

1. **Profile and memory.** Profile check (rule 1). `table_knowledge` on the
   tables the user named; read `databaseNotes`, table notes and
   `unexploredNeighbors`.
2. **Candidates.** `search` with the business word and its likely table-name
   forms (Turkish and English, singular and plural). Filter the list in the
   catalog before describing anything; see
   [candidate-filtering.md](references/candidate-filtering.md). Skip
   backup, temp and log copies (`*_upd*`, `*_bak*`, `*_old*`, `tmp_*`,
   `temp_*`, `*_log_*`, dated suffixes) unless the user asks for them.
3. **Structure.** One `describe_tables` call for all remaining candidates.
   Report `changesSinceLast` to the user when present.
4. **Relations.** For the center table: `relation_stats` when available
   (tables it references, tables that reference it, ranked by estimated
   linked rows). Otherwise read foreign keys and incoming foreign keys from
   `describe_tables` and treat same-named id columns as suggested relations.
   A code or status column without a foreign key (for example
   `sorunluteslimdurumkodu`): split its name into word parts (`sorunlu`,
   `teslim`, `durum`, `kod`) and run ONE `search` with a %-joined pattern of
   the distinctive parts (`sorunlu%durum%kod`), plus variants with the
   table's family prefix (`vestel%durum`); confirm by reading the code list
   with one query. Example: `sorunluteslimdurumkodu` ->
   `import_vestel_sorunlu_urunler_durum_kodlari`. Only if that fails, try
   `search` with `searchSource` for function bodies that decode the code, and
   only then ask the user.
5. **Measurement.** One `profile_tables` call: fill rate and distinct count
   per column; with `parent`, fan-out of child tables over the center table.
   Narrow with `window` on a date column for large parents.
6. **Interpret.** Answer "why does this table exist" and "which columns
   matter" from the figures, without asking the user first; see
   [reading-stats.md](references/reading-stats.md). Label each conclusion as
   fact (catalog, comment, rule) or inference (with confidence).
7. **Record.** `remember` what was learned (see Recording below).
8. **Next.** Name `unexploredNeighbors` and ask whether to explore them;
   after a yes, structure only (`describe_tables`).

## Grain and fan-out (1:N tables)

Before any join or sum across a parent and a child:

- State the grain of each table (one row per what).
- Check fan-out with `profile_tables` (`parent`): `fanOut.avgPerParent` and
  `fanOut.maxPerParent`. Maximum > 1 means a join multiplies parent rows.
- Pre-aggregate the child to the parent key before joining, or count
  `distinct` parent keys. Record the fan-out as an observation.

## Recording (remember)

| What | kind | Needs |
|---|---|---|
| Rule the user stated ("order reports exclude cancelled rows") | `rule` | user's words |
| Finding from data (fill rate 0 %, fan-out max 12) | `observation` | `evidenceSql` + aggregate `evidenceFigures` |
| Your interpretation ("looks like an audit copy") | `inference` | confidence in the text |

Confirm an inference (`action=confirm`) only after the user agreed. Archive
outdated notes with a reason; never re-add a duplicate.

## Answer shape

Short: tables found (with estimated rows), purpose (fact or inference),
key columns, relations with fan-out, rules applied, notes saved, statements
used, open questions, next step.
