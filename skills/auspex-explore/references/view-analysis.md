# View rules and comparisons

Read for questions about what a view includes, excludes, calculates or
duplicates. Dependency lists locate sources; the definition explains behavior.

1. Read known tables' memory, then `describe_tables` with `detail: "full"`
   for the target views only. Check `viewDefinitionTruncated` and
   `viewDefinitionLength`; summary mode omits the definition. Do not claim a
   complete review of truncated text. If required, fetch only the missing
   definition segment with a bounded catalog SELECT through Auspex.
2. State each view's grain and full join keys, including tenant, period,
   language or version when present. Read `viewSources` and `usedByViews`
   to bound the dependency chain; follow only dependencies needed for the
   question and stop revisiting an already inspected relation.
3. Trace row-changing operations: INNER/LEFT joins, predicates in ON versus
   WHERE, soft-delete/status filters, UNION versus UNION ALL, GROUP BY,
   DISTINCT, window ranking, latest-row selection and NULL handling. Trace
   monetary calculations and date/time-zone conversions separately.
   Row exclusions do not determine the direction of a sum. Even finding a
   negative excluded amount is insufficient: other excluded positive amounts
   can outweigh it. With one output row per retained base row, the direction
   depends on the excluded rows' net amount, not individual signs. Unknown
   join multiplicity is another reason to leave the direction unmeasured.
   Describe possible effects conditionally; claim an observed increase or
   decrease only with supported sign/multiplicity constraints or exact scoped
   aggregates for the same population.
4. Inspect relevant `viewFunctions` with `describe_functions`; identify the
   actual overload, arguments and any truncated definition. A function name
   alone does not prove which overload or runtime branch is used. Read the
   function; do not call it to discover side effects. Dynamic SQL and
   unqualified names may leave dependencies unresolved; say so.
5. For a materialized view, distinguish stored results from its definition.
   `populated: true` does not prove freshness. Do not REFRESH it; report an
   unknown refresh time unless authorized evidence supplies one.

For a mismatch, construct an aggregate funnel using the same period,
parameters and business rules: base population, each exclusion, join matches
(zero / one / many), then final groups and totals. Count distinct driving keys
alongside joined rows. Separate mutually exclusive exclusions from overlaps
so the explanation does not double-count a missing row. Use bounded SELECTs
only when data measurement is authorized; an estimated plan is not a count.

Deliver a compact comparison: output grain, sources, rules, measures,
observed difference and evidence boundary (definition / sample / exact scoped
aggregate). Store scoped observations and unconfirmed explanations separately.
