---
name: auspex-code
description: "Derive what the columns of a PostgreSQL table mean by reading the application source code that uses them (ORM mappings, computations, UI labels, permission flags, validation messages, enum names) with your own file tools, and save one sentence per column in the Auspex schema memory through remember as an inference with evidenceCode references (code root, relative path, line, symbol; never code text). The user confirms or rejects each meaning. No database queries are needed. Use when the user asks what columns mean, wants meanings from the application code, or names a code folder for a table."
---

# Auspex code meanings

Goal: for each target column, one sentence of meaning read from the source
code of the application that writes or shows it, saved with `remember` as
an inference with `evidenceCode` references, and confirmed only for the
meanings the user accepts. Auspex stores the references (code root name,
path relative to it, optional line and symbol), never code text, and it
never reads the code itself: you read it with your own file tools.

## Hard rules

1. **Profile named by the user** in this conversation; otherwise
   `list_profiles`, show the profiles and ask. Never guess, never reuse one
   from another conversation. There is no default.
2. **Code location from the user.** Take the folders from `codeRoots` in
   `list_profiles` and confirm with the user which root(s) hold the
   application that uses this database. If there is none, or the user names
   another folder, ask for the exact path and suggest adding it to
   `codeRoots` in `profiles.json` (or `AUSPEX_CODE_ROOT_<NAME>`):
   `evidenceCode` accepts only configured root names. Without a configured
   root, present the meanings in chat and save nothing with references.
   Never assume a stack, folder layout or naming convention.
3. **Read only.** Code files are read, never modified, copied or saved.
   Never paste code into a note, a reference `symbol` or a reply beyond the
   name of a class, property or method.
4. **Certain mapping or skip.** Use a column only when the mapping from code
   to `schema.table.column` is certain (step 3). When it is ambiguous, skip
   the column and say so.
5. **No invented business meaning.** The sentence says only what the code
   shows. Write "appears to" when the evidence is indirect (a label, a name,
   a single assignment). Never fill gaps from general domain knowledge.
6. **Confirm only after the user agreed.** Every meaning is saved as
   `kind=inference`; the viewer shows it as "from code" and unconfirmed.
   `action=confirm` only for meanings the user accepted in this
   conversation; archive rejected ones with the user's reason.
7. **No database queries.** Code reading needs no database. Use memory
   (`table_knowledge`) for the column list and scores; if a table is not in
   memory, ask before one `describe_tables` call and announce it.
8. **Real names stay local.** Notes live in the local schema memory
   (`~/.auspex/memory`) only. Never put real table, column or code names
   into anything shared outside the machine.

## Workflow

1. **Profile, tables, roots.** Profile check (rule 1). Ask which tables if
   the user did not say. Code root(s) check (rule 2).
2. **Targets from memory.** `table_knowledge` per table: columns,
   `columnScores` and notes. Prioritise columns with an effective score of
   4-5 and columns with cryptic names (abbreviations, codes, flags such as
   `status_code`). Skip columns that already have a
   confirmed note (kind `rule` or `observation`) on them; keep open
   inferences in mind and do not add duplicates.
3. **Find the mapping.** Search the code root for the table name and locate
   the ORM or data-access mapping, so class -> table and property -> column
   are certain: entity classes with table/column attributes or annotations,
   fluent configuration, mapping files, model definitions, or raw SQL with
   the column names. Naming conventions (snake_case <-> PascalCase) count
   only when the mapping layer applies them explicitly. Patterns per stack:
   [mapping-patterns.md](references/mapping-patterns.md).
4. **Look for meaning per column**, following the mapped property name:
   - computations or assignments (for example `amount = net + tax + shipping`);
   - UI labels, column headers and templates that show it;
   - permission or visibility flags that gate it;
   - validation messages and rules on it;
   - enum or constant names it is compared with or assigned from.
   Note each place as a reference: root name, path relative to the root
   (with `/`), line, and the symbol (class, property or method name).
5. **Write one sentence** per column in the `notesLanguage` from
   `list_profiles` (ask once if null), for example "Appears to be the order
   total: net amount plus tax and shipping (Order.Amount)". Pick the 1-5
   strongest references.
6. **Present in batches** of up to about ten columns: column, meaning,
   references as `root:path:line · symbol`. Ask which to accept, correct or
   reject.
7. **Save.**
   - For each meaning, `remember` `action=add`, `kind=inference`, schema,
     table, column, `text`, `evidenceCode: [{ root, path, line, symbol }]`
     (at most 5; `root` is a configured code root name, `path` relative,
     no absolute, drive, UNC or `..` paths). Save before the user answers
     only when they asked you to; otherwise save after their answer.
   - Accepted: `action=confirm` with `kind=observation` (or `rule` when the
     user restated it as a rule). A corrected meaning: archive the old note
     with the user's reason and add the corrected text, then confirm it.
   - Rejected: `action=archive` with the user's reason.
8. **Report.** Per table: meanings confirmed, left as inference, rejected
   and skipped (with why: ambiguous mapping, no use in code).

## Answer shape

Short: profile, code root(s) read, tables, columns with a confirmed meaning,
open inferences, skipped columns with the reason, statements used (0).
