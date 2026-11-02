# Writing a table profile (table_profile)

A table profile is a short prose description of one table that people read
on its viewer page. Write one only when the user asks.

1. **Scope and count.** One table on request. For several tables or "all
   known tables", state the count first (from memory, for example the
   explored tables of the schema) and wait for a yes; never start a batch on
   your own.
2. **Read memory only.** `table_profile action=get` (current text, owner,
   freshness and `freshnessReasons`, a pending proposal, `requiredTables`,
   inputs), then `table_knowledge` and `function_knowledge` for its trigger
   functions. Report SQL comes from the library (`list_reports` and the
   report files) when that tool group is available. If a fact the profile
   needs is missing (for example the table is not described or a lookup
   table is unknown), say what is missing and ask before any database call.
3. **Write five sections** in the `notesLanguage`, about one page in all:
   `purpose` (what it is for), `behavior` (what it does: triggers, statuses,
   life cycle), `usage` (where it is used: reports, views, functions, code),
   `dependencies` (what it depends on: required lookup and parent tables)
   and `caveats` (what to watch out for). State only what memory supports;
   mark an interpretation as such, never present an unconfirmed inference
   as fact, and leave out row values and personal data. Leave a section
   empty rather than guess.
4. **Sources per section.** Give every section the notes (`note` with the
   id), reports, triggers, functions, tables, views, columns, scores or code
   references it is based on, so each statement can be traced.
5. **Save** with `table_profile action=save`. If the result says
   `stored: "proposal"`, the current profile is the user's: tell the user a
   proposal is waiting in the viewer (Profile view, *Review the proposal*);
   never try to overwrite it another way. Required-table marks are the
   user's; suggest one in words if the evidence calls for it.
6. **Stale profiles.** When `freshness` is `stale`, rewrite only when the
   user asks; use `freshnessReasons` to tell what changed.
